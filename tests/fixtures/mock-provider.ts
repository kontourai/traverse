// Shared test fixtures for provider-level tests.
//
// `createMockExtractionProvider` backs extract() unit tests with a deterministic
// provider (no network). `createRegexScanProvider` backs the multi-call chunking
// and cost-guard suites with a provider that scans "Program NN Alpha" out of
// whatever chunk content it is handed and records every call — hoisted here so
// tests/chunking.test.ts and tests/cost-guard.test.ts share one implementation
// instead of each keeping a near-identical private copy. The
// `fakeAnthropicMessage`/`fakeAnthropicClient` helpers back the Anthropic
// adapter tests with an injected client — mirroring the fake-client shape
// Survey uses for its own adapter tests.

import type {
  ExtractionProposal,
  ExtractionProvider,
  ProviderExtractionOutput,
} from "../../src/types.js";
import type {
  AnthropicMessage,
  AnthropicMessagesClient,
  AnthropicMessageCreateParams,
} from "../../src/anthropic.js";

/**
 * A mock ExtractionProvider that returns a fixed (or lazily-computed) output and
 * records the inputs it was called with, so tests can assert on content prep
 * (e.g. maxContentChars truncation) and on the request shape.
 */
export interface MockExtractionProvider extends ExtractionProvider {
  calls: Array<{
    content: string;
    contentType: string;
    targetSchema: unknown;
    fieldHints?: Record<string, string>;
  }>;
}

export function createMockExtractionProvider(
  output: ProviderExtractionOutput | (() => ProviderExtractionOutput | Promise<ProviderExtractionOutput>),
  opts: { name?: string; throwError?: Error } = {},
): MockExtractionProvider {
  const calls: MockExtractionProvider["calls"] = [];
  return {
    name: opts.name ?? "mock-extraction-provider",
    calls,
    async extract(input): Promise<ProviderExtractionOutput> {
      calls.push({
        content: input.content,
        contentType: input.contentType,
        targetSchema: input.targetSchema,
        fieldHints: input.fieldHints,
      });
      if (opts.throwError) throw opts.throwError;
      return typeof output === "function" ? await output() : output;
    },
  };
}

/**
 * A provider that proposes one "title" per "Program NN Alpha" it can see in
 * the chunk it is handed, grounding each proposal in a verbatim excerpt.
 * Records every call's content (`callContents`) so tests can assert on
 * exactly how many provider calls were issued. Optionally throws on a given
 * (1-based) call to model a single failing chunk, and optionally reports a
 * per-call `raw.tokensUsed` (fixed number, a per-call array, or omitted
 * entirely to model a non-token-reporting provider) for cost-guard coverage.
 */
export function createRegexScanProvider(
  opts: { throwOnCall?: number; tokensUsed?: number | number[] } = {},
): ExtractionProvider & { callContents: string[] } {
  const callContents: string[] = [];
  return {
    name: "regex-scan-mock",
    callContents,
    async extract(input): Promise<ProviderExtractionOutput> {
      callContents.push(input.content);
      const callNumber = callContents.length;
      if (opts.throwOnCall === callNumber) {
        throw new Error(`boom on call ${callNumber}`);
      }
      const proposals: ExtractionProposal[] = [];
      const re = /Program \d+ Alpha/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(input.content)) !== null) {
        proposals.push({
          fieldPath: "title",
          candidateValue: m[0],
          confidence: 0.9,
          provenance: { excerpt: m[0], locator: "provisional" },
          extractor: "regex-scan-mock",
        });
      }
      const tokensUsed = Array.isArray(opts.tokensUsed) ? opts.tokensUsed[callNumber - 1] : opts.tokensUsed;
      return {
        proposals,
        raw: { response: "{}", model: "mock", ...(tokensUsed !== undefined ? { tokensUsed } : {}) },
      };
    },
  };
}

/**
 * Build a fake AnthropicMessage carrying a single tool_use block.
 */
export function fakeAnthropicMessage(
  toolName: string,
  input: unknown,
  opts: { model?: string; inputTokens?: number; outputTokens?: number; stopReason?: string | null } = {},
): AnthropicMessage {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "tool_fake_1", name: toolName, input }],
    model: opts.model ?? "claude-sonnet-4-6",
    stop_reason: opts.stopReason ?? "tool_use",
    usage: {
      input_tokens: opts.inputTokens ?? 120,
      output_tokens: opts.outputTokens ?? 64,
    },
  };
}

/**
 * Build a fake AnthropicMessage with NO tool_use block (model replied in text).
 */
export function fakeAnthropicTextMessage(text: string, opts: { model?: string } = {}): AnthropicMessage {
  return {
    id: "msg_fake_text",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: opts.model ?? "claude-sonnet-4-6",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/**
 * Build a fake messages client that captures each create() call and returns a
 * fixed message.
 */
export function fakeAnthropicClient(
  response: AnthropicMessage,
): AnthropicMessagesClient & { calls: AnthropicMessageCreateParams[] } {
  const calls: AnthropicMessageCreateParams[] = [];
  return {
    calls,
    async create(params: AnthropicMessageCreateParams): Promise<AnthropicMessage> {
      calls.push(params);
      return response;
    },
  };
}
