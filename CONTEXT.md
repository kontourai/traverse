# Traverse Context

Traverse is `@kontourai/traverse`, a schema-directed content-extraction
library. Given prepared content (HTML or text) and a caller-supplied list of
target fields, it asks a pluggable extraction provider to propose field values,
then normalizes those into provenance-bearing proposals shaped for Survey's
producer pipeline. Traverse is a PROPOSER only: the extraction core never
resolves a value, never ranks, and never owns review policy (the opt-in fetch
subpath's `crawlSource` now offers a bounded same-host crawl — see "Crawl
Frontier" below — but extraction itself still never crawls). Every proposal it
emits is a reviewable record carrying a verbatim excerpt and a locator. Traverse
does not depend on Survey at runtime; it only produces output that maps cleanly
onto Survey's `Extraction`/`RawSource` types (proven by a compile-time compat
test).

## Term Glossary

- **Target Field Schema** (`TargetFieldSchema`): a caller-owned description of
  one field to extract — its `path`, `type`, optional `enumValues`,
  `description`, and `required` flag. Traverse defines zero field names itself;
  the schema is 100% supplied by the caller, so no domain vocabulary lives in
  this package. An optional `inferenceType?: "explicit" | "inferred"` further
  classifies grounding honesty — `"explicit"` means the value should appear
  verbatim in the source (offset-verification of the value itself would be
  meaningful); `"inferred"` means the value is derived/normalized from the
  source (only the excerpt is offset-groundable, never the value). Additive
  and 100% optional; see `docs/decisions/extraction-proposals.md`.
- **Content Preparation**: the step that turns raw input into extractor-ready
  text. `html` defaults to structure-preserving Markdown preparation using the
  declared `linkedom` and `turndown` runtime dependencies; `text` passes
  through. The core bundles no AI-provider SDK (provider SDKs are optional peer
  dependencies behind provider-specific subpaths). `pdf` is an **opt-in injected
  seam** — a caller supplies a small
  `PdfTextExtractor` (`ExtractInput.pdfTextExtractor`) wrapping a parser it
  already owns, and `extract()` runs it and hands the resulting text into the
  existing character-window chunker, unchanged. Traverse ships no default PDF
  parser or additional PDF dependency. With no extractor supplied, `pdf` still
  returns the original typed not-implemented error, unchanged since `0.1.0`.
  `png`/`jpeg` follow the same opt-in seam pattern through
  `ImageTextExtractor` (`ExtractInput.imageTextExtractor`): Traverse ships no
  OCR implementation, requires caller-supplied bytes, and uses returned OCR
  text as prepared text. PDF/OCR and browser/render implementations remain
  caller-injected seams; none is bundled. See
  `docs/decisions/content-preparation.md` and
  `docs/decisions/image-content-preparation.md`.
- **Extraction Provider** (`ExtractionProvider`): a pluggable backend that
  receives prepared content plus the target schema and returns
  `{ proposals, raw }`. Bundled adapters live behind provider-specific subpaths
  and declare a shared capability contract. The core checks declared required
  capabilities before paid work, normalizes retryable/terminal failures while
  retaining native diagnostics, and applies identical proposal semantics after
  every adapter. Callers can still inject legacy custom providers without a
  capability declaration.
- **Extraction Proposal** (`ExtractionProposal`): one proposed field value with
  a `confidence` in `0..1`, an `extractor` identity string, and required
  `provenance` (`excerpt` and `locator`). This is the whole identity of the
  package — a proposal without provenance is not something Traverse emits.
  Carries `inferenceType` through from the matched `TargetFieldSchema` entry
  when that entry declared it (absent otherwise), mirroring the `pathIndices`
  conditional-attach idiom.
- **Extraction Result** (`ExtractionResult`): the return of `extract()` —
  normalized `proposals`, the provider's `raw` response for audit, an
  `extractedAt` timestamp, an optional `error` (Traverse never throws for
  provider/parse failure), and optional `warnings` for dropped proposals.
  Every result also carries a stable top-level provider identity, source
  reference, and opaque per-run identity, including zero-proposal successes and
  early failures.
  For parser-supplied PDF content, optional `pdfLayout` carries validated page
  geometry, typed text elements, and structured table cells. Every region maps
  back to the exact prepared text through UTF-16 ranges, so it enriches rather
  than replaces proposal `chars:` locators.
  `ocrDerived?: true` is an additive presence marker used only when image OCR
  text was the prepared content, so trust surfaces can distinguish OCR-derived
  excerpts from directly parsed text.
- **Portable Extraction-Result Envelope** (`PortableExtractionResultEnvelope`):
  Traverse's versioned, canonical JSON-safe projection of a complete result.
  It retains provider/run/model/usage identity, source and prepared-artifact
  identity, exact locator/occurrence records, field metadata, task digests, and
  typed outcome, warning classification, partial/provider/artifact states. Its
  artifact resolution projection binds a requested reference to the canonical
  result-artifact reference without embedding a second contradictory artifact.
  The default projection omits prepared
  text, embedded raw-source sidecars, and diagnostic strings (`raw.response`, errors, warnings, failure
  messages/native objects) and rejects credential-bearing source references.
  Validation rejects unknown versions, unsupported locator or occurrence
  semantics, non-lossless JSON objects, and artifact-state identity drift before
  a consumer treats the record as grounded. See
  [`docs/decisions/portable-extraction-result-envelope.md`](docs/decisions/portable-extraction-result-envelope.md).
- **Prepared Artifact** (`PreparedArtifact`): Traverse's versioned identity
  for the exact complete prepared text behind an extraction result's
  `chars:<start>-<end>` locators. It carries a SHA-256 text digest,
  deterministic reference, preparation mode/version, UTF-16 content length,
  and optional source snapshot reference — never the text itself. An
  authorized caller resolves text through an injected `PreparedArtifactStore`,
  whose typed outcomes distinguish available, unavailable, storage-error,
  invalid-artifact, identity-mismatch, and digest-mismatch. Artifact and
  resolved-text strings must be well-formed Unicode, and preparation mode
  records the path actually used (including transcript cleanup or HTML's text
  fallback). See
  [`docs/decisions/prepared-artifact.md`](docs/decisions/prepared-artifact.md).
- **Format-specific Locator Profile**: the documented replay boundary for one
  preparation format. Every profile keeps a proposal's `chars:<start>-<end>`
  locator anchored only to its complete prepared artifact; it may expose an
  existing, replayable format sidecar but does not imply a universal mapping
  back to raw source offsets. HTML has no DOM-path profile, PDF's existing
  `pdfPageOffsets` sidecar resolves a character offset to a page, and OCR's
  `ocrDerived` marker identifies the prepared-text origin. See
  [`docs/decisions/format-specific-raw-source-locator-profiles.md`](docs/decisions/format-specific-raw-source-locator-profiles.md).
- **Extraction Cost Guard**: `extract()`'s optional
  `ExtractInput.maxProviderCalls` / `maxTotalTokens` ceilings on a single
  run's provider spend. Once a configured ceiling is reached, `extract()`
  stops issuing further physical provider operations (`provider.extract()` or
  optional `provider.extractBatch()`, never mid-call), returns
  the proposals already collected, and records a warning naming which
  ceiling fired and how much was consumed — mirroring the `maxChunks`
  truncation precedent, never throwing. Accumulated spend
  (`ExtractionResult.providerCalls` / `totalTokensUsed`) is always surfaced,
  even with no ceiling configured. Token accounting degrades gracefully for a
  provider that does not report `raw.tokensUsed` — the call-count ceiling
  still works; the token ceiling simply never fires.
- **Fetch and Snapshot**: the `@kontourai/traverse/fetch` subpath's
  standalone-first capability for getting content in the first place —
  configurable single-page fetch (`fetchSource`) plus snapshot capture for
  byte-identical replay (`replaySource`), composed with `extract()` via
  `fetchAndExtract`. Distinct vocabulary from extraction (`SourceConfig`,
  `Snapshot`, `SnapshotStore`, `FetchResult`) kept out of the package root so a
  caller who only extracts imports nothing from it.
- **Crawl Frontier**: the `@kontourai/traverse/fetch` subpath's opt-in, bounded
  same-host BFS link-following (`crawlSource`, returning a `CrawlManifest` of
  per-page `CrawlPageOutcome`s). A thin driver over `fetchSource`/
  `replaySource` — no separate HTTP/robots/politeness implementation — that
  stops at `maxPages`/`maxDepth` and never crosses origins. Fetch-layer only
  (no `extract()` composition); see
  [`docs/decisions/crawl-frontier.md`](docs/decisions/crawl-frontier.md) for
  the query-handling and replay-semantics decisions.
- **Rendered Fetch**: the `@kontourai/traverse/fetch` subpath's opt-in seam
  for ingesting SPA/JS-rendered pages without traverse core taking a browser
  dependency. `SourceConfig.renderPolicy` selects `never` (one plain
  attempt), `always` (one rendered attempt), or `on-shell-warning` (one plain
  attempt and at most one rendered retry for the exact pure
  `js-shell-suspected:` prefix). The embedded-state-available shell warning
  does not escalate. The deprecated `render` key maps `true` to `always` and
  false/absent to `never`; semantically conflicting keys return typed
  `invalid-config`. The caller injects and owns the cost/lifecycle of
  `FetchSourceOptions.renderImpl`; Traverse owns attempt selection. Rendered
  attempts never receive revalidation state or validators. A successful
  rendered snapshot wins, while an on-warning render failure/unavailable
  renderer falls back to the plain snapshot with typed `renderEscalation`
  audit metadata. Only the selected result reaches extraction/capture, and
  discarded-attempt warnings are not merged into its extraction-facing
  warnings. This is an additive minor boundary; consumer migrations remain
  follow-up work. Composes with `crawlSource` unchanged. See
  [`docs/decisions/rendered-fetch.md`](docs/decisions/rendered-fetch.md).
- **Binary Snapshot Body** (`Snapshot.bodyBytes`): raw response bytes captured
  for binary-classified content types (`pdf`, `png`, `jpeg`) instead of lossy
  UTF-8 text. Presence of `bodyBytes` is the binary marker; `Snapshot.body`
  stays `""` and `bodyHash` hashes the raw bytes. This is what lets
  `fetchAndExtract()` pass fetched PDF/image snapshots into caller-supplied
  text-extractor seams.
- **Field Path Normalization**: `extract()`'s recovery rule for a
  provider-emitted `fieldPath` that carries concrete array indices (e.g.
  `"schedules[0].startDate"`) against a `targetSchema` that declares the
  un-indexed form (`"schedules[].startDate"`). The indices are stripped to
  match the declared path, the proposal is accepted under the declared
  `fieldPath`, and the stripped indices are preserved on
  `ExtractionProposal.pathIndices`.
- **Exact Occurrence Resolution**: `extract()`'s provenance step that
  binds an excerpt to exact spans inside the provider-visible prepared-text
  slice, then chooses an in-bounds local hint or deterministic source order and
  maps the selection into complete-artifact occurrence metadata.
  The resulting `provenance.occurrence` metadata records version, count,
  selected span, selection mode, hint use, and ambiguity. It never assigns a
  `chars:` locator from fuzzy or paraphrased evidence; see
  [`docs/decisions/exact-occurrence-resolution.md`](docs/decisions/exact-occurrence-resolution.md).
