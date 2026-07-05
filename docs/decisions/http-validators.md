---
status: current
subject: HTTP validators (ETag / conditional GET) on snapshots
decided: 2026-07-05
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/31
  - kind: adr
    ref: docs/adr/0002-fetch-snapshot-slice2.md
---
# HTTP validators (ETag / conditional GET) on snapshots

## Decision

`Snapshot` stores the response `ETag` and `Last-Modified` validators, and
`fetchSource` supports an opt-in CONDITIONAL GET (issue #31, completing the
"URL recheck" story of kontourai/ops#75).

- A `200` captures `etag` / `lastModified` (verbatim) onto the snapshot when the
  server sends them; absent headers leave the fields unset.
- With `SourceConfig.revalidate: true` and a `FetchSourceOptions.store`, a
  re-fetch looks up the prior snapshot for the `id` and, when it carries
  validators, sends `If-None-Match` / `If-Modified-Since`. A `304 Not Modified`
  re-serves the byte-identical prior snapshot marked `fromCache` + `notModified`
  — zero body transfer — so a caller can record a cheap "checked, still current"
  freshness event.
- **Fallback.** When a server offers no validators (or there is no prior
  snapshot), the fetch proceeds normally and the existing sha256 body-hash
  compare remains the drift signal — validators only make the unchanged case
  cheap; they never replace the hash compare.

`fetchSource` NEVER THROWS: an unsolicited `304` with no prior snapshot is a
typed `http-error`, not an exception. It only READS the store; persisting a
fresh snapshot stays the caller's / `fetchAndExtract`'s job.

## Boundary

Check MECHANICS (validators, hash compare) live in traverse; recheck
ORCHESTRATION (when to check, recording drift as events, freshness integration)
is the kit's. Repo pins remain plain `git ls-remote`, no traverse involvement.
