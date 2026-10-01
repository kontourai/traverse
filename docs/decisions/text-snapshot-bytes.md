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
forage's `parseDeclaredCharset` and `decodeTextBody`. Traverse and the forage
it resolves therefore decode alike. An application that also installs another
forage version can still see two decoders.

A text snapshot read this way carries `bytes` (the exact bytes) and
`declaredCharset` (`null` when none was usable). The names and meanings are
forage's. `bodyBytes` stays the binary marker and is never set for text.

`snapshotHashBasis(snapshot)` names which input a `bodyHash` is taken over:
`"bytes"` when the snapshot carries `bodyBytes` or `bytes`, `"decoded-utf8"`
otherwise. It reads field presence only and verifies nothing.

## Stored records

The bundled stores keep one copy of a byte-hashed text record's content: the
bytes. The filesystem store writes `bytesBase64` and `declaredCharset` and
does not write `body`. On read, both stores check that the bytes hash to
`bodyHash` and decode `body` from them with `declaredCharset`. A stored record
therefore cannot return text that disagrees with the bytes its hash covers.

A record fails that read when its bytes do not hash to `bodyHash`, when it
has `bytes` without `declaredCharset` or the reverse, or when
`declaredCharset` is neither a string nor `null`. `SnapshotStore` returns
snapshots and has no channel for reporting a record it declined, so a failed
record is skipped, the same way an unparseable file already was. `get()` by
its hash then finds nothing. `latest()` returns the newest record that does
pass, which can be an older capture; nothing tells the caller that happened.
That is a known limit of the store interface, not a decision that it is
acceptable.

What the read check covers is the bytes. `bodyHash` does not cover the
charset label, so a record whose `declaredCharset` was altered still reads,
with its text decoded under the altered label. A binary record's `bodyBytes`
and the body of a text record without `bytes` are returned as stored, as
before.

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

Keeping the bytes is what makes the digest checkable: a stored text record
whose hash covers bytes it no longer has could not be verified by anyone. The
bundled stores do that check on every read (see Stored records).

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
