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
the provider, class, and retryability without serializing a message or arbitrary
exception object. Prepared artifact resolution can be attached as a text-free
typed state (`available`, `unavailable`, `storage-error`, `identity-mismatch`,
`digest-mismatch`, or `invalid-artifact`).
Resolution states carry requested/canonical reference evidence rather than a
second artifact object. Successful, unavailable, storage, and digest states
require exact artifact identity; identity mismatch requires every metadata
field except the requested ref to match the canonical result artifact; invalid
artifact retains its typed reason against that canonical reference.

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
