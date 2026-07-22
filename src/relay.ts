import type { ModelRuntime } from "@kontourai/relay";
import { buildExtractionMessages, buildExtractionTool, parseProposals } from "./anthropic.js";
import { EXTRACTION_CONFORMANCE_CAPABILITIES } from "./provider-conformance.js";
import type { ExtractionProvider, ProviderExtractionOutput } from "./types.js";

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
      const { systemPrompt, userMessage } = buildExtractionMessages(input);
      const result = await options.runtime.invoke({
        messages: [{ role: "user", content: `${systemPrompt}\n\n${userMessage}` }],
        tools: [{ name: tool.name, description: tool.description, inputSchema: tool.input_schema }],
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
