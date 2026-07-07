/**
 * `crawlSource` — bounded, same-host, BFS link-following on top of the
 * existing single-page `fetchSource()`/`replaySource()`.
 *
 * THIN DRIVER, NOT A NEW FETCHER: `crawlSource` never issues its own HTTP
 * request, retry, redirect, or robots check. Every page in the frontier is
 * fetched by calling `fetchSource()` (or, in `replay` mode, `replaySource()`)
 * exactly once, with the SAME `politenessState`/`robotsCache` maps threaded
 * through every call in one crawl — so per-host politeness delay and robots
 * caching are honored ACROSS the whole frontier, exactly as they already are
 * within a single `fetchSource()` call. See `fetch-source.ts` for that logic
 * (unchanged, reused verbatim here).
 *
 * SAME-HOST ONLY: link discovery is gated to the seed's origin. A page whose
 * own fetch redirected off-host is still recorded (it was already fetched),
 * but its links are never followed — crossing hosts is out of scope for this
 * slice (see docs/decisions/crawl-frontier.md).
 *
 * NEVER THROWS: the whole crawl loop is wrapped so a synchronous surprise
 * (e.g. a malformed-HTML parse failure during link discovery) degrades to a
 * warning / no-discovered-links rather than propagating — the same never-throw
 * discipline documented atop `fetch-source.ts`/`compose.ts`. The only
 * whole-crawl-level typed error is `invalid-config` (replay mode with no
 * `store`), reusing the exact error kind `fetchAndExtract`'s `acquire()`
 * already uses for the identical condition (`compose.ts`).
 *
 * FETCH-LAYER ONLY: the manifest never calls `extract()` — a per-page
 * `sourceRef` (built via the existing `buildSnapshotSourceRef`) gives a caller
 * who composes extraction later the same provenance continuity
 * `fetchAndExtract` provides for a single page. `crawlAndExtract` is
 * explicitly out of scope for this slice.
 */

import { parseHTML } from "linkedom";
import { fetchSource } from "./fetch-source.js";
import { replaySource } from "./snapshot-store.js";
import { buildSnapshotSourceRef } from "./compose.js";
import type { FetchResult, FetchSourceOptions, RobotsRules, SnapshotStore, SourceConfig } from "./types.js";

/** Default page budget for one crawl, when `CrawlOptions.maxPages` is unset. */
export const DEFAULT_MAX_PAGES = 20;
/** Hard ceiling `maxPages` is clamped to, regardless of what the caller asks for. */
export const MAX_CRAWL_PAGES = 500;
/** Default depth budget for one crawl, when `CrawlOptions.maxDepth` is unset. */
export const DEFAULT_MAX_DEPTH = 2;
/** Hard ceiling `maxDepth` is clamped to, regardless of what the caller asks for. */
export const MAX_CRAWL_DEPTH = 10;

export interface CrawlOptions {
  /**
   * Upper bound on the number of pages FETCHED in this crawl. Clamped into
   * `[0, MAX_CRAWL_PAGES]`. Default {@link DEFAULT_MAX_PAGES}. This — not
   * query-string canonicalization — is the actual bound on unbounded URL
   * growth (e.g. a pagination page generating infinite `?page=N` links); see
   * docs/decisions/crawl-frontier.md.
   */
  maxPages?: number;
  /**
   * Upper bound on link-discovery depth from the seed (seed is depth 0).
   * Clamped into `[0, MAX_CRAWL_DEPTH]`. Default {@link DEFAULT_MAX_DEPTH}.
   */
  maxDepth?: number;
  /** snapshot store; REQUIRED for `replay` and used (optionally) by `live-with-capture`. */
  store?: SnapshotStore;
  /** live (default) | replay | live-with-capture — same vocabulary as `fetchAndExtract`'s `FetchMode`. */
  mode?: "live" | "live-with-capture" | "replay";
  /**
   * Injectable fetch/time seams forwarded to every per-page `fetchSource()`
   * call. If `politenessState`/`robotsCache` are absent, `crawlSource` creates
   * one fresh `Map()` of each PER INVOCATION and shares that same pair across
   * every page in this crawl (so politeness/robots are enforced across the
   * whole frontier, not reset per page) — it deliberately does NOT fall back
   * to `fetchSource`'s process-wide singletons for this.
   */
  fetchOptions?: FetchSourceOptions;
}

/** The fetch (or replay) outcome for one page discovered/fetched during a crawl. */
export interface CrawlPageOutcome {
  /** the page's URL, as popped from the frontier (pre-fetch; may differ from the post-redirect `fetch.snapshot.url`). */
  url: string;
  /** BFS distance from the seed (seed itself is depth 0). */
  depth: number;
  /** the `fetchSource()`/`replaySource()` outcome for this page — `snapshot` or typed `error`, never throws. */
  fetch: FetchResult;
  /** the snapshot-anchored provenance ref for this page, when a snapshot was produced. */
  sourceRef?: string;
}

/** The result of one `crawlSource()` call: an ordered, depth-tagged, bounded page set. */
export interface CrawlManifest {
  /** the crawl's starting point — the `id`/`url` `crawlSource` was called with. */
  seed: { id: string; url: string };
  /** pages in BFS discovery order. */
  pages: CrawlPageOutcome[];
  /** non-fatal notes accumulated across the crawl (per-page warnings, prefixed with `[depth N] url:`, plus the cap-reached note when truncated). */
  warnings: string[];
  /** `true` when the frontier still held undiscovered URLs after `maxPages` stopped the loop. */
  truncated: boolean;
}

interface Frontier {
  url: string;
  depth: number;
}

/**
 * Parse `html` and return the same-host, fragment-stripped, query-verbatim
 * URLs it links to, in document order (one entry per anchor, before the
 * caller's dedup). Never throws: a linkedom parse failure (malformed HTML) or
 * an unparseable/non-http(s) href is simply skipped rather than propagated.
 */
function discoverSameHostLinks(html: string, baseHref: string, seedOrigin: string): string[] {
  const found: string[] = [];
  try {
    const { document } = parseHTML(html);
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href");
      if (!href) continue;
      let url: URL;
      try {
        url = new URL(href, baseHref);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      if (url.origin !== seedOrigin) continue;
      found.push(url.href);
    }
  } catch {
    // Malformed HTML (or any linkedom parse failure): no links discovered,
    // never an exception (AC4's third scenario).
    return [];
  }
  return found;
}

/**
 * Derive a discovered page's fetch/replay/store id from the seed id and the
 * page's URL. `seedId` is percent-encoded (`encodeURIComponent`) before being
 * joined with the `::` delimiter: `encodeURIComponent` escapes every `:` (and
 * every `%`), so the encoded seed id can never itself contain a raw `::` —
 * which means the FIRST `::` in the composed string is unambiguously the
 * join point, and `url` (already an absolute, self-delimiting http(s) URL,
 * appearing strictly after that join point) never needs its own escaping.
 * Two distinct `(seedId, url)` pairs can therefore never derive the same id
 * — see docs/decisions/crawl-frontier.md decision 4 for the collision this
 * replaces (unescaped concatenation let e.g. `seedId="a::b", url="c"` and
 * `seedId="a", url="b::c"` both derive `"a::b::c"`).
 */
function pageId(seedId: string, url: string): string {
  return `${encodeURIComponent(seedId)}::${url}`;
}

/**
 * BFS crawl of `seed`'s same-host link graph, calling `fetchSource()` (or, in
 * `replay` mode, `replaySource()`) exactly once per discovered page. Never
 * throws. See the module doc comment for the safety/scope discipline.
 */
export async function crawlSource(seed: SourceConfig, opts: CrawlOptions = {}): Promise<CrawlManifest> {
  const seedRef = { id: seed.id, url: seed.url };
  try {
    const maxPages = Math.max(0, Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, MAX_CRAWL_PAGES));
    const maxDepth = Math.max(0, Math.min(opts.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_CRAWL_DEPTH));
    const mode = opts.mode ?? "live";

    if (mode === "replay" && !opts.store) {
      return {
        seed: seedRef,
        pages: [
          {
            url: seed.url,
            depth: 0,
            fetch: { error: { kind: "invalid-config", message: "mode 'replay' requires a store" } },
          },
        ],
        warnings: [],
        truncated: false,
      };
    }

    // Share ONE pair of politeness/robots maps across every per-page fetch in
    // this crawl (R2) — create fresh ones unless the caller injected their own.
    const fetchOptions: FetchSourceOptions = { ...(opts.fetchOptions ?? {}) };
    if (!fetchOptions.politenessState) fetchOptions.politenessState = new Map<string, number>();
    if (!fetchOptions.robotsCache) fetchOptions.robotsCache = new Map<string, RobotsRules>();

    // Fragment-strip the seed URL before it enters the frontier, exactly as
    // every DISCOVERED link already is (`discoverSameHostLinks` above) — a
    // same-page self-link found on the seed page (e.g. `<a href="#top">`)
    // resolves and strips to the fragment-less URL, so `seen` must hold the
    // fragment-less form of the seed too, or that self-link would look like a
    // distinct "new" page and waste a `maxPages` slot re-fetching the seed.
    let seedOrigin: string;
    let seedUrl: string;
    try {
      const u = new URL(seed.url);
      seedOrigin = u.origin;
      u.hash = "";
      seedUrl = u.href;
    } catch {
      // fetchSource's own validation surfaces `invalid-url` on the first call;
      // no need to duplicate that check here.
      seedOrigin = "";
      seedUrl = seed.url;
    }

    const queue: Frontier[] = [{ url: seedUrl, depth: 0 }];
    const seen = new Set<string>([seedUrl]);
    const pages: CrawlPageOutcome[] = [];
    const warnings: string[] = [];

    while (queue.length > 0 && pages.length < maxPages) {
      const { url, depth } = queue.shift()!;
      // Inherit the seed's crawl-wide FETCH BEHAVIOR (politeness delay,
      // timeout, retries, extra headers, user-agent identity, robots policy,
      // conditional-GET opt-in, render opt-in) onto every discovered page — these are
      // genuinely process-wide HTTP-client settings meant to apply uniformly
      // across the whole frontier. Deliberately NOT inherited: `contentType`.
      // That is a per-RESOURCE identity hint (the caller telling
      // `fetchSource` "the SEED page specifically is html"), not a crawl-wide
      // behavior — blindly spreading it (the old `{ ...seed }`) would force
      // every discovered page (including a linked PDF or plain-text file) to
      // be mis-typed as the seed's type. Omitting it lets `fetchSource`'s own
      // `resolveContentType()` sniff each page's own response `Content-Type`
      // header, exactly as it would for a fresh, hint-less `fetchSource()`
      // call. `id`/`url` are always per-page, never inherited.
      const pageConfig: SourceConfig = {
        id: pageId(seed.id, url),
        url,
        minDelayMs: seed.minDelayMs,
        timeoutMs: seed.timeoutMs,
        retries: seed.retries,
        headers: seed.headers,
        userAgent: seed.userAgent,
        respectRobots: seed.respectRobots,
        revalidate: seed.revalidate,
        render: seed.render,
      };

      const fetchResult =
        mode === "replay" ? await replaySource(opts.store!, pageConfig.id) : await fetchSource(pageConfig, fetchOptions);

      if (mode === "live-with-capture" && fetchResult.snapshot && opts.store) {
        // A store.put() failure (disk full, permission error, a custom
        // SnapshotStore that rejects) degrades to a PAGE-scoped warning, not
        // the whole-crawl catch below: the page's own fetch already
        // succeeded, so it keeps its outcome (with a snapshot in-memory, just
        // not persisted) and every sibling page already collected — or yet to
        // be fetched — is unaffected. Mirrors the `revalidate` prior-snapshot
        // lookup's own try/catch degradation in fetch-source.ts.
        try {
          await opts.store.put(fetchResult.snapshot);
        } catch (err) {
          warnings.push(
            `[depth ${depth}] ${url}: store.put failed (${err instanceof Error ? err.message : String(err)}); page fetch result kept, snapshot not persisted`,
          );
        }
      }

      const sourceRef = fetchResult.snapshot ? buildSnapshotSourceRef(fetchResult.snapshot) : undefined;
      pages.push({ url, depth, fetch: fetchResult, sourceRef });

      if (fetchResult.warnings) {
        for (const w of fetchResult.warnings) warnings.push(`[depth ${depth}] ${url}: ${w}`);
      }

      if (!fetchResult.snapshot || fetchResult.snapshot.contentType !== "html" || depth >= maxDepth) continue;

      const finalUrl = fetchResult.snapshot.url;
      let finalOrigin: string;
      try {
        finalOrigin = new URL(finalUrl).origin;
      } catch {
        continue;
      }
      if (finalOrigin !== seedOrigin) {
        warnings.push(`[depth ${depth}] ${url}: fetched page resolved off-host (${finalUrl}); its links were not followed`);
        continue;
      }

      const links = discoverSameHostLinks(fetchResult.snapshot.body, finalUrl, seedOrigin);
      for (const link of links) {
        if (seen.has(link)) continue;
        seen.add(link);
        queue.push({ url: link, depth: depth + 1 });
      }
    }

    const truncated = queue.length > 0;
    if (truncated) {
      warnings.push(`maxPages cap (${maxPages}) reached; ${queue.length} further URL(s) discovered but not fetched`);
    }

    return { seed: seedRef, pages, warnings, truncated };
  } catch (err) {
    // Never throw: degrade to a best-effort, warning-only manifest.
    return {
      seed: seedRef,
      pages: [],
      warnings: [`crawlSource: unexpected error (${err instanceof Error ? err.message : String(err)}); returning partial manifest`],
      truncated: false,
    };
  }
}
