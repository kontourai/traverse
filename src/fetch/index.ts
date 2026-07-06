/**
 * `@kontourai/traverse/fetch` — the Slice-2 fetch/snapshot foundation.
 *
 * EXPORT SHAPE (justified in docs/adr/0002): this is a SUBPATH export, mirroring
 * the established `@kontourai/traverse/anthropic` discipline. The package root
 * (`@kontourai/traverse`) stays focused on the proposals-only extraction
 * identity — `extract()`, content-prep, and the core types — and does NOT
 * re-export any of the fetch surface. A consumer who only extracts imports
 * nothing here; a consumer who wants fetching opts in explicitly via the
 * `/fetch` subpath. The composition helper `fetchAndExtract` lives here too
 * (not at the root) because it is fetch-initiated and simply threads a snapshot
 * into the already-public `extract()`.
 */

export { fetchSource, resolveContentType, sha256Hex } from "./fetch-source.js";
export {
  createFilesystemSnapshotStore,
  createInMemorySnapshotStore,
  replaySource,
} from "./snapshot-store.js";
export type { FilesystemSnapshotStoreOptions } from "./snapshot-store.js";
export {
  fetchAndExtract,
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
} from "./compose.js";
export type {
  FetchMode,
  FetchAndExtractOptions,
  FetchAndExtractResult,
  ParsedSnapshotSourceRef,
} from "./compose.js";
export { crawlSource } from "./crawl.js";
export type { CrawlOptions, CrawlManifest, CrawlPageOutcome } from "./crawl.js";
export {
  DEFAULT_MAX_PAGES,
  MAX_CRAWL_PAGES,
  DEFAULT_MAX_DEPTH,
  MAX_CRAWL_DEPTH,
} from "./crawl.js";
export {
  fetchYouTube,
  parseYouTubeUrl,
  pickCaptionTrack,
  createDefaultYtDlp,
} from "./youtube.js";
export type {
  YouTubeSourceConfig,
  YouTubeVideoMetadata,
  YouTubeFetchResult,
  YouTubeFetchOptions,
  YtDlp,
  YtDlpCaptionTrack,
  YtDlpMetadata,
} from "./youtube.js";
export { parseRobots, isPathAllowed, productToken } from "./robots.js";
export type {
  SourceConfig,
  Snapshot,
  FetchResult,
  FetchError,
  FetchErrorKind,
  SnapshotStore,
  FetchSourceOptions,
  FetchLike,
  FetchLikeResponse,
  RobotsRules,
} from "./types.js";
export {
  DEFAULT_USER_AGENT,
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  MAX_RETRIES,
  MAX_REDIRECTS,
} from "./types.js";
