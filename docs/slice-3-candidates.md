# Slice-3 candidates (fetch side)

Slice 2 delivered the **standalone-first** fetch/snapshot foundation
(configurable single-page fetch + snapshot capture + replay + one-call
composition with `extract()`). The following were deliberately kept OUT of
Slice 2 and are recorded here as candidates for a future slice. None of them is
promised; this is a backlog note, not a plan.

## Explicitly deferred by the Slice-2 brief

- **Multi-page link-following / crawl frontier** — shipped, in bounded form, as
  `crawlSource` (same-host BFS only; cross-host crawling remains out of
  scope). Design decisions recorded in
  [`docs/decisions/crawl-frontier.md`](decisions/crawl-frontier.md).
- **Headless-browser rendering** — executing JavaScript to fetch content that
  is not present in the server-rendered HTML. Slice 2 does a plain HTTP GET.
  The render *seam* (opt-in `renderImpl` on `fetchSource`/`crawlSource`, plus
  the `render-escalation` policy) shipped in 0.13.0 — traverse still bundles
  no renderer of its own; a caller supplies one. See "Rendered fetch" in the
  README.
- **Scheduling** — recurring/deferred fetch runs, cross-process or distributed
  politeness, rate-limit coordination across many sources. Slice 2's politeness
  is in-process and best-effort only.

## Discovered while building Slice 2

- **Strict robots fail-closed mode** — a config option to treat an unreachable
  or 5xx `/robots.txt` as "disallow all" (RFC 9309's stricter reading). Slice 2
  fails **open** with a warning (see ADR 0002 §D3).
- **Fuller robots engine** — `Crawl-delay`, `Sitemap`, and the `*`/`$` pattern
  language. Slice 2's matcher is product-token group selection + longest-prefix
  Allow/Disallow (Allow wins ties) only.
- **Conditional GET / caching** — shipped. `ETag`/`If-None-Match` and
  `Last-Modified`/`If-Modified-Since` validators are stored on the snapshot,
  and an opt-in `revalidate` flag on `fetchSource` sends them on a re-check,
  reusing the prior snapshot on a bodyless `304` (`fromCache` +
  `notModified`, no re-download). See "Conditional GET" in the README and
  [`docs/decisions/http-validators.md`](decisions/http-validators.md).
- **Snapshot retention / compaction** — the filesystem store keeps every
  snapshot forever; a retention policy (keep-N, keep-since) would belong here.
- **Non-UTF-8 body decoding** — Slice 2 decodes bodies as UTF-8; charset
  detection from headers/BOM/meta is deferred.
- **PDF fetch → extract** — the content type is carried through, but PDF
  content-prep is still the Slice-1 deferred typed error.
