import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime } from "@kontourai/relay";
import {
  createExtractionTaskSpec,
  extract,
  EXTRACTION_CONFORMANCE_CAPABILITIES,
  normalizeProviderFailure,
  deserializePortableExtractionResult,
  serializePortableExtractionResult,
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

/** Each bundled adapter answering with `payload` as its tool input, optionally stopped at the output cap. */
function adaptersWith(payload: unknown, capped = false): Array<[string, ExtractionProvider]> {
  return [
    ["anthropic", createAnthropicExtractionProvider({ client: fakeAnthropicClient(fakeAnthropicMessage("submit_extraction_proposals", payload, capped ? { stopReason: "max_tokens" } : {})) })],
    ["openai", createOpenAIExtractionProvider({ client: { async create() { return { model: "openai-test", choices: [{ finish_reason: capped ? "length" : "tool_calls", message: { tool_calls: [{ function: { name: "submit_extraction_proposals", arguments: JSON.stringify(payload) } }] } }], usage: { total_tokens: 11 } }; } } })],
    ["gemini", createGeminiExtractionProvider({ client: { async generateContent() { return { modelVersion: "gemini-test", functionCalls: [{ name: "submit_extraction_proposals", args: payload }], usageMetadata: { totalTokenCount: 11 }, ...(capped ? { candidates: [{ finishReason: "MAX_TOKENS" }] } : {}) }; } } as never })],
    ["relay", createRelayExtractionProvider({ runtime: new FakeModelRuntime([{ provider: "fixture", model: "relay-test", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: payload }], usage: { totalTokens: 11 }, latencyMs: 0, stopReason: capped ? "max_tokens" : "tool_use" }]) })],
  ];
}

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
    it(`${label} keeps a grounded proposal with no confidence and serializes it without the field`, async () => {
      const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.proposals.map((p) => p.candidateValue), ["Alpine"]);
      assert.ok(!("confidence" in result.proposals[0]), "no confidence is invented");
      assert.equal(result.warnings, undefined, "a missing self-report is not a defect");
      const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
      assert.equal(envelope.result.proposals.length, 1);
      assert.ok(!("confidence" in envelope.result.proposals[0]));
    });
  }

  // Relay's strict schema must list every key, so a runtime answers null when
  // it has no confidence to report; every adapter treats null as absent.
  for (const [label, provider] of adapters({ proposals: [{ fieldPath: "title", value: "Alpine", confidence: null, excerpt: "Alpine", locator: null, occurrenceHint: null }] })) {
    it(`${label} treats a null confidence as absent, with no warning`, async () => {
      const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.proposals.map((p) => p.candidateValue), ["Alpine"]);
      assert.ok(!("confidence" in result.proposals[0]));
      assert.equal(result.warnings, undefined);
    });
  }

  // A tool call whose input is unusable must not read as a complete answer.
  const unusablePayloads: Array<[string, unknown]> = [
    ["proposals is not an array", { proposals: "garbage" }],
    ["no proposals key", {}],
    ["null proposals", { proposals: null }],
    ["every item malformed", { proposals: [7, { junk: 1 }] }],
  ];
  for (const [what, payload] of unusablePayloads) {
    for (const [label, provider] of adaptersWith(payload)) {
      it(`${label}: an unusable tool call (${what}) is unread/provider-failure`, async () => {
        const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
        assert.equal(result.error, undefined);
        const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
        assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "provider-failure" });
        assert.deepEqual(envelope.result.coverage, [{ chunk: 1, start: 0, end: 13, status: "unread", reason: "provider-failure" }]);
        assert.ok(envelope.result.warningClassifications?.some((w) => w.code === "unusable-answer"), JSON.stringify(result.warnings));
      });
    }
  }

  for (const [label, provider] of adaptersWith({ proposals: [] })) {
    it(`${label}: a valid empty proposals array is a complete answer`, async () => {
      const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
      const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
      assert.deepEqual(envelope.result.outcome, { status: "success" });
      assert.equal(result.warnings, undefined);
    });
  }

  for (const [label, provider] of adaptersWith({ proposals: [7, { fieldPath: "title", value: "Alpine", excerpt: "Alpine" }] })) {
    it(`${label}: some malformed items are a proposal-normalization drop, not a lost chunk`, async () => {
      const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
      assert.equal(result.proposals.length, 1);
      const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
      assert.deepEqual(envelope.result.outcome, { status: "success" });
      assert.deepEqual(envelope.result.warningClassifications, [{ category: "normalization", code: "proposal-normalization" }]);
    });
  }

  for (const [label, provider] of adaptersWith({ proposals: [] }, true)) {
    it(`${label}: sets truncated at the output cap, and extract() reports partial/output-truncated`, async () => {
      const output = await provider.extract({ content: "Title: Alpine", contentType: "text", targetSchema: schema });
      assert.equal(output.truncated, true);
      assert.equal(output.missingToolCall, false);
      assert.equal(output.unusable, false);
      const [, fresh] = adaptersWith({ proposals: [] }, true).find(([name]) => name === label)!;
      const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider: fresh });
      const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
      assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "output-truncated" });
      assert.deepEqual(envelope.result.coverage, [{ chunk: 1, start: 0, end: 13, status: "output-truncated" }]);
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

  it("keeps the upstream error code exactly as raised, in process and on the portable failure", async () => {
    const native = Object.assign(new Error("authorization ledger refused"), { code: "AUTHORIZATION_PERSISTENCE_FAILED" });
    const failure = normalizeProviderFailure(adapters()[0][1], native);
    assert.deepEqual(
      { kind: failure.kind, retryable: failure.retryable, code: failure.code },
      { kind: "unknown", retryable: false, code: "AUTHORIZATION_PERSISTENCE_FAILED" },
    );
    const provider: ExtractionProvider = {
      name: "ledger-backed",
      capabilities: EXTRACTION_CONFORMANCE_CAPABILITIES,
      async extract() { throw native; },
    };
    const result = await extract({ content: "Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
    assert.equal(result.providerFailures?.[0].code, "AUTHORIZATION_PERSISTENCE_FAILED");
    // Original casing, not the lower-cased copy used for classification.
    const portable = JSON.parse(serializePortableExtractionResult(result));
    assert.deepEqual(portable.result.providerFailures, [{ provider: "ledger-backed", kind: "unknown", retryable: false, code: "AUTHORIZATION_PERSISTENCE_FAILED" }]);
  });

  it("omits a portable failure code longer than importers accept, keeping it in process", async () => {
    const accepted = "C".repeat(128);
    const tooLong = "C".repeat(129);
    for (const [code, portableCode] of [[accepted, accepted], [tooLong, undefined]] as const) {
      const provider: ExtractionProvider = {
        name: "ledger-backed",
        capabilities: EXTRACTION_CONFORMANCE_CAPABILITIES,
        async extract() { throw Object.assign(new Error("failed"), { code }); },
      };
      const result = await extract({ content: "Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
      assert.equal(result.providerFailures?.[0].code, code);
      const portable = JSON.parse(serializePortableExtractionResult(result));
      assert.equal(portable.result.providerFailures[0].code, portableCode, `length ${code.length}`);
    }
  });

  it("omits a code that is not a credential-free stable identity", () => {
    const provider = adapters()[0][1];
    for (const code of ["", "has space", "sk-ant-private-value", "x".repeat(300), "https://host/?token=private"]) {
      const failure = normalizeProviderFailure(provider, Object.assign(new Error("failed"), { code }));
      assert.equal("code" in failure, false, code);
    }
    assert.equal("code" in normalizeProviderFailure(provider, Object.assign(new Error("failed"), { code: 42 })), false);
    assert.equal("code" in normalizeProviderFailure(provider, new Error("no code")), false);
  });

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
