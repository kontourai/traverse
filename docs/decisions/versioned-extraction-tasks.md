---
status: current
subject: Versioned extraction tasks
decided: 2026-07-19
evidence:
  - kind: doc
    ref: src/task.ts
  - kind: doc
    ref: tests/task-spec.test.ts
---

# Versioned extraction tasks

## Decision

Traverse supports an optional, provider-neutral `ExtractionTaskSpec` alongside
the existing required `targetSchema`. A task contains a version, the same field
schema, optional caller guidance, validated grounded examples, and deterministic
SHA-256 digests. `createExtractionTaskSpec()` is the canonical constructor.

Before content preparation or a provider call, `extract()` verifies the task
digest, exact schema identity, every example digest, declared field paths,
candidate value types and enum membership, and verbatim excerpts against the
example's prepared content. Invalid tasks return the normal typed error result
with `providerCalls: 0`.

Validated tasks pass through the provider interface without naming or requiring
a provider. Results record `taskDigest` and ordered `exampleDigests`, allowing a
consumer to audit which instructions produced proposals without copying the
task into every proposal. The bundled adapter uses guidance and demonstrations
only when a task is present.

## Compatibility boundary

`targetSchema` remains required and authoritative. A task's schema must match it
exactly, preventing two competing schemas while keeping every schema-only caller
source- and behavior-compatible. Task fields and result digest fields are
optional; schema-only provider request and result shapes do not gain undefined
properties.

## Consequences

- Digests identify canonical task bytes, not provider, model, or execution
  configuration. Those concerns belong to execution provenance and evaluation.
- Examples are proposals with exact excerpts, not accepted facts or decisions.
- Binary examples are excluded. PDF and image preparation require injected,
  potentially asynchronous extractors and are not portable task fixtures.
