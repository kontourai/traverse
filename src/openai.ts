import { buildExtractionTool, parseProposals } from "./anthropic.js";
import { EXTRACTION_CONFORMANCE_CAPABILITIES } from "./provider-conformance.js";
import type { ExtractionProvider, ProviderExtractionOutput } from "./types.js";

export interface OpenAIChatCompletion {
  model: string;
  choices: Array<{ finish_reason: string | null; message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
export interface OpenAIChatClient {
  create(params: Record<string, unknown>): Promise<OpenAIChatCompletion>;
}
export interface OpenAIAdapterOptions { client?: OpenAIChatClient; apiKey?: string; model?: string; maxTokens?: number; baseUrl?: string }

const TOOL_NAME = "submit_extraction_proposals";

async function resolveClient(opts: OpenAIAdapterOptions): Promise<OpenAIChatClient> {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env["OPENAI_API_KEY"];
  if (!apiKey) throw new Error("OpenAIExtractionProvider: no API key. Provide opts.apiKey, set OPENAI_API_KEY, or inject opts.client.");
  const moduleName = "openai";
  const imported = await (Function("m", "return import(m)")(moduleName) as Promise<unknown>);
  const { default: OpenAI } = imported as { default: new (options: { apiKey: string; baseURL?: string }) => { chat: { completions: OpenAIChatClient } } };
  return new OpenAI({ apiKey, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) }).chat.completions;
}

function prompt(input: Parameters<ExtractionProvider["extract"]>[0]): string {
  const task = input.taskSpec;
  return [
    "Extract reviewable proposals grounded in verbatim excerpts. Omit ungrounded fields.",
    input.fieldHints ? `Field hints: ${JSON.stringify(input.fieldHints)}` : "",
    task?.guidance ? `Task guidance: ${task.guidance}` : "",
    ...(task?.examples ?? []).map((example) => `Validated example: ${JSON.stringify(example)}`),
    `Content (${input.contentType}):\n${input.content}`,
  ].filter(Boolean).join("\n\n");
}

export function createOpenAIExtractionProvider(opts: OpenAIAdapterOptions = {}): ExtractionProvider {
  const model = opts.model ?? "gpt-4.1-mini";
  const name = `openai-extraction-provider:${model}`;
  return {
    name,
    capabilities: EXTRACTION_CONFORMANCE_CAPABILITIES,
    async extract(input): Promise<ProviderExtractionOutput> {
      const client = await resolveClient(opts);
      const tool = buildExtractionTool(input.targetSchema);
      const response = await client.create({
        model,
        max_completion_tokens: opts.maxTokens ?? 2048,
        messages: [{ role: "user", content: prompt(input) }],
        tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema, strict: true } }],
        tool_choice: { type: "function", function: { name: TOOL_NAME } },
      });
      const call = response.choices[0]?.message.tool_calls?.find((item) => item.function.name === TOOL_NAME);
      const warnings: string[] = [];
      let rawInput: unknown;
      if (call) {
        try { rawInput = JSON.parse(call.function.arguments); }
        catch { warnings.push("provider returned malformed JSON tool arguments"); }
      } else warnings.push("provider returned no extraction tool call");
      const parsed = parseProposals(rawInput, name, input.contentType);
      warnings.push(...parsed.warnings);
      if (response.choices[0]?.finish_reason === "length") warnings.push("response truncated at maxTokens; proposals may be incomplete");
      return {
        proposals: parsed.proposals,
        raw: { response: call?.function.arguments ?? "", model: response.model || model, tokensUsed: response.usage?.total_tokens ?? ((response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0)) },
        ...(warnings.length ? { warnings } : {}),
      };
    },
  };
}
