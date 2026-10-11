# Reference

The public surface of `@kontourai/traverse`: its package entry points, the
`extract()` options and result, the provider contract, the bundled adapters,
and the fetch subpath. Traverse is a library; it ships no CLI. For behavior in
depth, follow the links into the [README](../README.md) and the
[decision records](decisions/index.md).

## Package entry points

Each subpath is a separate import. The package root never re-exports an
adapter or the fetch surface, so you pay only for what you import.

| Import | Contents | Extra install |
| --- | --- | --- |
| `@kontourai/traverse` | `extract()`, content preparation, chunking, prepared artifacts, the portable envelope, task specs, and all core types | none |
| `@kontourai/traverse/anthropic` | `createAnthropicExtractionProvider()` | `@anthropic-ai/sdk` |
| `@kontourai/traverse/openai` | `createOpenAIExtractionProvider()` | `openai` |
| `@kontourai/traverse/gemini` | `createGeminiExtractionProvider()` | `@google/genai` |
| `@kontourai/traverse/relay` | `createRelayExtractionProvider()` | `@kontourai/relay` |
| `@kontourai/traverse/fetch` | `fetchSource()`, snapshot stores, `replaySource()`, `fetchAndExtract()`, `crawlSource()`, `crawlAndExtract()`, `fetchYouTube()`, robots helpers | none (`yt-dlp` on `PATH` for `fetchYouTube()`) |

The package needs Node.js 22 or newer.

## extract()

```ts
extract(input: ExtractInput): Promise<ExtractionResult>
```

`extract()` prepares the content, chunks it, calls the provider for each chunk,
and normalizes the proposals. It does not throw for provider, parse, or
content-preparation failures; it sets `result.error` instead.

Required input:

| Field | Type | Meaning |
| --- | --- | --- |
| `content` | `string \| Uint8Array` | The source. Bytes are required for `pdf`, `png`, and `jpeg`. |
| `contentType` | `"html" \| "text" \| "transcript" \| "pdf" \| "png" \| "jpeg"` | How to prepare `content`. `transcript` is WebVTT. |
| `sourceRef` | `string` | Your stable identifier for the source, carried onto the result. |
| `targetSchema` | `TargetFieldSchema[]` | The fields to propose. See [below](#targetfieldschema). |
| `provider` | `ExtractionProvider` | The backend that proposes values. |

Optional input:

| Field | Default | Meaning |
| --- | --- | --- |
| `prep` | `"markdown"` for HTML | `"text"` selects the legacy flat-text strip. |
| `chunkSize` | `12_000` | Target maximum characters per chunk. |
| `chunkOverlap` | `200` | Overlap between character-window chunks. |
| `maxChunks` | `40` | Chunks beyond this are dropped with a warning. |
| `maxContentChars` | `32_000` | Per-chunk content budget; each chunk is cut to it. |
| `concurrency` | `1` | Provider calls in flight, capped by the provider's declared limit. |
| `batchSize` | `1` | Chunks per `extractBatch()` call, when the provider has one. |
| `signal` | none | An `AbortSignal` that stops new waves from dispatching. |
| `maxProviderCalls` | unbounded | Stop issuing provider calls after this many. |
| `maxTotalTokens` | unbounded | Stop issuing provider calls once reported tokens reach this. |
| `fieldHints` | none | Per-field hint strings passed to the provider. |
| `taskSpec` | none | A validated `ExtractionTaskSpec` from `createExtractionTaskSpec()`. |
| `preparedArtifact` | none | `{ store?, sourceSnapshotRef?, preparationVersion? }` to retain and identify the prepared text. |
| `pdfTextExtractor` | none | Your PDF parser, required for `contentType: "pdf"`. |
| `imageTextExtractor` | none | Your OCR, required for `png` and `jpeg`. |

## TargetFieldSchema

| Field | Meaning |
| --- | --- |
| `path` | Dot and bracket path such as `pricing[].amount`. Its meaning is yours. |
| `type` | `"string" \| "number" \| "boolean" \| "date" \| "enum" \| "array" \| "object"` |
| `enumValues` | Allowed values for an `enum` field. |
| `description` | Field guidance for the provider prompt. |
| `required` | Marks a field the source is expected to contain. |
| `inferenceType` | `"explicit"` when the value should appear verbatim, `"inferred"` when it is derived. |

## ExtractionResult

| Field | Meaning |
| --- | --- |
| `proposals` | Normalized `ExtractionProposal[]`. |
| `provider`, `runId`, `sourceRef` | Provider identity, an opaque per-run id, and your source id. |
| `raw` | The provider's raw response, for audit. In a multi-chunk run, the last successful chunk's. |
| `extractedAt` | Timestamp of the run. |
| `error` | Set when a stage failed. |
| `warnings` | Normalization notes plus provider warnings. |
| `providerCalls`, `totalTokensUsed` | Spend for this run. Always present. |
| `partial`, `coverage` | Present when some prepared text was not read or not fully answered. |
| `providerFailures` | Normalized failures with `kind`, `retryable`, and the native error. |
| `taskDigest`, `exampleDigests` | Present when a `taskSpec` was used. |
| `preparedArtifact` | Identity of the prepared text behind every locator. |
| `embedded` | JSON-LD, `__NEXT_DATA__`, and hydration state harvested from HTML. |
| `pdfPageOffsets`, `pdfLayout` | PDF sidecars from your extractor. |
| `ocrDerived` | `true` when the prepared text came from OCR. |

## ExtractionProposal

| Field | Meaning |
| --- | --- |
| `fieldPath` | A path declared in `targetSchema`. |
| `candidateValue` | The proposed value. |
| `provenance.excerpt` | Verbatim quote from the prepared text. |
| `provenance.locator` | `chars:<start>-<end>`, 0-based UTF-16 offsets into the prepared text, derived by `extract()`. |
| `provenance.occurrence` | How the excerpt's exact occurrence was chosen, and whether it was ambiguous. |
| `extractor` | The provider identity, for example `anthropic-extraction-provider:claude-sonnet-4-6`. |
| `confidence` | Optional provider self-report, clamped to `0..1`. Not calibrated. |
| `pathIndices` | Array indices stripped from an indexed path such as `items[2].name`. |
| `inferenceType`, `valueType`, `enumValues` | Copied from the matching schema field. |
| `evidenceMatch` | Deterministic `schema`, `valueInExcerpt`, and `tokenBoundary` checks. |
| `producedBy` | The model that served this proposal's own provider call. |
| `valueNormalization` | `{ kind, from }`, present only when `extract()` rewrote the provider's value losslessly: `string-to-number` (`"2.1"` to `2.1`) or `date-to-iso` (`"21 March 2013"` to `"2013-03-21"`). `from` is the original string. The portable envelope does not carry it. |
| `occurrenceHint` | Input only. A provider may return a 1-based hint for which exact match its excerpt means. It is used only when it is an integer within the matches in the provider's chunk, and `extract()` never copies it to its output; read `provenance.occurrence` for the selection made. |

The rules that decide which proposals survive are in
[Normalization semantics](../README.md#normalization-semantics).

## Core helpers

All from `@kontourai/traverse`:

| Function | Purpose |
| --- | --- |
| `prepareContent(content, contentType, maxChars?, prep?)` | Prepare content the way `extract()` does. Returns `{ text?, error?, embedded?, warnings? }`. |
| `htmlToMarkdown()`, `htmlToText()`, `vttToText()` | The individual preparation steps. |
| `preparePdfText()`, `prepareImageText()` | Run a PDF or OCR extractor standalone. |
| `prepareAndChunk()` | Prepare and split content into chunks. |
| `DEFAULT_CHUNK_SIZE`, `DEFAULT_CHUNK_OVERLAP`, `DEFAULT_MAX_CHUNKS` | The chunking defaults: `12_000`, `200`, and `40`. |
| `resolvePdfPage(pdfPageOffsets, offset)` | Map a locator offset to a 1-based PDF page. |
| `resolvePdfLayoutSpan(pdfLayout, locator)` | Find the PDF layout elements and table cells a locator overlaps. |
| `harvestEmbeddedState()`, `detectJsShell()`, `inspectHtml()` | Embedded-state harvest and shell detection. |
| `createInMemoryPreparedArtifactStore()` | An in-memory `PreparedArtifactStore` to pass as `preparedArtifact.store`. |
| `resolvePreparedArtifact(artifact, store)` | Validate an artifact and fetch its text. Returns a typed status: `available`, `unavailable`, `storage-error`, `invalid-artifact`, `identity-mismatch`, or `digest-mismatch`. |
| `createPreparedArtifact(text, options)` | Build an artifact identity for prepared text. Throws on ill-formed Unicode or an invalid preparation mode. |
| `validatePreparedArtifact(input)`, `parsePreparedArtifactRef(ref)` | Check an artifact's fields, and parse a `traverse-prepared-artifact:v1:sha256:<hex>` reference. |
| `preparationVersionFor(mode)` | The preparation version `extract()` would record for a mode, for keying a cache. |
| `isWellFormedUnicode(text)` | The Unicode check artifacts apply. |
| `serializePortableExtractionResult()`, `deserializePortableExtractionResult()`, `validatePortableExtractionResultEnvelope()` | The versioned JSON envelope for moving a result between processes. |
| `createExtractionTaskSpec()`, `validateExtractionTaskSpec()` | Versioned guidance and few-shot examples. |
| `enumerateExactOccurrences()`, `sameResolvedOccurrence()` | Exact-occurrence lookup and comparison. |
| `normalizeProviderFailure(provider, error)` | Classify a thrown provider error into an `ExtractionProviderFailure` (`kind`, `retryable`, optional `code`) and keep the native error. |
| `unsupportedProviderCapability(input)` | The first required capability the input's provider does not declare, or `undefined`. A provider without a `capabilities` declaration is not checked. |
| `EXTRACTION_CONFORMANCE_CAPABILITIES` | The capability declaration the bundled adapters use. |

## Provider contract

A provider is any object with this shape:

```ts
interface ExtractionProvider {
  name: string;
  capabilities?: ExtractionProviderCapabilities;
  extract(input: ProviderExtractionInput): Promise<ProviderExtractionOutput>;
  extractBatch?(inputs: ProviderExtractionInput[]): Promise<ProviderExtractionBatchOutcome[]>;
}
```

`extract()` hands each call one chunk of prepared text, the target schema, and
any field hints or task spec. The provider returns `{ proposals, raw }` and may
add `warnings`. It can flag lost output with `truncated`, `missingToolCall`, or
`unusable`. A `locator` the provider sets is provisional; `extract()` replaces
it.

`capabilities.supported` lists any of `structured-output`, `exact-excerpts`,
`task-specifications`, `usage`, and `warnings`. `maxConcurrency` and
`maxBatchSize` cap `concurrency` and `batchSize`. An unsupported capability
that the run needs fails before any provider call: `structured-output` and `exact-excerpts` always, and `task-specifications` when a `taskSpec` is given. See the
[provider conformance decision](decisions/provider-conformance.md).

## Provider adapters

| Factory | Default model | Key fallback | Options |
| --- | --- | --- | --- |
| `createAnthropicExtractionProvider()` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` | `client`, `apiKey`, `model`, `maxTokens` (2048), `baseUrl`, `maxRetries` (0) |
| `createOpenAIExtractionProvider()` | `gpt-4.1-mini` | `OPENAI_API_KEY` | `client`, `apiKey`, `model`, `maxTokens` (2048), `baseUrl`, `maxRetries` (0) |
| `createGeminiExtractionProvider()` | `gemini-2.5-flash` | `GEMINI_API_KEY` | `client`, `apiKey`, `model`, `maxTokens` (2048) |
| `createRelayExtractionProvider()` | from the runtime | none | `runtime` (required), `maxTokens` (2048), `name` |

Every bundled adapter builds the extraction tool from your `targetSchema`, asks
for a verbatim excerpt per field, and passes the shared conformance suite.
`maxRetries` defaults to 0 so one counted call is one request. Details:
[Anthropic adapter](../README.md#anthropic-adapter) and
[additional adapters](../README.md#provider-conformance-and-additional-adapters).

## Fetch subpath

All from `@kontourai/traverse/fetch`. None of these throws for an operational
failure; errors come back as a typed `FetchError` with a `kind`.

| Function | Purpose |
| --- | --- |
| `fetchSource(config, opts?)` | Fetch one URL with robots, politeness, timeout, and retries. Returns a `Snapshot` or an error. |
| `createFilesystemSnapshotStore({ root })`, `createInMemorySnapshotStore()` | Snapshot stores. |
| `replaySource(store, sourceId)` | Return the latest stored snapshot in the same shape as a live fetch. |
| `fetchAndExtract(config, opts)` | Fetch (`live`, `replay`, or `live-with-capture`) and extract, with a snapshot-anchored `sourceRef`. |
| `buildSnapshotSourceRef(snapshot)` | Build the `traverse-snapshot:<id>?url=…&sha256=…&fetchedAt=…` reference that `fetchAndExtract()` uses. |
| `parseSnapshotSourceRef(ref)` | Parse a `traverse-snapshot:` reference back into `{ sourceId, url, bodyHash, fetchedAt }`. |
| `isSameSnapshotRef(a, b)`, `parseAnySnapshotSourceRef(ref)` | Compare or parse references in either the `traverse-snapshot:` or Forage scheme. Use `isSameSnapshotRef` instead of `===`, because the same capture can be named in both schemes. |
| `resolveContentType(hint, header)` | The `ContentType` for a response. The hint wins; otherwise HTML, PDF, PNG, and JPEG are detected from the `Content-Type` header, and anything else is `text`. |
| `snapshotHashBasis(snapshot)` | Whether a snapshot's `bodyHash` covers raw `bytes` or `decoded-utf8` text. |
| `toForageSourceConfig(config, policy)`, `toForageFetchOptions(options)` | Translate a Traverse source config and fetch options into Forage's shapes. |
| `crawlSource(seed, opts?)` | Bounded same-host breadth-first crawl. `maxPages` defaults to 20 (at most 500); `maxDepth` to 2 (at most 10). |
| `crawlAndExtract(seed, opts)` | Crawl with Forage and extract every page. |
| `fetchYouTube(config, opts?)` | Captions and metadata through `yt-dlp`, as a `transcript` snapshot. |
| `parseYouTubeUrl(input)` | Parse a YouTube URL into `{ videoId, canonicalUrl }` and an optional `timestampSeconds`, or `undefined`. Tracking parameters are dropped. |
| `parseRobots(text, userAgent)`, `isPathAllowed(rules, pathname)` | The robots.txt matcher `fetchSource()` uses. |

`fetchSource()` defaults: 1,000 ms minimum delay per host, 15,000 ms timeout,
2 retries (at most 5), at most 5 redirects, and robots.txt respected. Error
kinds are `timeout`, `network`, `http-error`, `robots-denied`,
`too-many-redirects`, `invalid-url`, `invalid-config`, `no-snapshot`,
`dependency-missing`, and `adapter-error`. See
[Fetching & snapshots](../README.md#fetching--snapshots-kontouraitraversefetch).

## Integration with other Kontour products

- **Survey.** Traverse's proposals map onto Survey's `Extraction` and
  `RawSource` shapes; `sourceRef` maps to `RawSource.sourceRef` and the excerpt
  to `Extraction.excerpt`. Traverse has no runtime dependency on Survey. A
  compile-time fixture, `tests/type-fixtures/survey-shape-compat.ts`, checks
  the mapping.
- **Forage.** The fetch subpath sends its requests through Forage's
  SSRF-guarded egress by default, and `crawlAndExtract()` uses Forage's crawl
  frontier. Only `crawlAndExtract()` produces Forage snapshot references
  (`forage-snapshot:`); `fetchAndExtract()` produces `traverse-snapshot:`
  references. `isSameSnapshotRef()` compares the two.
- **Relay.** `@kontourai/traverse/relay` accepts any Relay `ModelRuntime`.
  Routing, budgets, fallbacks, and receipts belong to the runtime; Traverse
  keeps the prompt, tool schema, parsing, and provenance rules.
