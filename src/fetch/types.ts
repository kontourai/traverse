/**
 * Slice-2 fetch/snapshot contracts.
 *
 * This is the FETCH side of Traverse, delivered standalone-first: it provides
 * value on its own (configurable single-page fetching + snapshot capture for
 * replay) and only later composes with `extract()` via `fetchAndExtract`.
 *
 * Design discipline (mirrors the extraction side, see docs/adr/0001):
 *  - NEVER THROWS for an operational outcome. `fetchSource()` surfaces every
 *    timeout / retry-exhaustion / robots-denial / HTTP-error / bad-config as a
 *    typed `FetchError` on `FetchResult.error`, with `snapshot` absent — exactly
 *    the way `extract()` surfaces `ExtractionResult.error`. The one deliberate
 *    refinement over the extraction side is that this error is a STRUCTURED,
 *    discriminated `FetchError` (a `kind` + `message`), not a bare string, so a
 *    caller can branch on the failure class without string-matching. Justified
 *    in docs/adr/0002.
 *  - PROVENANCE CONTINUITY. A `Snapshot` carries enough identity (final URL,
 *    `fetchedAt`, `status`, `bodyHash`) that an extraction proposal produced
 *    from it can be traced back to the exact bytes it came from — see
 *    `buildSnapshotSourceRef` in ./compose.ts.
 *  - REPLAY-FIRST. A captured `Snapshot` replays byte-identically, so CI (and
 *    any offline run) never needs the network: `replaySource()` returns the same
 *    `FetchResult` shape as a live `fetchSource()` call, so downstream code is
 *    identical live vs. replay.
 *  - ZERO HEAVY DEPS. Uses global `fetch` (undici) and `node:crypto` only; no
 *    HTML parser here (content-prep already handles html->text on the extract
 *    side).
 */

import type { ContentType } from "../types.js";

/**
 * A caller-owned description of one fetchable source. Like `TargetFieldSchema`
 * on the extraction side, the domain semantics of `id`/`url` are the caller's;
 * Traverse only fetches what it is told to, politely and honestly.
 */
export interface SourceConfig {
  /** stable, caller-owned identity for this source — groups snapshots in the store. */
  id: string;
  /** absolute http(s) URL to fetch. */
  url: string;
  /**
   * Optional content-type HINT. When set, it wins over the response's
   * `Content-Type` header for deciding how content-prep treats the body
   * (html/text/pdf/png/jpeg). When absent, the header is used (defaulting to `text`).
   */
  contentType?: ContentType;
  /**
   * Per-HOST politeness: the minimum delay (ms) between the END of one request
   * to a host and the START of the next to that SAME host, within this process.
   * Default {@link DEFAULT_MIN_DELAY_MS}. Set 0 to disable.
   */
  minDelayMs?: number;
  /** per-request timeout (ms). Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Number of RETRIES (not counting the first attempt) on a retryable failure
   * (network error, timeout, HTTP 429, or HTTP 5xx). Bounded by
   * {@link MAX_RETRIES}; backoff is exponential with jitter. Default
   * {@link DEFAULT_RETRIES}.
   */
  retries?: number;
  /** extra request headers (merged over the defaults; `User-Agent` is set from `userAgent`). */
  headers?: Record<string, string>;
  /**
   * The `User-Agent` this fetcher identifies as. Defaults to
   * {@link DEFAULT_USER_AGENT}, which identifies HONESTLY as a bot and carries a
   * contact PLACEHOLDER — callers running against real sites should override it
   * with a real contact. The robots.txt group is matched against this UA's
   * leading product token.
   */
  userAgent?: string;
  /**
   * Whether to fetch and honor `/robots.txt` for {@link userAgent} before
   * fetching `url` (and before following any cross-URL redirect hop). Default
   * `true`. See docs/adr/0002 for the fail-open-on-robots-retrieval-error choice.
   */
  respectRobots?: boolean;
  /**
   * Opt in to a CONDITIONAL GET when a prior snapshot for this `id` (looked up
   * via {@link FetchSourceOptions.store}) carries HTTP validators for the exact
   * resource URL being requested. When `true`, `fetchSource` scopes that prior's
   * `etag` / `lastModified` to the matching request and sends `If-None-Match` /
   * `If-Modified-Since`. A `304 Not Modified` re-serves the prior snapshot marked
   * `fromCache` + `notModified` only when at least one validator from that exact
   * prior was sent. No validators from the stored prior are added to a
   * validator-free or nonmatching request; caller-supplied conditional headers
   * may remain on the initial hop. A `304` without prior validators sent is
   * never treated as `notModified`. A fresh `200` is captured with a new
   * `bodyHash` for the CALLER to compare with any prior. `fetchSource` does not
   * perform the prior-hash comparison.
   * Default `false` — behavior is byte-identical to before this option existed.
   * See docs/decisions/http-validators.md and kontourai/ops#75.
   */
  revalidate?: boolean;
  /**
   * Policy controlling use of the caller-supplied renderer. `never` performs
   * one plain fetch, `always` performs one rendered fetch, and
   * `on-shell-warning` performs a plain fetch followed by at most one rendered
   * attempt only when canonical content preparation reports the pure
   * `js-shell-suspected:` warning. Default `never`.
   */
  renderPolicy?: RenderPolicy;
  /**
   * Opt IN this source to a caller-supplied {@link FetchSourceOptions.renderImpl}
   * instead of a plain HTTP GET — e.g. an SPA/JS-rendered page whose real
   * content only exists after client-side JavaScript runs. Default `false`
   * (a plain fetch). Requires {@link FetchSourceOptions.renderImpl} to also be
   * configured; `render: true` with no `renderImpl` is a typed
   * `invalid-config` error, never a silent fall-through to a normal fetch.
   * `robots.txt` is still checked once against the requested URL before
   * `renderImpl` is invoked. {@link SourceConfig.revalidate} has no effect
   * when combined with this (an explicit warning is emitted) — a renderer has
   * no real HTTP response to conditionally re-request. {@link SourceConfig.headers}
   * and {@link SourceConfig.retries} ALSO have no effect on a rendered fetch —
   * `renderImpl` receives only `{ userAgent, timeoutMs }` (see {@link RenderImpl}),
   * so caller-supplied headers are never forwarded to it (the renderer owns its
   * own request headers/auth) and a `renderImpl` failure is never retried by
   * `fetchSource`. Both are surfaced as explicit `FetchResult.warnings` (not a
   * silent no-op) whenever the caller actually set one. See
   * docs/decisions/rendered-fetch.md.
   */
  /**
   * @deprecated Use {@link SourceConfig.renderPolicy}. For compatibility,
   * `true` maps to `always` and `false` maps to `never`. Supplying both forms
   * is valid only when they agree semantically.
   */
  render?: boolean;
}

/** The renderer orchestration policy for one source acquisition. */
export type RenderPolicy = "never" | "always" | "on-shell-warning";

/**
 * The immutable record of one successful fetch — the unit of replay. It is
 * JSON-serialisable by construction (that is what the store persists).
 */
export interface Snapshot {
  /** the originating {@link SourceConfig.id}. */
  sourceId: string;
  /** FINAL url after any redirects — the URL the `body` actually came from. */
  url: string;
  /** ISO-8601 instant the response was received. */
  fetchedAt: string;
  /** HTTP status of the final response. */
  status: number;
  /**
   * The RESOLVED Traverse content type (html/text/pdf/png/jpeg) — the value handed to
   * content-prep on replay/extraction, decided from {@link SourceConfig.contentType}
   * or the response `Content-Type` header at fetch time. Kept resolved (not the
   * raw header) so replay is deterministic and needs no re-parsing.
   */
  contentType: ContentType;
  /**
   * The response body, decoded as UTF-8 text — populated for every resolved
   * `contentType` EXCEPT one classified BINARY (see
   * `isBinaryContentType` in fetch-source.ts), where it is `""` and the raw
   * bytes live on {@link bodyBytes} instead. EXACTLY ONE of `body` /
   * `bodyBytes` is ever populated for a given snapshot.
   */
  body: string;
  /**
   * RAW response bytes, present ONLY for a resolved `contentType` classified
   * BINARY (see `isBinaryContentType` in
   * fetch-source.ts). EXACTLY ONE of `body` / `bodyBytes` is ever populated:
   * binary content sets `bodyBytes` and leaves `body` as `""`; text content
   * (`"html"`/`"text"`/`"transcript"`) sets `body` and leaves `bodyBytes`
   * unset. `bodyBytes` PRESENCE is the binary marker — there is no separate
   * `isBinary` flag. See traverse#23.
   */
  bodyBytes?: Uint8Array;
  /**
   * Lowercase hex SHA-256 — the byte-identity fingerprint. Hash DOMAIN
   * depends on which of `body`/`bodyBytes` is populated: sha256 of the RAW
   * bytes (`sha256Bytes` in fetch-source.ts) for a binary snapshot
   * (`bodyBytes` populated), sha256 of utf8-`body` (`sha256Hex`) otherwise —
   * byte-identical to pre-#23 behavior for every text snapshot.
   */
  bodyHash: string;
  /** the redirect chain that led here, if any: the ordered list of URLs visited BEFORE `url`. */
  redirects?: string[];
  /** true when this snapshot was served from a store (replay) rather than the network. */
  fromCache?: boolean;
  /**
   * The response `ETag` validator, verbatim (weak `W/"..."` prefix preserved),
   * when the server sent one. Stored so a later {@link SourceConfig.revalidate}
   * fetch can send it back as `If-None-Match` for a cheap conditional GET.
   */
  etag?: string;
  /**
   * The response `Last-Modified` validator, verbatim (an HTTP-date string), when
   * the server sent one. Sent back as `If-Modified-Since` on a later
   * {@link SourceConfig.revalidate} fetch.
   */
  lastModified?: string;
  /**
   * True ONLY on the snapshot returned when a {@link SourceConfig.revalidate}
   * conditional GET produced a `304 Not Modified` — i.e. this is the byte-
   * identical PRIOR snapshot, re-served without a body transfer because the
   * resource was unchanged. It is also `fromCache: true`. A normal live `200`
   * (even one that captured validators) never sets this. Lets a caller record a
   * cheap "checked, still current" freshness event without a hash compare.
   */
  notModified?: boolean;
  /**
   * `true` ONLY when this snapshot's `body` came from a caller-supplied
   * {@link FetchSourceOptions.renderImpl} rather than traverse's own HTTP GET.
   * PRESENCE (never explicit `false`) is the marker — same convention as
   * {@link Snapshot.bodyBytes} marking binary content and
   * {@link Snapshot.notModified} marking a 304. `contentType` is always
   * `"html"` and `bodyHash` uses the same text (`sha256Hex`) domain as every
   * other non-binary snapshot when this is set. See
   * docs/decisions/rendered-fetch.md.
   */
  rendered?: boolean;
}

/** The discriminant classes of a non-throwing fetch failure. */
export type FetchErrorKind =
  | "invalid-config"
  | "invalid-url"
  | "robots-denied"
  | "timeout"
  | "network"
  | "http-error"
  | "too-many-redirects"
  | "no-snapshot"
  /**
   * An OPTIONAL external binary the adapter shells out to is not installed —
   * currently `yt-dlp` for the YouTube/transcript adapter (src/fetch/youtube.ts),
   * mirroring the optional-peer-dependency posture of the Anthropic SDK. The
   * adapter DEGRADES to this typed error rather than throwing, so a consumer
   * without the binary pays nothing and gets a clear, branchable signal.
   */
  | "dependency-missing"
  /**
   * The external acquisition tool ran but failed (non-zero exit, unparseable
   * output) — e.g. `yt-dlp` erroring on a private/removed video. Distinct from
   * `network` (our own fetch) and `dependency-missing` (tool absent).
   */
  | "adapter-error";

/**
 * A typed, non-throwing fetch failure. `status` is populated for `http-error`.
 */
export interface FetchError {
  kind: FetchErrorKind;
  message: string;
  /** HTTP status for `kind === "http-error"`. */
  status?: number;
}

/** Audit facts for renderer policy orchestration; the selected result remains authoritative. */
export interface RenderEscalation {
  policy: RenderPolicy;
  shellWarningDetected: boolean;
  renderAttempted: boolean;
  outcome: "not-needed" | "rendered" | "render-failed-fallback" | "renderer-unavailable-fallback";
  /** Ref of the successful plain snapshot when it was replaced or retained as fallback. */
  firstSnapshotRef?: string;
  /** Typed rendered-attempt failure when the successful plain snapshot was retained. */
  renderError?: FetchError;
}

/**
 * The result of `fetchSource()` / `replaySource()`. Exactly one of
 * `snapshot`/`error` is populated; `warnings` collects non-fatal notes (e.g. an
 * unreachable robots.txt that was fail-open'd, or a retry that eventually
 * succeeded). Mirrors `ExtractionResult`'s never-throw shape.
 */
export interface FetchResult {
  snapshot?: Snapshot;
  error?: FetchError;
  warnings?: string[];
  /** Observational policy audit metadata; never a second snapshot/result bag. */
  renderEscalation?: RenderEscalation;
}

/**
 * A persistence + replay backend for snapshots. The bundled filesystem
 * implementation (`createFilesystemSnapshotStore`) is one; callers may inject
 * any other (an in-memory store backs the tests).
 */
export interface SnapshotStore {
  /** persist a snapshot under its `sourceId`. */
  put(snapshot: Snapshot): Promise<void>;
  /** the most-recently-fetched snapshot for `sourceId`, or undefined if none. */
  latest(sourceId: string): Promise<Snapshot | undefined>;
  /** a specific snapshot by its `bodyHash` (full or unambiguous prefix), or undefined. */
  get(sourceId: string, bodyHash: string): Promise<Snapshot | undefined>;
  /** all snapshots for `sourceId`, newest first. */
  list(sourceId: string): Promise<Snapshot[]>;
}

/**
 * A minimal structural subset of the global `fetch` — just what `fetchSource`
 * uses. The real `globalThis.fetch` satisfies it; tests inject a fake so no
 * test ever touches the network.
 */
export type FetchLike = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    redirect: "manual";
    signal: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

/** The structural subset of the fetch `Response` that `fetchSource` reads. */
export interface FetchLikeResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /**
   * OPTIONAL raw-bytes reader, used by `fetchSource` for binary
   * content-types (see `isBinaryContentType`). The real global `fetch`
   * `Response` always implements this. A custom `fetchImpl` that omits it
   * degrades gracefully for binary content — see the fallback branch in
   * `fetchSource` — rather than being required to implement it.
   */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/**
 * The outcome of one {@link RenderImpl} invocation — becomes a `Snapshot`
 * when successful. See {@link FetchSourceOptions.renderImpl} and
 * docs/decisions/rendered-fetch.md.
 */
export interface RenderResult {
  /** the rendered HTML — becomes `Snapshot.body` verbatim. */
  html: string;
  /**
   * The URL the renderer actually ended up on, if it followed any
   * client-side navigation; defaults to the requested URL when absent
   * (`fetchSource` never fabricates a redirect chain from this).
   */
  finalUrl?: string;
  /**
   * An HTTP-like status the renderer observed, if any; defaults to `200`
   * when absent. A value outside `[200,300)` maps to a typed `http-error`,
   * mirroring the direct-fetch non-2xx branch.
   */
  status?: number;
  /** non-fatal notes from the renderer, merged into `FetchResult.warnings`. */
  warnings?: string[];
}

/**
 * A caller-supplied renderer, invoked in place of a plain HTTP GET when a
 * source's {@link SourceConfig.render} is `true`. `timeoutMs` is a
 * DOCUMENTED HINT — `fetchSource` does NOT wrap this call in its own timeout
 * race (unlike {@link FetchLike}); the implementation is responsible for
 * enforcing it itself (e.g. a Playwright navigation timeout). Note the
 * signature below carries only `{ userAgent, timeoutMs }` — `SourceConfig.headers`
 * is NEVER forwarded here (the renderer implementation owns its own request
 * headers/auth) and `SourceConfig.retries` never wraps this call (a
 * `renderImpl` failure is not retried by `fetchSource`); both are flagged with
 * an explicit `FetchResult.warnings` note when the caller actually set them.
 * See docs/decisions/rendered-fetch.md.
 */
export type RenderImpl = (
  url: string,
  opts: { userAgent: string; timeoutMs: number },
) => Promise<RenderResult>;

/**
 * Injectable seams for `fetchSource`. Every default resolves to a real
 * runtime primitive; tests override them for deterministic, network-free,
 * timer-free runs.
 */
export interface FetchSourceOptions {
  /**
   * the fetch implementation; defaults to forage's SSRF-pinned guarded fetch,
   * which denies private / link-local / loopback / cloud-metadata targets and
   * pins vetted IPs through connect. Inject to bypass the guard (tests, a
   * browser-pinned crawler).
   */
  fetch?: FetchLike;
  /** wall-clock reader (ms) for politeness accounting; defaults to `Date.now`. */
  now?: () => number;
  /** ISO-timestamp source for `fetchedAt`; defaults to `() => new Date().toISOString()`. */
  clock?: () => string;
  /** async delay (ms) for politeness waits and retry backoff; defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** 0..1 jitter source for retry backoff; defaults to `Math.random`. */
  random?: () => number;
  /**
   * One-shot timeout scheduler used to abort a slow request. Returns a cancel
   * fn. Defaults to `setTimeout`/`clearTimeout`. Tests inject a firing-now (or
   * never-firing) scheduler to exercise the timeout path without real timers.
   */
  schedule?: (ms: number, cb: () => void) => () => void;
  /**
   * Per-host "last request finished at" state (ms), for politeness across
   * calls. Shared process-wide by default; inject a private map to isolate.
   */
  politenessState?: Map<string, number>;
  /** per-origin robots.txt cache; inject a private map to isolate. */
  robotsCache?: Map<string, RobotsRules>;
  /**
   * Snapshot store consulted ONLY when {@link SourceConfig.revalidate} is `true`:
   * `store.latest(config.id)` supplies a candidate prior snapshot. Its `etag` /
   * `lastModified` become `If-None-Match` / `If-Modified-Since` headers only for
   * a request to that prior's exact resource URL, and a `304` re-serves it as
   * `notModified` only when at least one of those exact-prior validators was
   * sent. An unconditional or fresh `200` supplies a new `bodyHash` for the
   * caller to compare; `fetchSource` does not compare it with the prior hash.
   * The store is unused (never read) when `revalidate` is falsy, so a plain fetch
   * never needs one. `fetchSource` only READS the store; persisting a fresh
   * snapshot stays the caller's / `fetchAndExtract`'s job.
   */
  store?: SnapshotStore;
  /**
   * Caller-supplied renderer for a source whose {@link SourceConfig.render}
   * is `true` (e.g. Playwright, Puppeteer, a remote rendering service, or a
   * test stub) — invoked in place of a plain HTTP GET for that source only.
   * Unlike every other seam on this interface, there is NO default: it is
   * simply `undefined` unless a caller wires one, since traverse core ships
   * no rendering/browser dependency of its own. Only invoked when the
   * fetched `SourceConfig.render` is also `true`; ignored otherwise. See
   * docs/decisions/rendered-fetch.md.
   */
  renderImpl?: RenderImpl;
}

/** Parsed, UA-resolved robots rules for one origin. `null` group = allow-all. */
export interface RobotsRules {
  /** ordered (path, allow?) rules for the matched UA group; empty = allow all. */
  rules: Array<{ path: string; allow: boolean }>;
}

export const DEFAULT_MIN_DELAY_MS = 1_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 2;
export const MAX_RETRIES = 5;
export const MAX_REDIRECTS = 5;

/**
 * Honest bot identity with a CONTACT PLACEHOLDER. Callers hitting real sites
 * should override `SourceConfig.userAgent` with a genuine contact so operators
 * can reach them — identifying as a bot with a reachable contact is the polite,
 * honest default this package ships.
 */
export const DEFAULT_USER_AGENT =
  "kontourai-traverse-bot/0.x (+https://github.com/kontourai/traverse; contact: set-a-real-contact@example.com)";
