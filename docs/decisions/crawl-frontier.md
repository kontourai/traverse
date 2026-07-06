---
status: current
subject: Crawl frontier (bounded same-host link-following)
decided: 2026-07-06
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/38
  - kind: adr
    ref: docs/adr/0002-fetch-snapshot-slice2.md
---
# Crawl frontier (bounded same-host link-following)

## Decision

`crawlSource(seed, opts)` (`src/fetch/crawl.ts`) adds a thin BFS driver on top
of the existing single-page `fetchSource()` / `replaySource()` — a bounded,
same-host, opt-in link-following capability for the `@kontourai/traverse/fetch`
subpath (issue #38, the first item picked up from the "Multi-page
link-following / crawl frontier" candidate in `docs/slice-3-candidates.md`).

It reuses `fetchSource()`/`replaySource()` exactly once per discovered page —
there is no separate HTTP GET, retry, redirect, or robots implementation in
`crawl.ts`. A single frontier invocation shares one `politenessState` map and
one `robotsCache` map (created fresh per call unless supplied) across every
page it fetches, so per-host politeness delay and robots caching are honored
across the whole frontier, not reset per page.

The following sub-decisions are ratified as part of this slice:

### 1. Query handling: verbatim, not canonicalized

Query strings are kept **verbatim** in the frontier's URL normalization; only
the URL fragment is stripped before a discovered link is enqueued. Two URLs
that differ only by query string (e.g. `?page=1` vs. `?page=2`) are treated as
distinct pages and are **not** deduped or canonicalized against each other.

This is a deliberate, minimal-for-slice-1 limitation, not an oversight: query
canonicalization (stripping tracking parameters, sorting params, collapsing
pagination variants) is real design work with product-specific tradeoffs, and
is explicitly deferred (see "Out of scope" below). The actual mitigation for
unbounded URL growth via query-string variants (e.g. a paginated or
calendar-style page emitting endless `?page=N` links) is the hard `maxPages`
cap on the frontier — not query-string logic. A crawl of a page that generates
more distinct query-string links than `maxPages` allows will stop at the cap,
report `truncated: true`, and warn naming the cap and the remaining discovered
count; it will not silently loop or grow without bound.

### 2. Replay semantics for a multi-page crawl

`mode: "replay"` replays **every** page in the frontier (not just the seed),
via `replaySource(store, pageId)`, using the same id-derivation scheme (see
decision 4 below) a prior `live-with-capture` run used to store each page's
snapshot. A page with no matching stored snapshot surfaces its own per-page
typed `no-snapshot` `FetchError` on that page's outcome only — it does not
fail the whole crawl. Because link discovery for a replayed page still depends
on that page's own snapshot having a body to parse, a replay run can
legitimately discover a smaller page set than the live run that originally
captured it.

`mode: "replay"` with no `store` supplied is a whole-crawl `invalid-config`
error, returned as a single-page manifest (`pages[0].fetch.error.kind ===
"invalid-config"`) rather than thrown. This reuses `fetchAndExtract`'s existing
error kind and message for the identical condition
(`src/fetch/compose.ts`'s `acquire()`) verbatim — no new error taxonomy is
introduced for the crawl frontier.

### 3. Same-host boundary

The same-host boundary is evaluated against the discovering page's
**post-redirect, final** URL's origin, compared to the seed's origin — not the
pre-redirect URL that was requested. A page whose own fetch redirected
off-host is still recorded in the manifest (it was already fetched, and that
outcome has value), but its links are never followed to expand the frontier.
This keeps the cross-host non-goal enforced even when a single page's own
redirect crosses hosts, without touching `fetchSource`'s existing single-page
redirect behavior.

### 4. Id scheme: `` `${encodeURIComponent(seed.id)}::${url}` ``

Each per-page fetch/replay uses a derived id of
`` `${encodeURIComponent(seed.id)}::${url}` `` (`pageId()` in `crawl.ts`). This
groups every page discovered by one crawl invocation under the caller's own
`seed.id` namespace (so all snapshots/log lines for one crawl are
attributable to the seed that started it) while still giving each distinct
URL its own stable snapshot-store identity, so replay and revalidation can
target one page precisely.

The seed id is `encodeURIComponent`-escaped before being joined with the `::`
delimiter — an earlier version of this scheme joined the raw, unescaped
`seed.id` and `url` (`` `${seed.id}::${url}` ``), which was collision-prone:
two different `(seed.id, url)` pairs could derive the byte-identical id, e.g.
`seed.id = "a::b"`, discovered `url = "c"` → `"a::b::c"`, versus a *separate*
crawl with `seed.id = "a"`, discovered `url = "b::c"` → the same `"a::b::c"`.
Since this id is the literal `SnapshotStore` key, a collision between two
different crawl invocations sharing one store would let them silently
read/write the same store slot in `live-with-capture`/`replay` mode.
`encodeURIComponent` escapes every `:` (and every `%`) in `seed.id`, so the
encoded seed id can never itself contain a raw `::` — meaning the FIRST `::`
in the composed id is unambiguously the join point, `url` (already an
absolute, self-delimiting http(s) URL) needs no escaping of its own, and two
distinct `(seed.id, url)` pairs can no longer derive the same id.

### 5. Per-page degradation, never a thrown crawl

`crawlSource` never throws. A malformed-HTML page that fails to parse in link
discovery degrades to "no links discovered from this page" for that page only
— the crawl continues. The `maxPages` cap stops the loop with
`truncated: true` plus a warning, not an exception. The only whole-crawl-level
typed error is the `invalid-config` case in decision 2 above; every other
failure (network error, robots-denied, no-snapshot, timeout, etc.) is a
per-page typed `FetchError` inside that page's `CrawlPageOutcome`, exactly as
a single `fetchSource()` call would already report it.

### 6. What a discovered page inherits from the seed config — and what it does not

Each discovered page's `SourceConfig` (`pageConfig` in `crawl.ts`) inherits the
seed's crawl-wide FETCH BEHAVIOR: `minDelayMs`, `timeoutMs`, `retries`,
`headers`, `userAgent`, `respectRobots`, `revalidate`. These are genuinely
process-wide HTTP-client settings the whole frontier is meant to share.

Deliberately NOT inherited: `SourceConfig.contentType`. It is a per-RESOURCE
identity hint — the caller telling `fetchSource` "the SEED page specifically
is html" — not a crawl-wide behavior. An earlier version of this code spread
the whole seed config (`{ ...seed, id, url }`), which forced every discovered
page (including a linked PDF or plain-text file) to inherit the seed's
`contentType` hint and be silently mis-typed as the seed's type, since
`resolveContentType()` always prefers an explicit hint over the response's own
`Content-Type` header (`fetch-source.ts`). Omitting `contentType` on
discovered pages lets each one's real `Content-Type` response header decide
its type, exactly as a fresh, hint-less `fetchSource()` call would.

`id`/`url` are always derived per-page (see decision 4) and never inherited
from the seed.

## Out of scope for this decision

The following remain explicitly deferred, unchanged from
`docs/slice-3-candidates.md`:

- Cross-host crawling (crawling follows links only within the seed's origin).
- Headless-browser / JavaScript rendering.
- Scheduling: recurring/deferred crawl runs, cross-process or distributed
  politeness coordination.
- A fuller robots engine: sitemap discovery, `Crawl-delay`, and the `*`/`$`
  pattern language (unchanged from Slice 2 — see ADR 0002).
- Query-string canonicalization / URL normalization beyond fragment-stripping
  (see decision 1 above).
- `crawlAndExtract` composition with `extract()` — this slice stays
  fetch-layer-only; a manifest's per-page `sourceRef` (built via the existing
  `buildSnapshotSourceRef`) gives a caller who wants extraction the
  provenance needed to compose it themselves.
