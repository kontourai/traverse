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
(issue #23). For a resolved `contentType` classified BINARY — `"pdf"`,
`"png"`, or `"jpeg"` via an internal `isBinaryContentType` helper —
`fetchSource` sets `bodyBytes` to the raw response bytes
and leaves `body` as `""`; every other resolved type (`"html"`/`"text"`/
`"transcript"`) sets `body` and leaves `bodyBytes` unset. `bodyBytes`
PRESENCE is the binary marker; there is no separate `isBinary` flag, and
EXACTLY ONE of `body` / `bodyBytes` is ever populated for a given snapshot.
An additive field was chosen over a `body: string | Uint8Array` union so
every existing `snapshot.body` read-site (`crawlSource`'s
`discoverSameHostLinks`, content-prep's text/html paths) keeps compiling and
behaving unchanged without a type-narrowing rewrite; out-of-line storage
(bytes referenced by a separate blob store) was rejected as heavier machinery
than the binary-classified content types warrant.

**Hash domain per representation.** `bodyHash` is sha256 over the RAW bytes
(`sha256Bytes`) for a binary snapshot. This decision originally kept every
text snapshot on sha256 of utf8-`body` (`sha256Hex`); the text domain is now
decided in [text-snapshot-bytes](./text-snapshot-bytes.md), which hashes a
text response by its bytes too and keeps the utf8-`body` domain only for
snapshots that have no response bytes.

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
in-memory store originally kept the caller's `Uint8Array` instance; it now
copies bytes on `put()` and on read, as decided in
[text-snapshot-bytes](./text-snapshot-bytes.md).

**Consumer seams unblocked.** `fetchAndExtract` (`compose.ts`) forwards
binary text-extractor seams and passes `snapshot.bodyBytes ?? snapshot.body`
into `extract()`. The PDF seam issue #28 deliberately left
`pdfTextExtractor` unforwarded because a string-only `Snapshot.body` could
never satisfy `extract()`'s PDF pre-step (`ExtractInput.content` needing a
`Uint8Array`). Image OCR follows the same path through
`ExtractInput.imageTextExtractor`: PNG/JPEG snapshots carry raw bytes, and
the optional extractor turns those bytes into the prepared text that
proposal excerpts verify against.

## Boundary

`crawlSource`'s `discoverSameHostLinks` (html-only guarded) and the
robots-fetch path (reads `response.text()` directly, never builds a
`Snapshot`) are unaffected — html and robots.txt are never binary-classified,
so `body` stays populated for those paths exactly as before.
