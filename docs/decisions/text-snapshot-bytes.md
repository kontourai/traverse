---
status: current
subject: Text snapshots are hashed by their response bytes and decoded by declared charset
decided: 2026-10-01
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/195
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/196
---
# Text snapshots are hashed by their response bytes and decoded by declared charset

## Decision

`fetchSource` reads every response body as bytes when the response has
`arrayBuffer()`. `bodyHash` is the SHA-256 of those bytes for text and binary
alike. A text body is decoded with the charset its `Content-Type` declares
(UTF-8 when none is declared, a matching byte-order mark removed), using
forage's `parseDeclaredCharset` and `decodeTextBody` so the two fetchers
cannot drift apart.

A text snapshot read this way carries `bytes` (the exact bytes) and
`declaredCharset` (`null` when none was usable). The names and meanings are
forage's. `bodyBytes` stays the binary marker and is never set for text.
The filesystem store writes `bytes` as base64 in `bytesBase64`.

`snapshotHashBasis(snapshot)` reports which input a `bodyHash` covers:
`"bytes"` when the snapshot carries `bodyBytes` or `bytes`, `"decoded-utf8"`
otherwise.

## Why

Before this, the fetcher called `response.text()`, which decodes as UTF-8
whatever the server declared, and hashed the UTF-8 of the result. Two things
followed.

- A page in another charset was captured as replacement characters, and the
  extractor read that.
- The digest differed from the digest of the bytes for any response that was
  not valid UTF-8 without a byte-order mark. forage hashes the bytes, so the
  two packages disagreed about the same response, and comparing their digests
  or references reported a difference where there was none.

Keeping the bytes is what makes the digest checkable. A stored text record
whose hash covers bytes it no longer has could not be verified by anyone.

## What changes on the wire

The digest, and so the `sha256` in a `traverse-snapshot` reference, changes
for a text response fetched live whose bytes are not the UTF-8 encoding of the
text the old decode produced:

- a declared non-UTF-8 charset with bytes outside ASCII (the text changes too:
  it is now decoded correctly);
- a UTF-8 byte-order mark (the text is the same);
- bytes that are not valid UTF-8 (the text is the same, with U+FFFD).

Nothing changes for valid UTF-8 without a byte-order mark, for binary,
rendered or transcript snapshots, for a `fetchImpl` without `arrayBuffer()`,
or for a replayed or `304` snapshot, which carries the hash it was stored
with.

Records and references stored earlier are not rewritten. Each still resolves
against its own record and its hash still matches the UTF-8 of its stored
`body`. An earlier record and a new capture of an affected page have digests
on different bases, so a difference between them does not show the page
changed. `snapshotHashBasis` lets a caller see that and decline to conclude
either way. A reference string does not carry its basis.

A verifier that recomputes a text snapshot's hash as sha256 of utf8-`body`
rejects a new capture of an affected page. It needs to hash `bytes` when the
snapshot has them.

## Boundary

A `fetchImpl` without `arrayBuffer()` cannot report its bytes. Its captures
keep the `text()` body and the `"decoded-utf8"` basis, and a binary
content-type read that way still gets the lossy-capture warning.

The warnings forage's decoder reports (malformed or unknown charset label,
bytes invalid in the chosen encoding) are passed through on
`FetchResult.warnings`, prefixed with the URL.
