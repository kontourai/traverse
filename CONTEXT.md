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
  text. `html` is stripped to text dependency-free; `text` passes through;
  `pdf` is an **opt-in injected seam** — a caller supplies a small
  `PdfTextExtractor` (`ExtractInput.pdfTextExtractor`) wrapping a parser it
  already owns, and `extract()` runs it and hands the resulting text into the
  existing character-window chunker, unchanged. Traverse ships no default PDF
  parser and takes no new dependency for this. With no extractor supplied,
  `pdf` still returns the original typed not-implemented error, unchanged
  since `0.1.0`. `png`/`jpeg` follow the same opt-in seam pattern through
  `ImageTextExtractor` (`ExtractInput.imageTextExtractor`): Traverse ships no
  OCR dependency, requires caller-supplied bytes, and uses returned OCR text as
  prepared text. See `docs/decisions/content-preparation.md` and
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
  `ocrDerived?: true` is an additive presence marker used only when image OCR
  text was the prepared content, so trust surfaces can distinguish OCR-derived
  excerpts from directly parsed text.
- **Extraction Cost Guard**: `extract()`'s optional
  `ExtractInput.maxProviderCalls` / `maxTotalTokens` ceilings on a single
  run's provider spend. Once a configured ceiling is reached, `extract()`
  stops issuing further `provider.extract()` calls (never mid-call), returns
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
