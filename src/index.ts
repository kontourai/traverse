/**
 * @kontourai/traverse public entry point.
 *
 * Exports the top-level `extract()` orchestration, content-prep helpers, and all
 * core types. The Anthropic adapter is deliberately NOT exported here — it lives
 * behind the `@kontourai/traverse/anthropic` subpath so consumers without
 * @anthropic-ai/sdk pay nothing.
 */

export { extract } from "./extract.js";
export { prepareContent, htmlToText } from "./content-prep.js";
export type {
  ContentType,
  TargetFieldSchema,
  ExtractionProvenance,
  ExtractionProposal,
  RawProviderResponse,
  ExtractionResult,
  ProviderExtractionOutput,
  ExtractionProvider,
  ExtractInput,
} from "./types.js";
