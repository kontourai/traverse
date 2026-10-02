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

The bundled stores return a record only if its content hashes to its
`bodyHash`, on the one basis its fields allow:

- a binary record: SHA-256 of `bodyBytes`. It must have an empty `body` and
  neither `bytes` nor `declaredCharset`;
- a byte-hashed text record: SHA-256 of `bytes`, with a `declaredCharset` that
  is a string or `null`;
- any other record: SHA-256 of the UTF-8 of `body`, with no `declaredCharset`.

A byte-hashed text record keeps one copy of its content, the bytes. The
filesystem store writes `bytesBase64` and `declaredCharset` and does not write
`body`; `body` is decoded from the bytes on read.

So the text a store returns is always the text its `bodyHash` covers. Rewriting
a record's content changes what it hashes to, and the record stops reading.
Rewriting the content and `bodyHash` together produces a record that reads,
under a different `bodyHash`: it no longer answers to any reference minted for
the original.

`put()` throws a `TypeError` for a snapshot that would not read back unchanged:
one that fails the rule above, or a byte-hashed text snapshot whose `body` is
not the decode of its `bytes`. The in-memory store copies byte arrays on `put()`
and on every read, so neither the caller's array nor a returned one is the
stored one. That replaces the reference semantics `binary-snapshot-bodies`
recorded for the in-memory store.

### Limits

- `SnapshotStore` returns snapshots and has no channel for reporting a record
  it declined, so a record that fails on read is skipped, the same way an
  unparseable file already was. `get()` by its hash then finds nothing.
  `latest()` returns the newest record that does pass, which can be an older
  capture; nothing tells the caller that happened. That is a known limit of
  the store interface, not a decision that it is acceptable.
- The check covers the content. `bodyHash` does not cover the charset label or
  any other field, so a record whose `declaredCharset` was altered still
  reads, with its text decoded under the altered label.
- The warnings the decoder gave at fetch time (unknown label, bytes invalid in
  the encoding) are on that fetch's `FetchResult.warnings` only. They are not
  stored, and decoding again on read does not report them.

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

Three more things break for a caller, beyond the digest:

- A verifier that recomputes a text snapshot's hash as sha256 of utf8-`body`
  rejects a new capture of an affected page. It needs to hash `bytes` when the
  snapshot has them.
- The stored shape of a text record is not additive. A text record written by
  this version has no `body` on disk, and the previous release's reader
  requires one, so it skips the record and its `latest()` returns an older
  capture. Where two versions share a filesystem store, upgrade every reader
  before any writer.
- A record whose `bodyHash` is not the hash of its content no longer reads,
  and `put()` refuses it. That includes a caller-built snapshot with a
  placeholder hash.

## Boundary

A `fetchImpl` without `arrayBuffer()` cannot report its bytes. Its captures
keep the `text()` body and the `"decoded-utf8"` basis, and a binary
content-type read that way still gets the lossy-capture warning.

The warnings forage's decoder reports (malformed or unknown charset label,
bytes invalid in the chosen encoding) are passed through on
`FetchResult.warnings`, prefixed with the URL.
