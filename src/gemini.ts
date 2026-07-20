import { buildExtractionTool, parseProposals } from "./anthropic.js";
import { EXTRACTION_CONFORMANCE_CAPABILITIES } from "./provider-conformance.js";
import type { ExtractionProvider, ProviderExtractionOutput } from "./types.js";

export interface GeminiResponse {
  modelVersion?: string;
  functionCalls?: Array<{ name?: string; args?: unknown }>;
  candidates?: Array<{ finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}
export interface GeminiModelsClient { generateContent(params: Record<string, unknown>): Promise<GeminiResponse> }
export interface GeminiAdapterOptions { client?: GeminiModelsClient; apiKey?: string; model?: string; maxTokens?: number }
const TOOL_NAME = "submit_extraction_proposals";

async function resolveClient(opts: GeminiAdapterOptions): Promise<GeminiModelsClient> {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GeminiExtractionProvider: no API key. Provide opts.apiKey, set GEMINI_API_KEY, or inject opts.client.");
  const moduleName = "@google/genai";
  const imported = await (Function("m", "return import(m)")(moduleName) as Promise<unknown>);
  const { GoogleGenAI } = imported as { GoogleGenAI: new (options: { apiKey: string }) => { models: GeminiModelsClient } };
  return new GoogleGenAI({ apiKey }).models;
}

function prompt(input: Parameters<ExtractionProvider["extract"]>[0]): string {
  return [
    "Extract reviewable proposals grounded in verbatim excerpts. Omit ungrounded fields.",
    input.fieldHints ? `Field hints: ${JSON.stringify(input.fieldHints)}` : "",
    input.taskSpec?.guidance ? `Task guidance: ${input.taskSpec.guidance}` : "",
    ...(input.taskSpec?.examples ?? []).map((example) => `Validated example: ${JSON.stringify(example)}`),
    `Content (${input.contentType}):\n${input.content}`,
  ].filter(Boolean).join("\n\n");
}

export function createGeminiExtractionProvider(opts: GeminiAdapterOptions = {}): ExtractionProvider {
  const model = opts.model ?? "gemini-2.5-flash";
  const name = `gemini-extraction-provider:${model}`;
  return {
    name,
    capabilities: EXTRACTION_CONFORMANCE_CAPABILITIES,
    async extract(input): Promise<ProviderExtractionOutput> {
      const client = await resolveClient(opts);
      const tool = buildExtractionTool(input.targetSchema);
      const response = await client.generateContent({
        model,
        contents: prompt(input),
        config: {
          maxOutputTokens: opts.maxTokens ?? 2048,
          tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema }] }],
          toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [TOOL_NAME] } },
        },
      });
      const call = response.functionCalls?.find((item) => item.name === TOOL_NAME);
      const parsed = parseProposals(call?.args, name, input.contentType);
      const warnings = [...parsed.warnings];
      if (!call) warnings.push("provider returned no extraction function call");
      if (response.candidates?.some((candidate) => candidate.finishReason === "MAX_TOKENS")) warnings.push("response truncated at maxTokens; proposals may be incomplete");
      return {
        proposals: parsed.proposals,
        raw: { response: call?.args === undefined ? "" : JSON.stringify(call.args), model: response.modelVersion ?? model, tokensUsed: response.usageMetadata?.totalTokenCount ?? ((response.usageMetadata?.promptTokenCount ?? 0) + (response.usageMetadata?.candidatesTokenCount ?? 0)) },
        ...(warnings.length ? { warnings } : {}),
      };
    },
  };
}
