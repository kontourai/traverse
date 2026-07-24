/**
 * @kontourai/traverse public entry point.
 *
 * Exports the top-level `extract()` orchestration, content-prep helpers, and all
 * core types. The Anthropic adapter is deliberately NOT exported here — it lives
 * behind the `@kontourai/traverse/anthropic` subpath so consumers without
 * @anthropic-ai/sdk pay nothing.
 */

export { extract } from "./extract.js";
export {
  PORTABLE_EXTRACTION_RESULT_ENVELOPE_FORMAT,
  PORTABLE_EXTRACTION_RESULT_ENVELOPE_VERSION,
  toPortablePreparedArtifactState,
  serializePortableExtractionResult,
  deserializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
  serializeExtractionResultEnvelope,
  deserializeExtractionResultEnvelope,
  validateExtractionResultEnvelope,
} from "./extraction-result-envelope.js";
export type {
  PortableExtractionSource,
  PortableExtractionProposal,
  PortableExtractionProviderFailure,
  PortableRawProviderResponse,
  PortableExtractionOutcome,
  PortableExtractionWarning,
  PortablePreparedArtifactState,
  PortableExtractionResult,
  PortableExtractionResultEnvelope,
  PortableExtractionResultOptions,
  PortableExtractionResultEnvelopeValidation,
} from "./extraction-result-envelope.js";
export {
  EXACT_OCCURRENCE_RESOLVER_VERSION,
  enumerateExactOccurrences,
  ExactOccurrenceResolver,
} from "./occurrence-resolver.js";
export type {
  ExactOccurrence,
  ExactOccurrenceResolution,
  ResolveExactOccurrenceInput,
} from "./occurrence-resolver.js";
export {
  PREPARED_ARTIFACT_FORMAT,
  PREPARED_ARTIFACT_VERSION,
  PREPARED_ARTIFACT_PREPARATION_VERSION,
  createPreparedArtifact,
  parsePreparedArtifactRef,
  validatePreparedArtifact,
  resolvePreparedArtifact,
  createInMemoryPreparedArtifactStore,
  isWellFormedUnicode,
} from "./prepared-artifact.js";
export type {
  PreparedArtifact,
  PreparedArtifactRef,
  PreparedArtifactOptions,
  PreparedArtifactPreparationMode,
  PreparedArtifactStore,
  PreparedArtifactResolution,
  PreparedArtifactValidation,
  PreparedArtifactInvalidReason,
  ParsedPreparedArtifactRef,
} from "./prepared-artifact.js";
export { createExtractionTaskSpec, validateExtractionTaskSpec } from "./task.js";
export {
  EXTRACTION_CONFORMANCE_CAPABILITIES,
  unsupportedProviderCapability,
  normalizeProviderFailure,
} from "./provider-conformance.js";
export {
  prepareContent,
  htmlToText,
  htmlToMarkdown,
  vttToText,
  preparePdfText,
  prepareImageText,
  resolvePdfPage,
  imageBytesRequiredError,
  type PrepMode,
} from "./content-prep.js";
export {
  resolvePdfLayoutSpan,
  type PdfLayoutSpanResolution,
  type ResolvedPdfTableCell,
} from "./pdf-layout.js";
export {
  prepareAndChunk,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_MAX_CHUNKS,
  type ChunkOptions,
  type Chunk,
  type PreparedChunks,
} from "./chunk.js";
export {
  harvestEmbeddedState,
  detectJsShell,
  inspectHtml,
  SHELL_WARNING_CODE,
  SHELL_WARNING_CODE_EMBEDDED,
  SHELL_PREPARED_TEXT_FLOOR,
  SHELL_TEXT_RATIO_MAX,
  SHELL_SCRIPT_RATIO_MIN,
  type ShellSignals,
} from "./embedded.js";
export type {
  ContentType,
  TargetFieldSchema,
  ExtractionExample,
  ExtractionTaskSpec,
  ExtractionProvenance,
  ExtractionProposal,
  EmbeddedState,
  RawProviderResponse,
  ExtractionResult,
  ExtractionPartial,
  ExtractionPartialReason,
  ProviderExtractionBatchOutcome,
  ProviderExtractionOutput,
  ProviderExtractionInput,
  ExtractionProvider,
  ExtractionProviderCapability,
  ExtractionProviderCapabilities,
  ExtractionProviderFailure,
  ExtractInput,
  PdfExtractedText,
  PdfTextExtractor,
  PdfCoordinateUnit,
  PdfBoundingBox,
  PdfTextRange,
  PdfPageGeometry,
  PdfElementKind,
  PdfTextElement,
  PdfTableCell,
  PdfTable,
  PdfLayout,
  ImageExtractedText,
  ImageTextExtractor,
} from "./types.js";
