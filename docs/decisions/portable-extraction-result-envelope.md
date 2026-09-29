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
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/170
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/183
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/187
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
model), so in a multi-chunk run `producedBy.model` is the per-value model.
A proposal may carry `evidenceMatch: { checkerVersion, schema, valueInExcerpt,
tokenBoundary? }`, the deterministic schema and value-in-excerpt annotations
defined in `extraction-proposals.md`. The validator requires the first three
keys when the object is present, requires `checkerVersion` to be a stable
identity, checks `schema` against `ok`/`type-mismatch`/`enum-mismatch`/
`format-invalid` and `valueInExcerpt` against `match`/`mismatch`/
`not-evaluated`/`not-applicable`, requires `tokenBoundary` to be a boolean
when present, and rejects other keys. `schema` and `valueInExcerpt` are pure
functions of the proposal's `candidateValue`, `valueType`, `enumValues`,
`inferenceType` and excerpt, so the validator recomputes both and rejects a
record that disagrees (for example `match` on an `inferred` or `array` field,
or `schema: "ok"` on a string declared `number`). A proposal with
`evidenceMatch` must therefore carry `valueType`, and `checkerVersion` must be
the version this Traverse release computes (`evidence-match-v4`); a reader
cannot check rules it does not know. `tokenBoundary` depends on the prepared
text around the excerpt, which the envelope does not carry, so only its type
is checked. It is a set of facts, not a trust
state. Prepared artifact resolution can be attached as a text-free
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
on `unread` entries. An answer core cannot use (a tool call with no proposals
array or only malformed items, a `proposals` value that is not an array, an
output that is not an object, or normalization that threw) is
`unread`/`provider-failure`, like a failed call, with a located
`provider answer unusable` warning (code `unusable-answer`). Some malformed
items beside usable ones are per-proposal drops (`proposal-normalization`),
not a lost chunk; the chunk also gets one located
`dropped k of n tool items as malformed` warning (code
`normalization`/`malformed-tool-items`) so a consumer can apply a threshold.

When no dispatched chunk was answered, the run is a failure, as when every
call throws: `provider`/`provider-failure` if any call threw, otherwise
`provider`/`no-usable-answer`. (An early stop still takes precedence and makes
it `partial`, as before.) `partial.completedChunks` keeps its 1.0.0 meaning:
dispatched chunks whose provider work finished, answered or not; coverage says
which were answered.

Two combinations follow from those rules and are stated here so an
envelope-only reader can recognise them:

- **Early stop and nothing answered.** When a stop (`cancelled`,
  `max-provider-calls`, `max-total-tokens`) coincides with every dispatched
  chunk being unanswered, the in-process result sets `error`, but the envelope
  reports `partial` with the stop's reason and no failure, because an early
  stop wins. The envelope says nothing was answered only through coverage:
  every dispatched range is `unread` (`provider-failure` or
  `missing-tool-call`), a dispatched chunk cut at `maxContentChars` also has
  an `unread`/`content-truncated` tail, the undispatched rest is
  `unread`/`not-dispatched`, and the warning codes include
  `chunk-provider-failure`, `missing-tool-call` or `unusable-answer`.
  A reader that needs "was anything answered" should check coverage for a
  `complete` or `output-truncated` entry rather than rely on the outcome.
- **`maxChunks` truncation and nothing answered.** `max-chunks` is not an
  early stop (the capped chunks were never going to be dispatched), so the
  run is `failure` with `provider`/`provider-failure` or
  `provider`/`no-usable-answer`. The in-process result's `coverage` lists the
  capped chunks' ranges (when their text is in the prepared artifact) as
  `unread`/`not-dispatched`. The envelope does not: the serializer emits
  coverage only on a `partial` outcome and a failure has no `partial` reason.
  The run still writes the `dropped N chunks beyond maxChunks` warning, so an
  envelope-only reader learns the run was also capped from the `limit`/
  `content-truncated` warning classification.

Coverage describes the prepared text only. Structural chunking drops a whole
outside-text segment beyond `maxChunks` before the prepared text is built, so
that text has no range: only `partial.reason: "max-chunks"` records the loss.
Coverage of a success outcome is therefore not required to span
`[0, contentLength)`; structural segments are also joined by two-character
separators that no chunk covers.

The validator requires `result.preparedArtifact`,
`0 <= start < end <= contentLength`, ascending `start`, and at most one entry
per chunk except a sent part followed by its `unread`/`content-truncated` tail
starting where the sent part ends. It rejects a non-`complete` entry on a
`success` outcome, and a loss reason (`provider-failure`, `content-truncated`,
`output-truncated`) without a non-`complete` entry for a dispatched chunk (one
whose reason is not `not-dispatched`). A never-dispatched range cannot have a
`content-truncated` tail.

The `output-truncated` and `missing-tool-call` warning codes are given only to
the chunk-located warning `extract()` writes when it records that loss, so they
never appear beside an outcome that ignores it.

The serializer emits `coverage` only on a `partial` outcome. A run that read
everything therefore serializes exactly as it did before coverage existed, and
a reader that predates these fields keeps importing it; such a reader refuses a
lossy envelope instead of reading it as a success.

### Adding optional proposal keys

`producedBy` and `evidenceMatch` were added to version 1 as optional keys, and
a writer omits each when it has nothing to say, so an envelope without them
reads exactly as before. The validator is fail-closed, so a reader that
predates a key rejects an envelope carrying it with an explicit
unexpected-property error rather than dropping the key or misreading it. For
`evidenceMatch`: `@kontourai/traverse` 2.0.0 and earlier, and
`@kontourai/survey` 3.x and earlier, reject it; `@kontourai/survey` 4.0.0,
5.0.0 and 6.0.0 accept it with the same key set and enums. Because `extract()` sets it on
every proposal, an envelope with at least one proposal from this version no
longer imports into those older readers; a producer must upgrade its readers
first. The format version stays 1 because no existing field changed meaning.

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
