/**
 * Translation across the Traverse/forage fetch boundary.
 *
 * Both packages describe fetching a source, and the descriptions overlap
 * heavily — but they are two contracts for two layers, not one contract written
 * twice, and they diverge in both directions:
 *
 * | type                 | Traverse-only                                                | forage-only        |
 * | -------------------- | ------------------------------------------------------------ | ------------------ |
 * | `SourceConfig`       | `contentType`, `revalidate`, `renderPolicy`                    | `egress`           |
 * | `Snapshot`           | `contentType`, `bodyBytes`, `fromCache`, `etag`, `lastModified` | `headers`          |
 * | `FetchResult`        | `renderEscalation`                                             | —                  |
 * | `FetchSourceOptions` | —                                                              | `maxResponseBytes` |
 *
 * Traverse's extras carry extraction prep (`contentType`, `bodyBytes`) and HTTP
 * revalidation (`etag`, `lastModified`, `fromCache`, `revalidate`). forage's
 * carry egress policy and raw response headers. Neither is redundant, so
 * merging them would cost one layer something it needs.
 *
 * An application can still end up holding both — extracting through Traverse
 * while something else fetches through forage, which is what `@kontourai/lookout`
 * does since 0.3.1. Without a supported translation the only way across is a
 * cast, and a cast puts a real contract divergence into application code where
 * the next reader meets it as unexplained noise.
 *
 * These functions are that translation. They are deliberately lossy in one
 * direction and deliberately demanding in the other, and they say so: forage
 * requires an egress policy that Traverse has no field for, so the caller must
 * supply it rather than have one invented.
 */
import type { EgressPolicy } from "@kontourai/forage/egress";
import type { SourceConfig as ForageSourceConfig, FetchSourceOptions as ForageFetchSourceOptions } from "@kontourai/forage/fetch";
import type { SourceConfig, FetchSourceOptions } from "./types.js";

/** What a Traverse source config cannot answer, so a caller must. */
export interface ForageInteropPolicy {
  /**
   * forage guards the resolved address family (private, loopback, link-local,
   * metadata, NAT64) when `guarded` is set. Required rather than defaulted:
   * silently choosing either value would decide an application's SSRF posture
   * on its behalf.
   */
  readonly egress: EgressPolicy;
}

/**
 * A Traverse source config as forage describes one.
 *
 * Drops `contentType` (Traverse's prep layer reads it; forage has no equivalent
 * and never consumed it), `revalidate` and `renderPolicy` (Traverse's own
 * revalidation and render decisions, expressed differently by forage's
 * `render`). `render` is carried across when Traverse asked for one, since the
 * two agree on that much.
 */
export function toForageSourceConfig(config: SourceConfig, policy: ForageInteropPolicy): ForageSourceConfig {
  const { contentType: _contentType, revalidate: _revalidate, renderPolicy, ...shared } = config;
  return {
    ...shared,
    egress: policy.egress,
    ...(renderPolicy === "always"
      ? { render: true as const }
      : renderPolicy === "on-shell-warning"
        ? { render: "on-shell" as const }
        : {}),
  };
}

/**
 * Traverse fetch options as forage describes them.
 *
 * The field sets match here — forage only adds `maxResponseBytes` — so this is
 * a nominal translation rather than a lossy one. `store` is carried when
 * present; a caller handing these to something that owns its own snapshot store
 * (Lookout does since 0.3.x) should omit it.
 */
export function toForageFetchOptions(options: FetchSourceOptions | undefined): ForageFetchSourceOptions | undefined {
  if (!options) return undefined;
  const { renderImpl, store, fetch: fetchLike, robotsCache, ...shared } = options;
  return {
    ...shared,
    // Both packages declare their own FetchLike and RobotsRules with the same
    // shape; these assertions cross that nominal boundary, not a real one.
    ...(fetchLike ? { fetch: fetchLike as ForageFetchSourceOptions["fetch"] } : {}),
    ...(robotsCache ? { robotsCache: robotsCache as ForageFetchSourceOptions["robotsCache"] } : {}),
    ...(renderImpl ? { renderImpl: renderImpl as ForageFetchSourceOptions["renderImpl"] } : {}),
    ...(store ? { store: store as ForageFetchSourceOptions["store"] } : {}),
  };
}
