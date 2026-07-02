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
   * (html/text/pdf). When absent, the header is used (defaulting to `text`).
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
}

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
   * The RESOLVED Traverse content type (html/text/pdf) — the value handed to
   * content-prep on replay/extraction, decided from {@link SourceConfig.contentType}
   * or the response `Content-Type` header at fetch time. Kept resolved (not the
   * raw header) so replay is deterministic and needs no re-parsing.
   */
  contentType: ContentType;
  /** the response body, decoded as UTF-8 text. */
  body: string;
  /** lowercase hex SHA-256 of `body` — the byte-identity fingerprint. */
  bodyHash: string;
  /** the redirect chain that led here, if any: the ordered list of URLs visited BEFORE `url`. */
  redirects?: string[];
  /** true when this snapshot was served from a store (replay) rather than the network. */
  fromCache?: boolean;
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
  | "no-snapshot";

/**
 * A typed, non-throwing fetch failure. `status` is populated for `http-error`.
 */
export interface FetchError {
  kind: FetchErrorKind;
  message: string;
  /** HTTP status for `kind === "http-error"`. */
  status?: number;
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
}

/**
 * Injectable seams for `fetchSource`. Every default resolves to a real
 * runtime primitive; tests override them for deterministic, network-free,
 * timer-free runs.
 */
export interface FetchSourceOptions {
  /** the fetch implementation; defaults to `globalThis.fetch` (undici). */
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
