import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime } from "@kontourai/relay";
import { importExtractionEnvelope } from "@kontourai/survey";
import { deserializePortableExtractionResult, extract, serializePortableExtractionResult } from "../src/index.js";
import type { ExtractionProvider, ExtractionResult, TargetFieldSchema } from "../src/index.js";
import { createAnthropicExtractionProvider } from "../src/anthropic.js";
import { createOpenAIExtractionProvider } from "../src/openai.js";
import { createGeminiExtractionProvider } from "../src/gemini.js";
import { createRelayExtractionProvider } from "../src/relay.js";
import { fakeAnthropicClient, fakeAnthropicMessage, fakeAnthropicTextMessage } from "./fixtures/mock-provider.js";

// Four ways a run can leave prepared text unread or unanswered. Each must name
// the chunk and char range in process, and keep its own portable warning code.

const targetSchema: TargetFieldSchema[] = [{ path: "fee", type: "number" }];
const empty = { proposals: [], raw: { response: "", model: "m" } };

function codes(result: ExtractionResult): string[] {
  const envelope = JSON.parse(serializePortableExtractionResult(result));
  return (envelope.result.warningClassifications ?? []).map((w: { code: string }) => w.code);
}

function relayRuntime(result: { stopReason: string; outputText?: string; toolCalls?: unknown[] }) {
  return new FakeModelRuntime([{
    provider: "fixture", model: "relay-test", outputText: result.outputText ?? "", toolCalls: result.toolCalls ?? [],
    usage: { totalTokens: 3 }, latencyMs: 0, stopReason: result.stopReason,
  } as never]);
}

describe("chunk-loss warnings", () => {
  it("a failed chunk names its index and range and classifies as chunk-provider-failure", async () => {
    let n = 0;
    const provider: ExtractionProvider = {
      name: "p",
      async extract() {
        if (n++ === 1) throw Object.assign(new Error("503"), { status: 503 });
        return empty;
      },
    };
    const content = "x".repeat(13000) + " Fee: 5.";
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content, provider });
    assert.equal(result.error, undefined);
    assert.ok(
      result.warnings?.includes(`chunk 2/2 provider call failed: 503 (chars:11800-${content.length} not read)`),
      JSON.stringify(result.warnings),
    );
    assert.ok(codes(result).includes("chunk-provider-failure"), JSON.stringify(codes(result)));
    assert.ok(!codes(result).includes("provider-warning"));
  });

  it("a chunk longer than maxContentChars names the unsent tail and classifies as content-truncated-at-dispatch", async () => {
    const seen: number[] = [];
    const provider: ExtractionProvider = {
      name: "p",
      async extract(input) { seen.push(input.content.length); return empty; },
    };
    const content = "x".repeat(33000) + " Fee: 5.";
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, chunkSize: 40000, content, provider });
    assert.deepEqual(seen, [32000]);
    assert.deepEqual(result.warnings, [
      `chunk 1/1 content truncated at maxContentChars (32000): chars:32000-${content.length} not sent to the provider`,
    ]);
    assert.deepEqual(codes(result), ["content-truncated-at-dispatch"]);
  });

  it("an output cap hit is located on the chunk and classifies as output-truncated", async () => {
    const provider = createRelayExtractionProvider({
      runtime: relayRuntime({
        stopReason: "max_tokens",
        toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [] } }],
      }),
    });
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    assert.deepEqual(result.warnings, [
      "chunk 1/1 (chars:0-7): response truncated at maxTokens; proposals may be incomplete",
    ]);
    assert.deepEqual(codes(result), ["output-truncated"]);
  });

  it("a missing tool call is located on the chunk and classifies as missing-tool-call", async () => {
    const provider = createRelayExtractionProvider({
      runtime: relayRuntime({ stopReason: "end_turn", outputText: "The fee is 5." }),
    });
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    assert.deepEqual(result.warnings, ["chunk 1/1 (chars:0-7): provider returned no extraction tool call"]);
    assert.deepEqual(codes(result), ["missing-tool-call"]);
  });

  describe("every bundled adapter warns on a missing tool call", () => {
    const adapters: Array<[string, ExtractionProvider]> = [
      ["anthropic", createAnthropicExtractionProvider({ client: fakeAnthropicClient(fakeAnthropicTextMessage("The fee is 5.")) })],
      ["openai", createOpenAIExtractionProvider({ client: { async create() { return { model: "openai-test", choices: [{ finish_reason: "stop", message: { content: "The fee is 5." } }], usage: { total_tokens: 3 } }; } } as never })],
      ["gemini", createGeminiExtractionProvider({ client: { async generateContent() { return { modelVersion: "gemini-test", text: "The fee is 5.", usageMetadata: { totalTokenCount: 3 } }; } } as never })],
      ["relay", createRelayExtractionProvider({ runtime: relayRuntime({ stopReason: "end_turn", outputText: "The fee is 5." }) })],
    ];
    for (const [label, provider] of adapters) {
      it(label, async () => {
        const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
        // Its only chunk went unanswered, so the run fails, keeping the warning.
        assert.equal(result.error, "no dispatched chunk returned a usable answer");
        assert.ok(
          result.warnings?.some((w) => /^chunk 1\/1 \(chars:0-7\): provider returned no extraction (tool|function) call$/.test(w)),
          JSON.stringify(result.warnings),
        );
        assert.ok(codes(result).includes("missing-tool-call"), JSON.stringify(codes(result)));
      });
    }
  });

  it("a single clean chunk produces no warning (no false positives)", async () => {
    const provider = createAnthropicExtractionProvider({
      client: fakeAnthropicClient(fakeAnthropicMessage("submit_extraction_proposals", {
        proposals: [{ fieldPath: "fee", value: 5, confidence: 0.9, excerpt: "Fee: 5" }],
      })),
    });
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    assert.equal(result.proposals.length, 1);
    assert.equal(result.warnings, undefined);
  });

  it("an envelope carrying every chunk-loss code is a partial outcome, and the current Survey importer refuses it rather than reading success", async () => {
    let n = 0;
    const provider: ExtractionProvider = {
      name: "p",
      async extract(input) {
        n++;
        if (n === 2) throw Object.assign(new Error("503"), { status: 503 });
        return {
          proposals: n === 1 ? [{ fieldPath: "fee", candidateValue: 5, confidence: 0.9, extractor: "e", provenance: { excerpt: "Fee: 5", locator: "x" } }] : [],
          raw: { response: "", model: "m" },
          warnings: n === 3
            ? ["response truncated at maxTokens; proposals may be incomplete", "provider returned no extraction tool call"]
            : [],
        };
      },
    };
    // Three 33,000-char windows: chunk 1 is cut at dispatch, chunk 2 fails,
    // chunk 3 reports an output cap and a missing tool call.
    const content = "Fee: 5. " + "x".repeat(70000);
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content, chunkSize: 33000, chunkOverlap: 0, provider });
    const serialized = serializePortableExtractionResult(result);
    const found = codes(result);
    for (const code of ["chunk-provider-failure", "content-truncated-at-dispatch", "output-truncated", "missing-tool-call"]) {
      assert.ok(found.includes(code), `${code} missing from ${JSON.stringify(found)}`);
    }
    const envelope = deserializePortableExtractionResult(serialized);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "content-truncated" });
    assert.deepEqual(envelope.result.warningClassifications?.map((w) => w.code), found);
    // The Survey importer this suite pins predates the loss reasons and
    // `coverage`, so it refuses the envelope (fail closed) instead of
    // importing a lossy run as a success. When the dev dependency moves to a
    // Survey release that reads them, turn this into a round trip.
    assert.throws(() => importExtractionEnvelope(serialized, {
      sourceKind: "uploaded-document",
      claimTarget: () => ({
        subjectType: "fixture", subjectId: "fixture-1", facet: "fixture", claimType: "field-value",
        fieldOrBehavior: "fee", impactLevel: "low",
      }),
    }), /result\.coverage is unexpected/);
  });
});
