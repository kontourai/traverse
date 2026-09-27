import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime } from "@kontourai/relay";
import {
  createExtractionTaskSpec,
  extract,
  EXTRACTION_CONFORMANCE_CAPABILITIES,
  normalizeProviderFailure,
} from "../src/index.js";
import type { ExtractionProvider, TargetFieldSchema } from "../src/index.js";
import { createAnthropicExtractionProvider } from "../src/anthropic.js";
import { createOpenAIExtractionProvider } from "../src/openai.js";
import { createGeminiExtractionProvider } from "../src/gemini.js";
import { createRelayExtractionProvider } from "../src/relay.js";
import { fakeAnthropicClient, fakeAnthropicMessage } from "./fixtures/mock-provider.js";

const schema: TargetFieldSchema[] = [{ path: "title", type: "string", inferenceType: "explicit" }];
const rawProposals = { proposals: [{ fieldPath: "title", value: "Alpine", confidence: 0.9, excerpt: "Alpine" }] };
const taskSpec = createExtractionTaskSpec({
  version: "1",
  targetSchema: schema,
  guidance: "Copy exactly",
  examples: [{ content: "Alpine", proposals: [{ fieldPath: "title", candidateValue: "Alpine", excerpt: "Alpine" }] }],
});

function adapters(payload: unknown = rawProposals): Array<[string, ExtractionProvider]> {
  const rawProposals = payload;
  return [
    ["anthropic", createAnthropicExtractionProvider({ client: fakeAnthropicClient(fakeAnthropicMessage("submit_extraction_proposals", rawProposals, { inputTokens: 7, outputTokens: 4 })) })],
    ["openai", createOpenAIExtractionProvider({ client: { async create() { return { model: "openai-test", choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "submit_extraction_proposals", arguments: JSON.stringify(rawProposals) } }] } }], usage: { total_tokens: 11 } }; } } })],
    ["gemini", createGeminiExtractionProvider({ client: { async generateContent() { return { modelVersion: "gemini-test", functionCalls: [{ name: "submit_extraction_proposals", args: rawProposals }], usageMetadata: { totalTokenCount: 11 } }; } } })],
    ["relay", createRelayExtractionProvider({ runtime: new FakeModelRuntime([{ provider: "fixture", model: "relay-test", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: rawProposals }], usage: { totalTokens: 11 }, latencyMs: 0 }]) })],
  ];
}

describe("bundled provider conformance", () => {
  for (const [label, provider] of adapters()) {
    it(`${label} declares the full contract and produces identical grounded semantics`, async () => {
      assert.deepEqual(
        provider.capabilities?.supported,
        EXTRACTION_CONFORMANCE_CAPABILITIES.supported,
      );
      assert.equal(
        provider.capabilities?.maxBatchSize,
        label === "relay" ? 100 : undefined,
      );
      const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, taskSpec, provider });
      assert.equal(result.error, undefined);
      assert.equal(result.providerCalls, 1);
      assert.equal(result.totalTokensUsed, 11);
      assert.equal(result.taskDigest, taskSpec.digest);
      assert.deepEqual(result.proposals.map(({ fieldPath, candidateValue, confidence, provenance, inferenceType, valueType }) => ({ fieldPath, candidateValue, confidence, provenance, inferenceType, valueType })), [{
        fieldPath: "title", candidateValue: "Alpine", confidence: 0.9,
        provenance: {
          excerpt: "Alpine",
          locator: "chars:7-13",
          occurrence: {
            resolverVersion: "exact-occurrence-v1",
            count: 1,
            selected: { index: 0, start: 7, end: 13 },
            selection: "source-order",
            hintUsed: false,
            ambiguous: false,
          },
        },
        inferenceType: "explicit", valueType: "string",
      }]);
    });
  }

  for (const [label, provider] of adapters({ proposals: [{ fieldPath: "title", value: "Alpine", confidence: 1.2, excerpt: "Alpine" }] })) {
    it(`${label} passes an out-of-range confidence through to the core clamp instead of dropping it`, async () => {
      const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.proposals.map(({ candidateValue, confidence }) => ({ candidateValue, confidence })), [{ candidateValue: "Alpine", confidence: 1 }]);
      assert.deepEqual(result.warnings, ['clamped out-of-range confidence for "title" to 1']);
    });
  }

  for (const [label, provider] of adapters({ proposals: [{ fieldPath: "title", value: "Alpine", excerpt: "Alpine" }] })) {
    it(`${label} still drops a proposal with no confidence, with a warning`, async () => {
      const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.proposals, []);
      assert.deepEqual(result.warnings, ['dropped malformed tool item at index 0 (fieldPath "title"): missing/non-numeric confidence']);
    });
  }

  it("rejects a declared unsupported task capability before paid work", async () => {
    let calls = 0;
    const provider: ExtractionProvider = {
      name: "limited",
      capabilities: { supported: ["structured-output", "exact-excerpts"] },
      async extract() { calls++; return { proposals: [], raw: { response: "", model: "" } }; },
    };
    const result = await extract({ content: "Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, taskSpec, provider });
    assert.match(result.error ?? "", /task-specifications/);
    assert.equal(result.providerCalls, 0);
    assert.equal(calls, 0);
  });

  it("normalizes retryability without discarding the native diagnostic", () => {
    const native = Object.assign(new Error("quota exceeded"), { status: 429, requestId: "req-native" });
    const failure = normalizeProviderFailure(adapters()[0][1], native);
    assert.equal(failure.kind, "rate-limit");
    assert.equal(failure.retryable, true);
    assert.equal(failure.native, native);
  });

  // Codes as raised by Dispatch's authorization ledger; plain objects keep the
  // test free of a Dispatch dependency while exercising the same `code` seam.
  for (const code of ["AUTHORIZATION_PERSISTENCE_FAILED", "AUTHORIZATION_EXHAUSTED"]) {
    it(`does not classify authorization-ledger code ${code} as authentication`, () => {
      const native = Object.assign(new Error("authorization ledger refused"), { code });
      const failure = normalizeProviderFailure(adapters()[0][1], native);
      assert.equal(failure.kind, "unknown");
      assert.equal(failure.retryable, false);
      assert.equal(failure.native, native);
    });
  }

  it("still classifies authentication codes and HTTP 401/403 as authentication", () => {
    const provider = adapters()[0][1];
    for (const code of ["AUTHENTICATION_FAILED", "authentication_error", "unauthorized", "forbidden", "invalid_api_key"]) {
      assert.equal(normalizeProviderFailure(provider, Object.assign(new Error("denied"), { code })).kind, "authentication", code);
    }
    for (const status of [401, 403]) {
      assert.equal(normalizeProviderFailure(provider, Object.assign(new Error("denied"), { status })).kind, "authentication", String(status));
    }
  });

  it("surfaces normalized failure provenance on extraction results", async () => {
    const native = Object.assign(new Error("temporarily unavailable"), { status: 503, requestId: "req-503" });
    const provider: ExtractionProvider = {
      name: "failing",
      capabilities: EXTRACTION_CONFORMANCE_CAPABILITIES,
      async extract() { throw native; },
    };
    const result = await extract({ content: "Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
    assert.equal(result.providerFailures?.[0].kind, "unavailable");
    assert.equal(result.providerFailures?.[0].retryable, true);
    assert.equal(result.providerFailures?.[0].native, native);
  });
});
