import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime, ModelInvocationError, type ModelRuntime } from "@kontourai/relay";
import { buildRelayExtractionSchema, createRelayExtractionProvider } from "../src/relay.js";
import { normalizeProviderFailure } from "../src/provider-conformance.js";

const input = {
  content: "Ada lives in Denver.", contentType: "text" as const,
  targetSchema: [{ path: "person.name", type: "string" as const, required: true }],
};

describe("Relay extraction provider", () => {
  it("builds a strict scalar proposal schema without guessing nested value shapes", () => {
    assert.deepEqual(buildRelayExtractionSchema([
      { path: "amount", type: "number" },
      { path: "label", type: "string" },
      { path: "active", type: "boolean" },
      { path: "date", type: "date" },
      { path: "kind", type: "enum", enumValues: ["a", "b"] }
    ]), {
      type: "object",
      additionalProperties: false,
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              fieldPath: { type: "string", enum: ["amount", "label", "active", "date", "kind"], description: "Exact target field path." },
              value: { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }] },
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
    });
    assert.throws(() => buildRelayExtractionSchema([{ path: "items", type: "array" }]), /requires a nested schema/);
    assert.throws(() => buildRelayExtractionSchema([{ path: "record", type: "object" }]), /requires a nested schema/);
  });

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
