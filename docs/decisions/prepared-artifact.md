---
status: current
subject: Prepared artifact
decided: 2026-07-20
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/63
  - kind: doc
    ref: docs/adr/0001-proposals-only.md
  - kind: doc
    ref: docs/decisions/fetch-and-snapshot.md
---

# Prepared artifact

## Decision

Traverse owns the versioned `PreparedArtifact` contract for the exact complete
prepared text from which an extraction result's `chars:<start>-<end>` locators
are derived. The artifact records a content digest, deterministic versioned
reference, preparation mode and implementation version, UTF-16 content length,
and an optional source snapshot reference.

The content digest is SHA-256 of the exact UTF-8 prepared text. The artifact
reference is a separate SHA-256 identity over canonical artifact metadata,
including that digest. Consequently, content, preparation mode/version, or a
source snapshot reference change the artifact identity; equivalent live and
replay preparation of one captured snapshot produces the same identity.

`ExtractionResult.preparedArtifact` carries identity only. It does not include
prepared text, so normal result serialization cannot accidentally duplicate
the full input. An authorized caller that needs exact text injects a
`PreparedArtifactStore` and calls `resolvePreparedArtifact()`. Resolution is
an explicit discriminated result: `available`, `unavailable`, `storage-error`,
`invalid-artifact`, `identity-mismatch`, or `digest-mismatch`. Before any store
access, Traverse validates every artifact field, parses its reference, and
recomputes the canonical identity. After resolution it verifies well-formed
Unicode, content length, and digest. Store throws/rejections are caught and
redacted. A resolver never represents malformed, changed, or missing text as a
grounded success and never passes a malformed reference into a store.

The SHA-256 domain is well-formed Unicode encoded as UTF-8. Artifact creation
rejects lone UTF-16 surrogates in prepared text or identity metadata rather
than allowing the runtime encoder to replace them and collapse distinct input
strings. This fail-closed rule is part of artifact format version 1.

`extract()` creates the artifact after preparation from the same complete text
used to re-anchor every proposal locator, and may write that text to an
injected store. This is additive: ordinary string callers receive a stable
inline preparation identity without configuring a store, while their result
contains no prepared text. Fetch composition supplies its existing snapshot
reference as the optional source snapshot reference and can inject the same
store for capture/replay.
`crawlAndExtract()` applies the same contract to its Forage-owned pages: each
artifact receives the page's existing `sourceRef`, plus the optional injected
prepared-artifact store and preparation version. No crawl or snapshot semantics
are duplicated inside the artifact module.

The recorded preparation mode is the mode actually used, not merely requested.
Transcript cleaning records `transcript`; a successful HTML Markdown path
records `markdown`; and a Markdown conversion/structural failure that degrades
to the established regex path records `text`.

## Boundary

- Traverse owns identity construction, reference parsing, digest verification,
  resolver outcomes, and the in-memory test/single-process store helper.
- Acquisition and durable storage remain caller- or adapter-owned injected
  seams. Traverse does not define a database, retention policy, authorization
  model, or remote object store.
- This contract binds prepared text, not raw source bytes. Snapshot ownership
  and raw-byte replay remain the fetch subpath's existing responsibility.
- Prepared text is never embedded in extraction results by default, fixtures
  use only generic content, and no private runtime configuration is required.
