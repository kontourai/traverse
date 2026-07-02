// Shared test fixtures for provider-level tests.
//
// `createMockExtractionProvider` backs extract() unit tests with a deterministic
// provider (no network). The `fakeAnthropicMessage`/`fakeAnthropicClient`
// helpers back the Anthropic adapter tests with an injected client — mirroring
// the fake-client shape Survey uses for its own adapter tests.

import type {
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
 * Build a fake AnthropicMessage carrying a single tool_use block.
 */
export function fakeAnthropicMessage(
  toolName: string,
  input: unknown,
  opts: { model?: string; inputTokens?: number; outputTokens?: number } = {},
): AnthropicMessage {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "tool_fake_1", name: toolName, input }],
    model: opts.model ?? "claude-sonnet-4-6",
    stop_reason: "tool_use",
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
