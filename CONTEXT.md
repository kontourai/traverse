# Traverse Context

Traverse is `@kontourai/traverse`, a schema-directed content-extraction
library. Given prepared content (HTML or text) and a caller-supplied list of
target fields, it asks a pluggable extraction provider to propose field values,
then normalizes those into provenance-bearing proposals shaped for Survey's
producer pipeline. Traverse is a PROPOSER only: it never resolves a value, never
crawls, never ranks, and never owns review policy. Every proposal it emits is a
reviewable record carrying a verbatim excerpt and a locator. Traverse does not
depend on Survey at runtime; it only produces output that maps cleanly onto
Survey's `Extraction`/`RawSource` types (proven by a compile-time compat test).

## Term Glossary

- **Target Field Schema** (`TargetFieldSchema`): a caller-owned description of
  one field to extract — its `path`, `type`, optional `enumValues`,
  `description`, and `required` flag. Traverse defines zero field names itself;
  the schema is 100% supplied by the caller, so no domain vocabulary lives in
  this package.
- **Content Preparation**: the step that turns raw input into extractor-ready
  text. `html` is stripped to text dependency-free; `text` passes through; `pdf`
  is a declared-but-deferred content type that returns a typed error (not yet
  implemented at `0.1.0`).
- **Extraction Provider** (`ExtractionProvider`): a pluggable backend that
  receives prepared content plus the target schema and returns
  `{ proposals, raw }`. The bundled Anthropic adapter (subpath
  `@kontourai/traverse/anthropic`) is one implementation; callers can inject any
  other, including test mocks.
- **Extraction Proposal** (`ExtractionProposal`): one proposed field value with
  a `confidence` in `0..1`, an `extractor` identity string, and required
  `provenance` (`excerpt` and `locator`). This is the whole identity of the
  package — a proposal without provenance is not something Traverse emits.
- **Extraction Result** (`ExtractionResult`): the return of `extract()` —
  normalized `proposals`, the provider's `raw` response for audit, an
  `extractedAt` timestamp, an optional `error` (Traverse never throws for
  provider/parse failure), and optional `warnings` for dropped proposals.
