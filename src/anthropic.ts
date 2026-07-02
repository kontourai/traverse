/**
 * Anthropic production adapter for Traverse's ExtractionProvider interface.
 *
 * Proposals-only compliance (docs/adr/0001-proposals-only.md §4): this adapter
 * is a PROPOSER only. Every output is an ExtractionProposal carrying provenance
 * (excerpt + locator) that flows through the caller's own review path before it
 * counts. Nothing here resolves a value.
 *
 * Subpath export: import from "@kontourai/traverse/anthropic" — this module is
 * NOT re-exported from the main index.ts, so consumers without @anthropic-ai/sdk
 * pay nothing.
 *
 * Injected client: the factory accepts an optional pre-built client so tests can
 * inject a fake without hitting the network. If none is provided, one is built
 * from opts.apiKey (falling back to process.env.ANTHROPIC_API_KEY) via a dynamic
 * import of the optional peer dep.
 */

import type {
  ContentType,
  ExtractionProposal,
  ExtractionProvider,
  ProviderExtractionOutput,
  TargetFieldSchema,
} from "./types.js";

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
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 2048;
const TOOL_NAME = "submit_extraction_proposals";

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
    default: new (opts: { apiKey: string }) => { messages: AnthropicMessagesClient };
  };

  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "AnthropicExtractionProvider: no API key. Provide opts.apiKey, set ANTHROPIC_API_KEY, or inject opts.client.",
    );
  }

  const sdk = new Anthropic({ apiKey });
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
    return `${parts}${enumPart}${descPart}`;
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
}

/**
 * Parse the tool output into ExtractionProposal[]. Malformed items — missing
 * fieldPath, missing/blank excerpt (no provenance), or out-of-range/absent
 * confidence — are dropped, never silently accepted. A missing locator is
 * synthesized deterministically as "field:<fieldPath>".
 */
export function parseProposals(
  rawToolInput: unknown,
  extractorName: string,
  contentType: ContentType,
): ExtractionProposal[] {
  if (!isRecord(rawToolInput)) return [];
  const rawProposals = rawToolInput["proposals"];
  if (!isArray(rawProposals)) return [];

  const results: ExtractionProposal[] = [];
  for (const item of rawProposals) {
    if (!isRecord(item)) continue;
    const raw = item as RawProposalItem;

    const fieldPath = stringOrUndefined(raw.fieldPath);
    const excerpt = stringOrUndefined(raw.excerpt);
    const confidence = numberInRange(raw.confidence, 0, 1);

    // Required: fieldPath, provenance excerpt, and a valid confidence.
    if (!fieldPath || !excerpt || confidence === undefined) continue;
    // A value key must be present (may be any JSON value, including falsey).
    if (!("value" in raw)) continue;

    const locator = stringOrUndefined(raw.locator) ?? `${contentType}:field:${fieldPath}`;

    results.push({
      fieldPath,
      candidateValue: raw.value,
      confidence,
      provenance: { excerpt, locator },
      extractor: extractorName,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ExtractionProvider backed by Anthropic's API using forced tool-use.
 *
 * Proposals-only (ADR 0001 §4): returns PROPOSALS only — each carries provenance
 * and flows through the caller's review path before counting. Tool output is
 * validated strictly; malformed items are dropped.
 */
export function createAnthropicExtractionProvider(
  opts: AnthropicAdapterOptions = {},
): ExtractionProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const name = `anthropic-extraction-provider:${model}`;

  return {
    name,

    async extract(input): Promise<ProviderExtractionOutput> {
      const client = await resolveClient(opts);
      const tool = buildExtractionTool(input.targetSchema);

      const hintLines = input.fieldHints
        ? Object.entries(input.fieldHints).map(([field, hint]) => `  - ${field}: ${hint}`)
        : [];

      const systemPrompt = [
        "You are a schema-directed content extractor.",
        "Extract the requested target fields from the provided content.",
        "You are PROPOSING for review — never invent values, and only propose a field",
        "when you can ground it in a verbatim excerpt from the content.",
        "Return honest confidence scores; omit fields you cannot find.",
        hintLines.length ? "\nPer-field hints:" : "",
        ...hintLines,
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
      const proposals = parseProposals(toolInput, name, input.contentType);

      return {
        proposals,
        raw: {
          response: toolInput === undefined ? "" : JSON.stringify(toolInput),
          model: message.model || model,
          tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
        },
      };
    },
  };
}
