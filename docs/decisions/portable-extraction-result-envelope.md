---
status: current
subject: Portable extraction-result envelope
decided: 2026-07-20
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/78
  - kind: doc
    ref: src/extraction-result-envelope.ts
  - kind: doc
    ref: tests/portable-envelope.test.ts
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/169
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/166
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/164
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/165
---

# Portable extraction-result envelope

## Decision

Traverse owns version 1 of the `traverse-extraction-result` JSON envelope.
`serializePortableExtractionResult()` canonicalizes a complete
`ExtractionResult`; `deserializePortableExtractionResult()` validates an
untrusted JSON document before returning it; and
`validatePortableExtractionResultEnvelope()` exposes the non-throwing check.
The root exports include explicit `*ExtractionResultEnvelope` aliases for
consumers that prefer the wire-contract name.

`tests/fixtures/portable-extraction-result.v1.json` is a deterministic,
canonical v1 fixture. It is generic test data, contains no prepared text, and
lets a consumer validate the wire shape without a Traverse runtime dependency.

The envelope records source and optional snapshot references, prepared-artifact
identity, proposals with their `chars:` locator and exact-occurrence audit
record, field typing/inference metadata, stable provider/run identity,
model/usage, task and example digests, and typed partial/provider-failure state.
An explicit outcome union distinguishes zero-proposal success from invalid
configuration/task, preparation, provider, unexpected failure, and partial
completion. Warning text becomes deterministic category/code records. Retained
provider, model, failure-provider, and proposal-extractor identities use a
strict credential-free grammar.
Provider failure diagnostics remain in-process only: the portable shape keeps
the provider, class, and retryability, plus the upstream error `code` when it is
a credential-free stable identity of at most 128 characters, without
serializing a message or arbitrary exception object. `kind` stays
authoritative; `code` is informational.
A proposal may carry `producedBy: { model, modelSource, requestDigest }`: the
model that served that proposal's own provider call, whether that identity was
`provider-reported` or `configured`, and a content-free `sha256:` digest of the
request. All three keys are required when `producedBy` is present; a proposal
whose provider did not say where its model identity came from carries no
`producedBy`. `result.model` keeps its meaning (the last successful chunk's
model), so in a multi-chunk run `producedBy.model` is the per-value model. Prepared artifact resolution can be attached as a text-free
typed state (`available`, `unavailable`, `storage-error`, `identity-mismatch`,
`digest-mismatch`, or `invalid-artifact`).
Resolution states carry requested/canonical reference evidence rather than a
second artifact object. Successful, unavailable, storage, and digest states
require exact artifact identity; identity mismatch requires every metadata
field except the requested ref to match the canonical result artifact; invalid
artifact retains its typed reason against that canonical reference.

### Partial reasons and coverage

`outcome: { status: "success" }` means every prepared-text range was read and
answered. A loss on a dispatched chunk makes the outcome `partial` with one of
three reasons besides the early stops (`cancelled`, `max-provider-calls`,
`max-total-tokens`, `max-chunks`): `provider-failure` (the call failed or
returned no extraction tool call), `content-truncated` (the chunk was cut at
`maxContentChars`), or `output-truncated` (the answer stopped at the output
cap). An early stop wins when several apply; otherwise the first loss in
prepared-text order is the reason. `partial.completedChunks` and
`remainingChunks` keep their meaning.

A partial envelope carries `result.coverage`:

```ts
coverage?: Array<{
  chunk: number;   // 1-based; chunks dropped by maxChunks continue the numbering
  start: number;   // prepared-text UTF-16 offsets, the space of chars: locators
  end: number;
  status: "complete" | "unread" | "output-truncated";
  reason?: "provider-failure" | "content-truncated" | "missing-tool-call" | "not-dispatched";
}>
```

Entries are ordered by `start` and may overlap (adjacent chunks share
`chunkOverlap`). An `unread` entry covers exactly the unread span, so a chunk
cut at `maxContentChars` has a `complete` (or other) entry for the sent part and
an `unread`/`content-truncated` entry for the tail. `reason` is present exactly
on `unread` entries. The validator requires `result.preparedArtifact`,
`0 <= start < end <= contentLength`, ascending `start`, and rejects a
non-`complete` entry on a `success` outcome.

The serializer emits `coverage` only on a `partial` outcome. A run that read
everything therefore serializes exactly as it did before coverage existed, and
a reader that predates these fields keeps importing it; such a reader refuses a
lossy envelope instead of reading it as a success.

### Optional confidence

`proposal.confidence` is optional: an uncalibrated provider self-report,
absent when the provider did not report one. When present it must be a finite
number in `0..1`.

Validation is fail-closed: it rejects unknown format versions, unexpected
properties (including symbol, accessor, and non-enumerable properties),
unsupported locators, locator/excerpt UTF-16 length drift, incoherent occurrence
metadata, malformed enums, invalid or mismatched artifact identities, `-0`,
non-finite numbers, sparse arrays, cycles, non-plain objects, and ill-formed Unicode. Canonical key ordering means
a valid envelope deserializes and reserializes to identical bytes. Proposal
identity is not collapsed during serialization: same-value/different-span and
same-span/different-field proposals are retained independently.

## Sanitization boundary

The default envelope never embeds prepared text, artifact-store implementations,
authorization configuration, `raw.response`, result errors/warnings, or
provider failure messages/native objects or embedded raw-source sidecars. Credential-bearing source references
are rejected. Full diagnostics remain available only on the in-process
`ExtractionResult`; there is intentionally no diagnostic-rich portable export.
Candidate values and grounding excerpts are intentional result data, so callers
still apply their domain disclosure policy. Traverse does not interpret,
authorize, review, compare providers, or resolve proposed values through this
format.
