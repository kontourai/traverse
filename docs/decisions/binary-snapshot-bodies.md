---
status: current
subject: Binary-safe Snapshot bodies and bodyHash domain
decided: 2026-07-07
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/23
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/28
---
# Binary-safe Snapshot bodies and bodyHash domain

## Decision

`Snapshot` gains an additive `bodyBytes?: Uint8Array` rather than widening
`body` into a union or moving binary content out-of-line into the store
(issue #23). For a resolved `contentType` classified BINARY — today `"pdf"`
only, via an internal `isBinaryContentType` helper so a future binary type is
a one-line addition — `fetchSource` sets `bodyBytes` to the raw response bytes
and leaves `body` as `""`; every other resolved type (`"html"`/`"text"`/
`"transcript"`) sets `body` and leaves `bodyBytes` unset. `bodyBytes`
PRESENCE is the binary marker; there is no separate `isBinary` flag, and
EXACTLY ONE of `body` / `bodyBytes` is ever populated for a given snapshot.
An additive field was chosen over a `body: string | Uint8Array` union so
every existing `snapshot.body` read-site (`crawlSource`'s
`discoverSameHostLinks`, content-prep's text/html paths) keeps compiling and
behaving unchanged without a type-narrowing rewrite; out-of-line storage
(bytes referenced by a separate blob store) was rejected as heavier machinery
than a single binary-classified content type warrants.

**Hash domain per representation.** `bodyHash` is sha256 over the RAW bytes
(`sha256Bytes`, new) for a binary snapshot, and remains sha256 of
utf8-`body` (`sha256Hex`, pre-existing) for every text snapshot — the text
domain is byte-identical to pre-#23 behavior, so no existing stored
`bodyHash` / `store.get(sourceId, bodyHash)` lookup is invalidated by this
change. Widening the text domain to also hash bytes (e.g.
`sha256Bytes(new TextEncoder().encode(body))`) was rejected: it would
silently break every existing cache/replay compare with no error, only a
downstream "cache miss".

**Optional `arrayBuffer` fallback.** `FetchLikeResponse.arrayBuffer` is
OPTIONAL, not required, so a custom test/production `fetchImpl` predating
this change keeps compiling. When a binary content-type's response has no
`arrayBuffer()`, `fetchSource` degrades to the pre-existing lossy `text()`
capture (no `bodyBytes` set) AND pushes a clear warning onto
`FetchResult.warnings` — never silent corruption. The real global `fetch`
`Response` always implements `arrayBuffer()`, so this fallback only matters
for an injected fetch shim.

**Store persistence.** The filesystem snapshot store serializes `bodyBytes`
as base64 in a sibling on-disk JSON field (`JSON.stringify` cannot round-trip
a raw `Uint8Array`); an old on-disk snapshot file with no such field still
loads unchanged (`isSnapshot` validates `bodyBytes` only when present). The
in-memory store's existing shallow spreads already preserve the same
`Uint8Array` instance rather than deep-cloning bytes on `put()`/
`replaySource()`.

**Consumer unblocked.** `fetchAndExtract` (`compose.ts`) now forwards
`pdfTextExtractor` and passes `snapshot.bodyBytes ?? snapshot.body` into
`extract()` — the seam issue #28 deliberately left unforwarded because a
string-only `Snapshot.body` could never satisfy `extract()`'s PDF pre-step
(`ExtractInput.content` needing a `Uint8Array`). `extract()`'s PDF handling
itself (`ExtractInput.content: string | Uint8Array`,
`ExtractInput.pdfTextExtractor`) was already correct and tested from #21;
this decision only closes the producer-side gap that kept a live/replayed
PDF fetch from ever reaching it.

## Boundary

`crawlSource`'s `discoverSameHostLinks` (html-only guarded) and the
robots-fetch path (reads `response.text()` directly, never builds a
`Snapshot`) are unaffected — html and robots.txt are never binary-classified,
so `body` stays populated for those paths exactly as before.
