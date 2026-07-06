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
  prepareContent,
  htmlToText,
  htmlToMarkdown,
  vttToText,
  preparePdfText,
  resolvePdfPage,
  type PrepMode,
} from "./content-prep.js";
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
  ExtractionProvenance,
  ExtractionProposal,
  EmbeddedState,
  RawProviderResponse,
  ExtractionResult,
  ProviderExtractionOutput,
  ExtractionProvider,
  ExtractInput,
  PdfExtractedText,
  PdfTextExtractor,
} from "./types.js";
