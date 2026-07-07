/**
 * `fetchSource` — configurable, polite, replay-capturable single-page fetch.
 *
 * NEVER THROWS for an operational outcome: timeouts, retry exhaustion,
 * robots denial, HTTP errors, redirect loops and bad config all surface as a
 * typed `FetchError` on the returned `FetchResult` (mirroring `extract()`'s
 * discipline — see docs/adr/0001 §4, docs/adr/0002). Only a programmer error
 * outside the fetch contract could throw, and even that is caught and mapped to
 * a `network` error rather than propagated.
 *
 * All I/O and time seams are injectable (see `FetchSourceOptions`) so the whole
 * module is exercised in tests with no network and no real timers.
 */

import { createHash } from "node:crypto";
import type {
  FetchError,
  FetchLike,
  FetchLikeResponse,
  FetchResult,
  RenderResult,
  RobotsRules,
  Snapshot,
  SourceConfig,
  FetchSourceOptions,
} from "./types.js";
import {
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
  MAX_RETRIES,
} from "./types.js";
import { isPathAllowed, parseRobots } from "./robots.js";
import type { ContentType } from "../types.js";

/** Process-wide politeness ledger (per host), used when none is injected. */
const GLOBAL_POLITENESS = new Map<string, number>();
/** Process-wide robots cache (per origin), used when none is injected. */
const GLOBAL_ROBOTS = new Map<string, RobotsRules>();

/** sha256 hex of a string body — the byte-identity fingerprint on every snapshot. */
export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** sha256 hex of RAW bytes — the byte-identity fingerprint for a binary snapshot's bodyHash. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolve the Traverse `ContentType` for content-prep from an optional caller
 * hint and the response `Content-Type` header. The hint always wins; otherwise
 * `html`/`pdf` are detected from the header and everything else is `text`.
 */
export function resolveContentType(
  hint: ContentType | undefined,
  header: string | null,
): ContentType {
  if (hint) return hint;
  const h = (header ?? "").toLowerCase();
  if (h.includes("html")) return "html";
  if (h.includes("pdf")) return "pdf";
  return "text";
}

/**
 * Resolved `ContentType`s Traverse captures as RAW BYTES on
 * `Snapshot.bodyBytes` rather than decoded text — currently only `"pdf"`.
 * Add a new resolved type here (only) when a future binary format needs
 * bytes-safe capture; every call site keys off this one function. See
 * traverse#23.
 */
function isBinaryContentType(contentType: ContentType): boolean {
  return contentType === "pdf";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSchedule(ms: number, cb: () => void): () => void {
  const t = setTimeout(cb, ms);
  return () => clearTimeout(t);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Exponential backoff (ms) with full jitter: random in [0, base * 2^attempt]. */
function backoffMs(attempt: number, random: () => number): number {
  const base = 250;
  const ceil = base * 2 ** attempt;
  return Math.floor(random() * ceil);
}

interface Resolved {
  fetchImpl: FetchLike;
  now: () => number;
  clock: () => string;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  schedule: (ms: number, cb: () => void) => () => void;
  politeness: Map<string, number>;
  robotsCache: Map<string, RobotsRules>;
}

function resolveOptions(opts: FetchSourceOptions): Resolved {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return {
    fetchImpl,
    now: opts.now ?? Date.now,
    clock: opts.clock ?? (() => new Date().toISOString()),
    sleep: opts.sleep ?? defaultSleep,
    random: opts.random ?? Math.random,
    schedule: opts.schedule ?? defaultSchedule,
    politeness: opts.politenessState ?? GLOBAL_POLITENESS,
    robotsCache: opts.robotsCache ?? GLOBAL_ROBOTS,
  };
}

/** One HTTP GET with a timeout, mapped to a `FetchLikeResponse` or a typed error. */
async function timedGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  r: Resolved,
): Promise<{ response?: FetchLikeResponse; error?: FetchError }> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = r.schedule(timeoutMs, () => {
    timedOut = true;
    controller.abort();
  });
  try {
    const response = await r.fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    return { response };
  } catch (err) {
    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      return { error: { kind: "timeout", message: `request to ${url} timed out after ${timeoutMs}ms` } };
    }
    return { error: { kind: "network", message: err instanceof Error ? err.message : String(err) } };
  } finally {
    cancel();
  }
}

/** Fetch+parse robots.txt for `origin`, cached. Returns rules, or a fail-open note. */
async function loadRobots(
  origin: string,
  userAgent: string,
  timeoutMs: number,
  r: Resolved,
): Promise<{ rules: RobotsRules; warning?: string }> {
  const cached = r.robotsCache.get(origin);
  if (cached) return { rules: cached };

  const robotsUrl = `${origin}/robots.txt`;
  const { response, error } = await timedGet(
    robotsUrl,
    { "User-Agent": userAgent, Accept: "text/plain,*/*" },
    timeoutMs,
    r,
  );

  // Fail-OPEN on any robots retrieval problem (network/timeout/5xx) or a
  // not-found — a single-page fetcher should not hard-fail on robots infra
  // issues. This is a deliberate, documented choice (docs/adr/0002); a strict
  // fail-closed mode is a slice-3 candidate.
  if (error || !response) {
    const rules: RobotsRules = { rules: [] };
    r.robotsCache.set(origin, rules);
    return { rules, warning: `robots.txt for ${origin} unreachable (${error?.kind ?? "no response"}); proceeding (fail-open)` };
  }
  if (response.status >= 500 || response.status === 429) {
    const rules: RobotsRules = { rules: [] };
    r.robotsCache.set(origin, rules);
    return { rules, warning: `robots.txt for ${origin} returned ${response.status}; proceeding (fail-open)` };
  }
  if (response.status >= 400) {
    // 4xx (typically 404) => no restrictions.
    const rules: RobotsRules = { rules: [] };
    r.robotsCache.set(origin, rules);
    return { rules };
  }
  const body = await response.text();
  const rules = parseRobots(body, userAgent);
  r.robotsCache.set(origin, rules);
  return { rules };
}

/**
 * Fetch a single source, honoring config (politeness, timeout, retries, robots,
 * redirects) and returning a `FetchResult`. Never throws.
 */
export async function fetchSource(
  config: SourceConfig,
  opts: FetchSourceOptions = {},
): Promise<FetchResult> {
  const warnings: string[] = [];
  const r = resolveOptions(opts);

  // --- validate config ---
  if (!config || typeof config.id !== "string" || config.id.trim() === "") {
    return { error: { kind: "invalid-config", message: "SourceConfig.id is required" } };
  }
  let startUrl: URL;
  try {
    startUrl = new URL(config.url);
  } catch {
    return { error: { kind: "invalid-url", message: `SourceConfig.url is not a valid URL: ${String(config.url)}` } };
  }
  if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") {
    return { error: { kind: "invalid-url", message: `unsupported URL protocol: ${startUrl.protocol}` } };
  }

  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minDelayMs = config.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  const retries = Math.max(0, Math.min(config.retries ?? DEFAULT_RETRIES, MAX_RETRIES));
  const respectRobots = config.respectRobots ?? true;

  // Build headers from caller extras first, then force our honest identity so a
  // caller-supplied `User-Agent` can never override the bot identity/contact.
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,text/plain,*/*",
    ...(config.headers ?? {}),
  };
  headers["User-Agent"] = userAgent;

  // --- rendered fetch (opt-in seam, traverse#41) ---
  // A source opts in with `SourceConfig.render: true`; the caller must ALSO
  // configure `FetchSourceOptions.renderImpl` — the two-key gate mirrors
  // `revalidate` + `store` exactly, so `render: true` alone is a typed
  // `invalid-config` error, never a silent fall-through to a normal fetch.
  // See docs/decisions/rendered-fetch.md.
  if (config.render) {
    if (!opts.renderImpl) {
      return {
        error: {
          kind: "invalid-config",
          message: "SourceConfig.render is true but no FetchSourceOptions.renderImpl is configured",
        },
      };
    }
    const origin = startUrl.origin;

    // robots: checked ONCE against the requested URL, BEFORE renderImpl is
    // ever invoked. Narrower than the wire-fetch loop's per-hop check: a
    // rendered fetch has no manual redirect loop for traverse to hook
    // per-hop checks into — renderImpl owns all navigation internally, and
    // robots is NOT re-checked against any client-side redirect it follows
    // (accepted, documented scope limit).
    if (respectRobots) {
      const { rules, warning } = await loadRobots(origin, userAgent, timeoutMs, r);
      if (warning) warnings.push(warning);
      const pathForRobots = startUrl.pathname + startUrl.search;
      if (!isPathAllowed(rules, pathForRobots)) {
        return withWarnings(
          {
            error: {
              kind: "robots-denied",
              message: `robots.txt disallows ${userAgentToken(userAgent)} from ${startUrl.href}`,
            },
          },
          warnings,
        );
      }
    }

    // politeness: same per-host wait/stamp discipline as the wire-fetch loop.
    if (minDelayMs > 0) {
      const last = r.politeness.get(origin);
      if (last !== undefined) {
        const wait = minDelayMs - (r.now() - last);
        if (wait > 0) await r.sleep(wait);
      }
    }

    // HTTP validators are SKIPPED entirely for a rendered fetch — a renderer
    // has no real response headers to report, so `etag`/`lastModified` stay
    // unset and no conditional GET is ever sent. Surface the config mistake
    // explicitly rather than silently no-op'ing it.
    if (config.revalidate ?? false) {
      warnings.push(
        "revalidation has no effect for a rendered fetch (SourceConfig.render is true); no conditional GET is sent and no HTTP validators are captured",
      );
    }

    // Same discipline for headers/retries: `renderImpl` receives only
    // `{ userAgent, timeoutMs }` (see the `RenderImpl` signature), so a
    // caller-supplied `SourceConfig.headers` is never forwarded to it (the
    // renderer owns its own request headers/auth) and `SourceConfig.retries`
    // never wraps this call (a `renderImpl` failure is not retried). Warn
    // ONLY when the caller actually set something — never on the plain
    // `headers`/`retries` defaults this function itself would otherwise use,
    // so a render with neither configured gets no such warning.
    if (config.headers && Object.keys(config.headers).length > 0) {
      warnings.push(
        "headers are not forwarded to renderImpl for a rendered fetch (SourceConfig.render is true); the renderer implementation owns request headers/auth",
      );
    }
    if (config.retries !== undefined) {
      warnings.push(
        "retries do not apply to a rendered fetch (SourceConfig.render is true); renderImpl failures are not retried",
      );
    }

    let renderResult: RenderResult;
    try {
      renderResult = await opts.renderImpl(startUrl.href, { userAgent, timeoutMs });
    } catch (err) {
      if (minDelayMs > 0) r.politeness.set(origin, r.now());
      return withWarnings(
        {
          error: {
            kind: "adapter-error",
            message: `renderImpl failed for ${startUrl.href}: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
        warnings,
      );
    }
    if (minDelayMs > 0) r.politeness.set(origin, r.now());

    if (renderResult.warnings) {
      for (const w of renderResult.warnings) warnings.push(w);
    }

    const status = renderResult.status ?? 200;
    if (status < 200 || status >= 300) {
      return withWarnings(
        {
          error: {
            kind: "http-error",
            status,
            message: `render of ${startUrl.href} reported HTTP ${status}`,
          },
        },
        warnings,
      );
    }

    const body = renderResult.html;
    const snapshot: Snapshot = {
      sourceId: config.id,
      url: renderResult.finalUrl ?? startUrl.href,
      fetchedAt: r.clock(),
      status,
      contentType: "html",
      body,
      bodyHash: sha256Hex(body),
      rendered: true,
    };
    return withWarnings({ snapshot }, warnings);
  }

  // Conditional GET (opt-in). When `revalidate` is set and a prior snapshot for
  // this id carries HTTP validators, send them so an unchanged resource returns
  // a bodyless 304 (handled in the loop below). No store / no validators / no
  // opt-in => nothing added and behavior is byte-identical to before. The prior
  // snapshot is also what a 304 re-serves, so it is captured here for the loop.
  let prior: Snapshot | undefined;
  if ((config.revalidate ?? false) && opts.store) {
    // A custom store could reject; never-throws means we degrade to an
    // unconditional fetch (with a warning) rather than propagate.
    try {
      prior = await opts.store.latest(config.id);
    } catch (err) {
      warnings.push(`revalidate: prior-snapshot lookup failed (${err instanceof Error ? err.message : String(err)}); fetching unconditionally`);
      prior = undefined;
    }
    if (prior?.etag) headers["If-None-Match"] = prior.etag;
    if (prior?.lastModified) headers["If-Modified-Since"] = prior.lastModified;
  }

  // --- redirect loop (manual, bounded, robots-checked per hop) ---
  const redirects: string[] = [];
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const origin = currentUrl.origin;

    // robots: check the URL we are ABOUT to fetch, for our UA.
    if (respectRobots) {
      const { rules, warning } = await loadRobots(origin, userAgent, timeoutMs, r);
      if (warning) warnings.push(warning);
      const pathForRobots = currentUrl.pathname + currentUrl.search;
      if (!isPathAllowed(rules, pathForRobots)) {
        return withWarnings(
          { error: { kind: "robots-denied", message: `robots.txt disallows ${userAgentToken(userAgent)} from ${currentUrl.href}` } },
          warnings,
        );
      }
    }

    // politeness: wait out the per-host min-delay before starting this request.
    if (minDelayMs > 0) {
      const last = r.politeness.get(origin);
      if (last !== undefined) {
        const wait = minDelayMs - (r.now() - last);
        if (wait > 0) await r.sleep(wait);
      }
    }

    // request with bounded, jittered retries.
    const attempt = await requestWithRetries(currentUrl.href, headers, timeoutMs, retries, r, warnings);
    // stamp the host's "finished at" for politeness regardless of outcome.
    if (minDelayMs > 0) r.politeness.set(origin, r.now());

    if (attempt.error) return withWarnings({ error: attempt.error }, warnings);
    const response = attempt.response!;

    // 304 Not Modified: a conditional GET (If-None-Match / If-Modified-Since)
    // confirmed the resource is unchanged, so there is no body to read — re-serve
    // the byte-identical prior snapshot, flagged `notModified` (and `fromCache`).
    // Checked BEFORE the 3xx redirect branch below, since 304 falls in that
    // range but is emphatically not a redirect. Conditional headers are only ever
    // sent when a `prior` exists, so a 304 without one is a server-side surprise
    // rather than our doing — surface it as a typed http-error.
    if (response.status === 304) {
      if (!prior) {
        return withWarnings(
          {
            error: {
              kind: "http-error",
              status: 304,
              message: `unexpected 304 Not Modified from ${currentUrl.href} with no prior snapshot to revalidate`,
            },
          },
          warnings,
        );
      }
      return withWarnings({ snapshot: { ...prior, fromCache: true, notModified: true } }, warnings);
    }

    // redirects (3xx with a Location).
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return withWarnings(
          { error: { kind: "http-error", status: response.status, message: `redirect ${response.status} with no Location header from ${currentUrl.href}` } },
          warnings,
        );
      }
      if (hop === MAX_REDIRECTS) {
        return withWarnings(
          { error: { kind: "too-many-redirects", message: `exceeded ${MAX_REDIRECTS} redirects starting at ${startUrl.href}` } },
          warnings,
        );
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        return withWarnings(
          { error: { kind: "invalid-url", message: `redirect to invalid URL "${location}" from ${currentUrl.href}` } },
          warnings,
        );
      }
      redirects.push(currentUrl.href);
      currentUrl = next;
      continue;
    }

    // non-2xx, non-3xx => typed http-error.
    if (response.status < 200 || response.status >= 300) {
      return withWarnings(
        { error: { kind: "http-error", status: response.status, message: `HTTP ${response.status} from ${currentUrl.href}` } },
        warnings,
      );
    }

    // success: build the snapshot. Binary content-types (today: "pdf" only,
    // via isBinaryContentType) are captured as RAW BYTES on `bodyBytes` when
    // the response supports `arrayBuffer()` — the real global `fetch`
    // Response always does; a custom `fetchImpl` that omits it degrades to
    // the pre-existing lossy `text()` capture, flagged with a warning, rather
    // than silently corrupting the body (see traverse#23).
    const resolvedContentType = resolveContentType(config.contentType, response.headers.get("content-type"));
    let body = "";
    let bodyBytes: Uint8Array | undefined;
    let bodyHash: string;
    if (isBinaryContentType(resolvedContentType) && typeof response.arrayBuffer === "function") {
      let buf: ArrayBuffer;
      try {
        buf = await response.arrayBuffer();
      } catch (err) {
        return withWarnings(
          { error: { kind: "network", message: `failed to read body from ${currentUrl.href}: ${err instanceof Error ? err.message : String(err)}` } },
          warnings,
        );
      }
      bodyBytes = new Uint8Array(buf);
      bodyHash = sha256Bytes(bodyBytes);
    } else {
      if (isBinaryContentType(resolvedContentType)) {
        warnings.push(
          `fetchImpl has no arrayBuffer(); binary content-type "${resolvedContentType}" from ${currentUrl.href} captured as lossy text — pass a fetchImpl with arrayBuffer for binary sources`,
        );
      }
      try {
        body = await response.text();
      } catch (err) {
        return withWarnings(
          { error: { kind: "network", message: `failed to read body from ${currentUrl.href}: ${err instanceof Error ? err.message : String(err)}` } },
          warnings,
        );
      }
      bodyHash = sha256Hex(body);
    }
    const snapshot: Snapshot = {
      sourceId: config.id,
      url: currentUrl.href,
      fetchedAt: r.clock(),
      status: response.status,
      contentType: resolvedContentType,
      body,
      bodyHash,
    };
    if (bodyBytes) snapshot.bodyBytes = bodyBytes;
    if (redirects.length > 0) snapshot.redirects = redirects;
    // Capture HTTP validators (verbatim) so a later `revalidate` fetch can turn
    // an unchanged re-fetch into a cheap 304. Absent headers leave the fields
    // unset — the sha256 body-hash compare remains the drift signal in that case.
    const etag = response.headers.get("etag");
    if (etag) snapshot.etag = etag;
    const lastModified = response.headers.get("last-modified");
    if (lastModified) snapshot.lastModified = lastModified;
    return withWarnings({ snapshot }, warnings);
  }

  // Unreachable in practice (loop returns), but typed-safe:
  return withWarnings(
    { error: { kind: "too-many-redirects", message: `exceeded ${MAX_REDIRECTS} redirects starting at ${startUrl.href}` } },
    warnings,
  );
}

function userAgentToken(ua: string): string {
  return ua.split(/[\s/]+/)[0] ?? ua;
}

async function requestWithRetries(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  retries: number,
  r: Resolved,
  warnings: string[],
): Promise<{ response?: FetchLikeResponse; error?: FetchError }> {
  let last: { response?: FetchLikeResponse; error?: FetchError } = {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await r.sleep(backoffMs(attempt, r.random));
    }
    last = await timedGet(url, headers, timeoutMs, r);

    const retryable =
      (last.error && (last.error.kind === "timeout" || last.error.kind === "network")) ||
      (last.response !== undefined && isRetryableStatus(last.response.status));

    if (!retryable) return last;
    if (attempt < retries) {
      const reason = last.error ? last.error.kind : `HTTP ${last.response!.status}`;
      warnings.push(`retry ${attempt + 1}/${retries} for ${url} after ${reason}`);
    }
  }
  return last;
}

function withWarnings(result: FetchResult, warnings: string[]): FetchResult {
  if (warnings.length > 0) return { ...result, warnings };
  return result;
}
