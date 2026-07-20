/**
 * Anthropic production adapter for Traverse's ExtractionProvider interface.
 *
 * Proposals-only compliance (docs/adr/0001-proposals-only.md §4): this adapter
 * is a PROPOSER only. Every output is an ExtractionProposal carrying provenance
 * (excerpt + locator) that flows through the caller's own review path before it
 * counts. Nothing here resolves a value.
 *
 * `provenance.locator` returned here is PROVISIONAL: `extract()`'s
 * normalization step is the sole owner of the final `locator` value — it
 * verifies `excerpt` against the prepared content and derives/overwrites
 * `locator` with the `"chars:<start>-<end>"` scheme (see src/types.ts,
 * src/extract.ts). This adapter's own synthesized `"<contentType>:field:
 * <fieldPath>"` fallback exists only so `ProviderExtractionOutput.proposals`
 * satisfies the `ExtractionProposal` shape before normalization runs.
 *
 * Subpath export: import from "@kontourai/traverse/anthropic" — this module is
 * NOT re-exported from the main index.ts, so consumers without @anthropic-ai/sdk
 * pay nothing.
 *
 * Injected client: the factory accepts an optional pre-built client so tests can
 * inject a fake without hitting the network. If none is provided, one is built
 * from opts.apiKey (falling back to process.env.ANTHROPIC_API_KEY) via a dynamic
 * import of the optional peer dep.
 *
 * Nothing is dropped or noticed silently: every malformed tool-output item this
 * adapter drops, and a response truncated at `maxTokens`, is reported via
 * `ProviderExtractionOutput.warnings` — `extract()` merges these into
 * `ExtractionResult.warnings` alongside its own normalization notes.
 */

import type {
  ContentType,
  ExtractionProposal,
  ExtractionProvider,
  ProviderExtractionOutput,
  TargetFieldSchema,
} from "./types.js";
import { EXTRACTION_CONFORMANCE_CAPABILITIES } from "./provider-conformance.js";

// ---------------------------------------------------------------------------
// Minimal client interface — mirrors @anthropic-ai/sdk Message API surface.
// Traverse does not import @anthropic-ai/sdk types directly: consumers without
// the SDK installed pay nothing. Any compatible client or test double works.
// ---------------------------------------------------------------------------

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | AnthropicToolUseBlock;

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AnthropicMessageCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: AnthropicTool[];
  tool_choice: { type: "tool"; name: string };
}

/**
 * Minimal interface matching @anthropic-ai/sdk Anthropic.messages.create.
 * Accept the real SDK client or a test double.
 */
export interface AnthropicMessagesClient {
  create(params: AnthropicMessageCreateParams): Promise<AnthropicMessage>;
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface AnthropicAdapterOptions {
  /** Injected client (real or mock). If absent, one is built from apiKey. */
  client?: AnthropicMessagesClient;
  /** API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Defaults to "claude-sonnet-4-6". */
  model?: string;
  /** Max tokens for the extraction response. Defaults to 2048. */
  maxTokens?: number;
  /**
   * Base URL for Anthropic-compatible endpoints (e.g. Z.AI's Anthropic-compatible
   * API, or a proxy). Passed through as the SDK's `baseURL` constructor option
   * when set. When unset, this adapter does NOT read any env var itself — the
   * `@anthropic-ai/sdk` constructor already falls back to `ANTHROPIC_BASE_URL`
   * on its own, so that fallback is preserved without duplicating it here.
   */
  baseUrl?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 2048;
const TOOL_NAME = "submit_extraction_proposals";

/**
 * Resolve the `{ apiKey, baseURL? }` object passed to the `@anthropic-ai/sdk`
 * constructor. Pulled out as a pure, exported function so the pass-through of
 * `opts.baseUrl` -> constructor `baseURL` is unit-testable without a network
 * call or a real SDK instance (see tests/anthropic.test.ts).
 *
 * `baseURL` is only included in the returned object when `opts.baseUrl` is
 * set — when omitted, the SDK constructor's own `ANTHROPIC_BASE_URL` env
 * fallback applies (its default parameter triggers on an absent OR
 * `undefined` key alike), so this adapter never reads that env var itself.
 */
export function resolveSdkClientOptions(
  opts: AnthropicAdapterOptions,
): { apiKey: string; baseURL?: string } {
  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "AnthropicExtractionProvider: no API key. Provide opts.apiKey, set ANTHROPIC_API_KEY, or inject opts.client.",
    );
  }
  return opts.baseUrl ? { apiKey, baseURL: opts.baseUrl } : { apiKey };
}

/**
 * Build or return a messages client from options.
 * Dynamic-imports @anthropic-ai/sdk only when no client is injected, keeping the
 * optional peer dep out of the eager module graph.
 */
async function resolveClient(opts: AnthropicAdapterOptions): Promise<AnthropicMessagesClient> {
  if (opts.client) return opts.client;

  // Dynamically load the SDK — only reachable when no client is injected.
  // Uses a variable module specifier so TypeScript does not try to resolve the
  // optional peer dep at compile time. At runtime the SDK must be installed.
  const sdkModule = "@anthropic-ai/sdk";
  const sdkImport = await (Function("m", "return import(m)")(sdkModule) as Promise<unknown>);
  const { default: Anthropic } = sdkImport as {
    default: new (opts: { apiKey: string; baseURL?: string }) => { messages: AnthropicMessagesClient };
  };

  const sdk = new Anthropic(resolveSdkClientOptions(opts));
  return sdk.messages;
}

// ---------------------------------------------------------------------------
// Dynamic tool schema — built from the caller's TargetFieldSchema[]
// ---------------------------------------------------------------------------

/**
 * Build the forced tool-use schema dynamically from the caller's field list.
 * Unlike a fixed tool, Traverse's field lists vary per app, so the tool's
 * description enumerates the exact target fields (with types, enum values, and
 * required flags) and demands a verbatim `excerpt` per proposal — that verbatim
 * excerpt is how provenance gets populated.
 */
export function buildExtractionTool(targetSchema: TargetFieldSchema[]): AnthropicTool {
  const fieldLines = targetSchema.map((f) => {
    const parts = [`- "${f.path}" (${f.type}`, f.required ? ", required" : "", ")"].join("");
    const enumPart = f.enumValues?.length ? ` one of: [${f.enumValues.join(", ")}].` : "";
    const descPart = f.description ? ` ${f.description}` : "";
    const inferenceTypePart =
      f.inferenceType === "explicit"
        ? " Copy this value verbatim from the source text — do not paraphrase, reformat, or normalize it."
        : f.inferenceType === "inferred"
          ? " This value may be derived, normalized, or classified from the source text — it still needs a grounding excerpt, but the value itself need not match verbatim."
          : "";
    return `${parts}${enumPart}${descPart}${inferenceTypePart}`;
  });

  return {
    name: TOOL_NAME,
    description: [
      "Submit an array of extraction proposals for the requested target fields.",
      "You are PROPOSING for review — every proposal is a reviewable record, not a resolved value.",
      "For EACH field you can find in the content, return one proposal with:",
      "  - fieldPath: the exact target field path from the list below,",
      "  - value: the extracted value (typed per the field),",
      "  - confidence: 0.0-1.0,",
      "  - excerpt: the VERBATIM span of source text the value was drawn from (required — no excerpt, no proposal).",
      "  - occurrenceHint: optional 1-based occurrence of that exact excerpt when it repeats; omit it when uncertain.",
      "Only propose fields you can ground in a verbatim excerpt. Omit fields you cannot find.",
      "",
      "Target fields:",
      ...fieldLines,
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fieldPath: { type: "string", description: "Exact target field path." },
              value: { description: "The extracted value (string, number, boolean, array, or object)." },
              confidence: { type: "number", description: "Confidence 0.0-1.0." },
              excerpt: { type: "string", description: "Verbatim source span the value came from." },
              locator: {
                type: "string",
                description: "Optional locator; defaults to \"field:<fieldPath>\" if omitted.",
              },
              occurrenceHint: {
                type: "integer",
                minimum: 1,
                description: "Optional 1-based occurrence of the exact repeated excerpt.",
              },
            },
            required: ["fieldPath", "value", "confidence", "excerpt"],
          },
        },
      },
      required: ["proposals"],
    },
  };
}

// ---------------------------------------------------------------------------
// Strict parse-and-drop helpers (mirrors Survey's adapter discipline)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !isFinite(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function extractToolUseInput(message: AnthropicMessage, toolName: string): unknown {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  return undefined;
}

interface RawProposalItem {
  fieldPath?: unknown;
  value?: unknown;
  confidence?: unknown;
  excerpt?: unknown;
  locator?: unknown;
  occurrenceHint?: unknown;
}

/**
 * Parse the tool output into ExtractionProposal[]. Malformed items — missing
 * fieldPath, missing/blank excerpt (no provenance), missing `value`, or
 * out-of-range/absent confidence — are dropped, never silently accepted; each
 * drop is reported in `warnings` (never silent). A missing locator is
 * synthesized deterministically as "<contentType>:field:<fieldPath>" — a
 * provisional value only; `extract()`'s normalization overwrites it once the
 * excerpt is verified against the prepared content (see src/extract.ts).
 */
export function parseProposals(
  rawToolInput: unknown,
  extractorName: string,
  contentType: ContentType,
): { proposals: ExtractionProposal[]; warnings: string[] } {
  const warnings: string[] = [];

  if (!isRecord(rawToolInput)) return { proposals: [], warnings };
  const rawProposals = rawToolInput["proposals"];
  if (!isArray(rawProposals)) return { proposals: [], warnings };

  const results: ExtractionProposal[] = [];
  rawProposals.forEach((item, index) => {
    if (!isRecord(item)) {
      warnings.push(`dropped malformed tool item at index ${index}: not an object`);
      return;
    }
    const raw = item as RawProposalItem;

    const fieldPath = stringOrUndefined(raw.fieldPath);
    const excerpt = stringOrUndefined(raw.excerpt);
    const confidence = numberInRange(raw.confidence, 0, 1);
    const hasValue = "value" in raw;

    if (!fieldPath || !excerpt || confidence === undefined || !hasValue) {
      const reasons: string[] = [];
      if (!fieldPath) reasons.push("missing fieldPath");
      if (!excerpt) reasons.push("missing/blank excerpt");
      if (confidence === undefined) reasons.push("missing/out-of-range confidence");
      if (!hasValue) reasons.push("missing value");
      warnings.push(
        `dropped malformed tool item at index ${index}${fieldPath ? ` (fieldPath "${fieldPath}")` : ""}: ${reasons.join(", ")}`,
      );
      return;
    }

    const locator = stringOrUndefined(raw.locator) ?? `${contentType}:field:${fieldPath}`;
    const occurrenceHint = typeof raw.occurrenceHint === "number" && Number.isInteger(raw.occurrenceHint)
      ? raw.occurrenceHint
      : undefined;

    results.push({
      fieldPath,
      candidateValue: raw.value,
      confidence,
      provenance: { excerpt, locator },
      extractor: extractorName,
      ...(occurrenceHint === undefined ? {} : { occurrenceHint }),
    });
  });
  return { proposals: results, warnings };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Derive a `"@<host>"` suffix for `provider.name` when a custom `baseUrl` is
 * set, so parity reports show which backend (e.g. `api.z.ai` vs Anthropic's
 * default) produced a given set of proposals. Returns "" for the default
 * (unset) case — `provider.name` is unchanged from before this option existed.
 * An unparseable `baseUrl` falls back to the raw string rather than throwing,
 * since a malformed value should still surface in the name, not blow up
 * provider construction.
 */
function hostSuffix(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return `@${new URL(baseUrl).host}`;
  } catch {
    return `@${baseUrl}`;
  }
}

/**
 * Create an ExtractionProvider backed by Anthropic's API using forced tool-use.
 *
 * Proposals-only (ADR 0001 §4): returns PROPOSALS only — each carries provenance
 * and flows through the caller's review path before counting. Tool output is
 * validated strictly; malformed items are dropped (with a warning — see
 * `parseProposals`), and a `stop_reason === "max_tokens"` response is flagged
 * with a warning so a truncated proposal set is never silently mistaken for a
 * complete one.
 */
export function createAnthropicExtractionProvider(
  opts: AnthropicAdapterOptions = {},
): ExtractionProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const name = `anthropic-extraction-provider:${model}${hostSuffix(opts.baseUrl)}`;

  return {
    name,
    capabilities: EXTRACTION_CONFORMANCE_CAPABILITIES,

    async extract(input): Promise<ProviderExtractionOutput> {
      const client = await resolveClient(opts);
      const tool = buildExtractionTool(input.targetSchema);

      const hintLines = input.fieldHints
        ? Object.entries(input.fieldHints).map(([field, hint]) => `  - ${field}: ${hint}`)
        : [];
      const taskLines = input.taskSpec
        ? [
            input.taskSpec.guidance ? `\nTask guidance:\n${input.taskSpec.guidance}` : "",
            ...(input.taskSpec.examples ?? []).map((example, index) =>
              `\nValidated example ${index + 1}:\nContent:\n${example.content}\nExpected proposals:\n${JSON.stringify(example.proposals)}`
            ),
          ]
        : [];

      const systemPrompt = [
        "You are a schema-directed content extractor.",
        "Extract the requested target fields from the provided content.",
        "You are PROPOSING for review — never invent values, and only propose a field",
        "when you can ground it in a verbatim excerpt from the content.",
        "Return honest confidence scores; omit fields you cannot find.",
        hintLines.length ? "\nPer-field hints:" : "",
        ...hintLines,
        ...taskLines,
      ]
        .filter(Boolean)
        .join("\n");

      const userMessage = `Content (${input.contentType}):\n\n${input.content}`;

      const message = await client.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: `${systemPrompt}\n\n${userMessage}` }],
        tools: [tool],
        tool_choice: { type: "tool", name: TOOL_NAME },
      });

      const toolInput = extractToolUseInput(message, TOOL_NAME);
      const { proposals, warnings } = parseProposals(toolInput, name, input.contentType);

      if (message.stop_reason === "max_tokens") {
        warnings.push("response truncated at maxTokens; proposals may be incomplete");
      }

      return {
        proposals,
        raw: {
          response: toolInput === undefined ? "" : JSON.stringify(toolInput),
          model: message.model || model,
          tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  };
}
