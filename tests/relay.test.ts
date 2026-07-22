import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime, ModelInvocationError, type ModelRuntime } from "@kontourai/relay";
import { createRelayExtractionProvider } from "../src/relay.js";
import { normalizeProviderFailure } from "../src/provider-conformance.js";

const input = {
  content: "Ada lives in Denver.", contentType: "text" as const,
  targetSchema: [{ path: "person.name", type: "string" as const, required: true }],
};

describe("Relay extraction provider", () => {
  it("translates Relay tool calls into Traverse proposals", async () => {
    const runtime = new FakeModelRuntime([{
      provider: "fixture", model: "fixture-model", outputText: "", latencyMs: 1,
      toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [{ fieldPath: "person.name", value: "Ada", confidence: 0.9, excerpt: "Ada" }] } }],
      usage: { totalTokens: 7 }, stopReason: "tool_use",
    }]);
    const output = await createRelayExtractionProvider({ runtime }).extract(input);
    assert.equal(output.proposals[0]?.candidateValue, "Ada");
    assert.equal(output.proposals[0]?.extractor, `relay-extraction-provider:${runtime.id}`);
    assert.deepEqual(output.raw, { response: JSON.stringify({ proposals: [{ fieldPath: "person.name", value: "Ada", confidence: 0.9, excerpt: "Ada" }] }), model: "fixture-model", tokensUsed: 7 });
  });

  it("preserves Relay retryability in Traverse failure normalization", () => {
    const runtime: ModelRuntime = { id: "failing", capabilities: () => ({ structuredTools: true, streaming: false, abort: true, usage: true }), async invoke() { throw new ModelInvocationError("RATE_LIMITED", "limited", true); } };
    const provider = createRelayExtractionProvider({ runtime });
    const normalized = normalizeProviderFailure(provider, new ModelInvocationError("RATE_LIMITED", "limited", true));
    assert.equal(normalized.kind, "rate-limit");
    assert.equal(normalized.retryable, true);
  });
});
