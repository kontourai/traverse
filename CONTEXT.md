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
  since `0.1.0`. See `docs/decisions/content-preparation.md`.
- **Extraction Provider** (`ExtractionProvider`): a pluggable backend that
  receives prepared content plus the target schema and returns
  `{ proposals, raw }`. The bundled Anthropic adapter (subpath
  `@kontourai/traverse/anthropic`) is one implementation; callers can inject any
  other, including test mocks.
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
  dependency. A source opts in with `SourceConfig.render: true` AND the
  caller configures `FetchSourceOptions.renderImpl` (any renderer —
  Playwright, Puppeteer, a remote rendering service, a test stub); both keys
  are required or `fetchSource` returns a typed `invalid-config` error,
  never a silent normal fetch. `robots.txt` is checked once against the
  requested URL before `renderImpl` ever runs. A successful render becomes a
  normal, replayable `Snapshot` (`contentType: "html"`) carrying an honest
  `rendered: true` marker, so trust surfaces can distinguish wire-HTML from
  rendered-HTML; HTTP validators are skipped for a rendered fetch.
  Composes with `crawlSource` unchanged: `render` is inherited by every
  discovered page alongside `revalidate`/`respectRobots`. See
  [`docs/decisions/rendered-fetch.md`](docs/decisions/rendered-fetch.md).
- **Field Path Normalization**: `extract()`'s recovery rule for a
  provider-emitted `fieldPath` that carries concrete array indices (e.g.
  `"schedules[0].startDate"`) against a `targetSchema` that declares the
  un-indexed form (`"schedules[].startDate"`). The indices are stripped to
  match the declared path, the proposal is accepted under the declared
  `fieldPath`, and the stripped indices are preserved on
  `ExtractionProposal.pathIndices`.
