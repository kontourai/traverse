import {
  ModelInvocationError,
  type JsonSchema,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelRuntime,
} from "@kontourai/relay";
import { buildExtractionMessages, buildExtractionTool, parseProposals } from "./anthropic.js";
import { EXTRACTION_CONFORMANCE_CAPABILITIES } from "./provider-conformance.js";
import type {
  ContentType,
  ExtractionProvider,
  ProviderExtractionInput,
  ProviderExtractionOutput,
  TargetFieldSchema,
} from "./types.js";

export interface RelayExtractionAdapterOptions {
  runtime: ModelRuntime;
  maxTokens?: number;
  name?: string;
}

/** Adapt a Relay runtime to Traverse while retaining all extraction semantics here. */
export function createRelayExtractionProvider(options: RelayExtractionAdapterOptions): ExtractionProvider {
  const name = options.name ?? `relay-extraction-provider:${options.runtime.id}`;
  const runtimeCapabilities = options.runtime.capabilities();
  const physicalBatch = runtimeCapabilities.physicalBatch === true
    && typeof options.runtime.invokeBatch === "function"
    && Number.isInteger(runtimeCapabilities.maxBatchSize)
    && runtimeCapabilities.maxBatchSize! > 0;
  const provider: ExtractionProvider = {
    name,
    capabilities: {
      ...EXTRACTION_CONFORMANCE_CAPABILITIES,
      ...(physicalBatch ? { maxBatchSize: runtimeCapabilities.maxBatchSize } : {}),
    },
    async extract(input): Promise<ProviderExtractionOutput> {
      const prepared = prepareRelayInvocation(input, options.maxTokens);
      const result = await options.runtime.invoke(
        prepared.request,
        input.signal ? { signal: input.signal } : undefined,
      );
      return relayOutput(result, prepared.toolName, name, input.contentType);
    },
  };
  if (physicalBatch) {
    provider.extractBatch = async (inputs) => {
      if (inputs.length === 0 || inputs.length > runtimeCapabilities.maxBatchSize!) {
        throw new ModelInvocationError(
          "INVALID_REQUEST",
          `Relay extraction batch size must be between 1 and ${String(runtimeCapabilities.maxBatchSize)}`,
          false,
        );
      }
      const signal = sharedSignal(inputs);
      const prepared = inputs.map((input) => prepareRelayInvocation(input, options.maxTokens));
      const outcomes = await options.runtime.invokeBatch!(
        prepared.map(({ request }) => request),
        signal ? { signal } : undefined,
      );
      if (!Array.isArray(outcomes) || outcomes.length !== inputs.length) {
        throw new ModelInvocationError(
          "RUNTIME_FAILURE",
          `Relay runtime returned ${Array.isArray(outcomes) ? outcomes.length : "non-array"} batch outcome(s) for ${inputs.length} request(s)`,
          false,
        );
      }
      return outcomes.map((outcome, index) => outcome.status === "fulfilled"
        ? {
          status: "fulfilled" as const,
          value: relayOutput(
            outcome.value,
            prepared[index].toolName,
            name,
            inputs[index].contentType,
          ),
        }
        : {
          status: "rejected" as const,
          reason: new ModelInvocationError(
            outcome.reason.code,
            outcome.reason.message,
            outcome.reason.retryable,
          ),
        });
    };
  }
  return provider;
}

function prepareRelayInvocation(
  input: ProviderExtractionInput,
  maxTokens: number | undefined,
): { request: ModelInvocationRequest; toolName: string } {
  const tool = buildExtractionTool(input.targetSchema);
  const inputSchema = buildRelayExtractionSchema(input.targetSchema);
  const { systemPrompt, userMessage } = buildExtractionMessages(input);
  return {
    toolName: tool.name,
    request: {
      messages: [{ role: "user", content: `${systemPrompt}\n\n${userMessage}` }],
      tools: [{ name: tool.name, description: tool.description, inputSchema }],
      toolChoice: { type: "tool", name: tool.name },
      maxOutputTokens: maxTokens ?? 2048,
    },
  };
}

function relayOutput(
  result: ModelInvocationResult,
  toolName: string,
  providerName: string,
  contentType: ContentType,
): ProviderExtractionOutput {
  const toolInput = result.toolCalls.find((call) => call.name === toolName)?.input;
  const parsed = parseProposals(toolInput, providerName, contentType);
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
}

function sharedSignal(inputs: ProviderExtractionInput[]): AbortSignal | undefined {
  const signal = inputs[0]?.signal;
  if (inputs.some((input) => input.signal !== signal)) {
    throw new ModelInvocationError(
      "INVALID_REQUEST",
      "Relay extraction physical batch requires one shared cancellation signal",
      false,
    );
  }
  return signal;
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
