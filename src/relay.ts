import type { JsonSchema, ModelRuntime } from "@kontourai/relay";
import { buildExtractionMessages, buildExtractionTool, parseProposals } from "./anthropic.js";
import { EXTRACTION_CONFORMANCE_CAPABILITIES } from "./provider-conformance.js";
import type { ExtractionProvider, ProviderExtractionOutput, TargetFieldSchema } from "./types.js";

export interface RelayExtractionAdapterOptions {
  runtime: ModelRuntime;
  maxTokens?: number;
  name?: string;
}

/** Adapt a Relay runtime to Traverse while retaining all extraction semantics here. */
export function createRelayExtractionProvider(options: RelayExtractionAdapterOptions): ExtractionProvider {
  const name = options.name ?? `relay-extraction-provider:${options.runtime.id}`;
  return {
    name,
    capabilities: EXTRACTION_CONFORMANCE_CAPABILITIES,
    async extract(input): Promise<ProviderExtractionOutput> {
      const tool = buildExtractionTool(input.targetSchema);
      const inputSchema = buildRelayExtractionSchema(input.targetSchema);
      const { systemPrompt, userMessage } = buildExtractionMessages(input);
      const result = await options.runtime.invoke({
        messages: [{ role: "user", content: `${systemPrompt}\n\n${userMessage}` }],
        tools: [{ name: tool.name, description: tool.description, inputSchema }],
        toolChoice: { type: "tool", name: tool.name },
        maxOutputTokens: options.maxTokens ?? 2048,
      }, input.signal ? { signal: input.signal } : undefined);
      const toolInput = result.toolCalls.find((call) => call.name === tool.name)?.input;
      const parsed = parseProposals(toolInput, name, input.contentType);
      const warnings = [...parsed.warnings, ...(result.warnings ?? [])];
      if (result.stopReason === "max_tokens" || result.stopReason === "max_output_tokens") {
        warnings.push("response truncated at maxTokens; proposals may be incomplete");
      }
      return {
        proposals: parsed.proposals,
        raw: {
          response: toolInput === undefined ? "" : JSON.stringify(toolInput),
          model: result.model,
          ...(result.usage.totalTokens === undefined ? {} : { tokensUsed: result.usage.totalTokens }),
        },
        ...(warnings.length === 0 ? {} : { warnings }),
      };
    },
  };
}

/**
 * Relay runtimes may project tools through strict structured-output APIs.
 * Traverse owns the proposal value types, so it supplies the strict schema
 * instead of asking Relay to guess. Array/object targets need a caller-owned
 * nested schema and are rejected until TargetFieldSchema can express one.
 */
export function buildRelayExtractionSchema(targetSchema: TargetFieldSchema[]): JsonSchema {
  const unsupported = targetSchema.find((field) => field.type === "array" || field.type === "object");
  if (unsupported) {
    throw new Error(`Relay structured extraction requires a nested schema for ${unsupported.type} target: ${unsupported.path}`);
  }
  const valueTypes = [...new Set(targetSchema.map((field) =>
    field.type === "number" ? "number"
      : field.type === "boolean" ? "boolean"
        : "string"))];
  if (valueTypes.length === 0) throw new Error("Relay structured extraction requires at least one target field");
  const valueSchema = valueTypes.length === 1
    ? { type: valueTypes[0] }
    : { anyOf: valueTypes.map((type) => ({ type })) };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            fieldPath: { type: "string", enum: targetSchema.map((field) => field.path), description: "Exact target field path." },
            value: valueSchema,
            confidence: { type: "number", description: "Confidence 0.0-1.0." },
            excerpt: { type: "string", description: "Verbatim source span the value came from." },
            locator: { type: ["string", "null"], description: "Optional source locator; null when absent." },
            occurrenceHint: { type: ["integer", "null"], minimum: 1, description: "Optional 1-based exact-excerpt occurrence; null when absent." }
          },
          required: ["fieldPath", "value", "confidence", "excerpt", "locator", "occurrenceHint"]
        }
      }
    },
    required: ["proposals"]
  };
}
