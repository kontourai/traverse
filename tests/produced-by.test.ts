import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { ModelInvocationRequest, ModelInvocationResult, ModelRuntime } from "@kontourai/relay";
import {
  extract,
  serializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
} from "../src/index.js";
import type { ExtractionProvider, TargetFieldSchema } from "../src/index.js";
import { createAnthropicExtractionProvider, type AnthropicMessageCreateParams } from "../src/anthropic.js";
import { createRelayExtractionProvider } from "../src/relay.js";
import { createOpenAIExtractionProvider } from "../src/openai.js";
import { createGeminiExtractionProvider } from "../src/gemini.js";
import { canonicalTaskJson } from "../src/task.js";
import { fakeAnthropicMessage } from "./fixtures/mock-provider.js";

const targetSchema: TargetFieldSchema[] = [{ path: "title", type: "string" }];
// Three 80-character segments with the title at offset 30; chunkSize 100 with
// overlap 20 steps by 80, so each chunk sees exactly its own segment's title.
const segment = (n: number) => `${".".repeat(30)}Program ${String(n).padStart(2, "0")} Alpha`.padEnd(80, ".");
const content = [1, 2, 3].map(segment).join("");
const chunking = { chunkSize: 100, chunkOverlap: 20 };

function titlesIn(text: string): string[] {
  return text.match(/Program \d+ Alpha/g) ?? [];
}

function toolProposals(text: string): unknown {
  return { proposals: titlesIn(text).map((title) => ({ fieldPath: "title", value: title, confidence: 0.9, excerpt: title })) };
}

function relayRuntime(
  respond: (request: ModelInvocationRequest, call: number) => Partial<ModelInvocationResult> & Record<string, unknown>,
): ModelRuntime & { requests: ModelInvocationRequest[] } {
  const requests: ModelInvocationRequest[] = [];
  return {
    id: "routed-fixture",
    requests,
    capabilities: () => ({ structuredTools: true, streaming: false, abort: true, usage: true }),
    async invoke(request) {
      requests.push(request);
      const text = String(request.messages[0]?.content ?? "");
      return {
        provider: "fixture", model: "fixture-model", outputText: "", latencyMs: 1,
        toolCalls: [{ id: String(requests.length), name: request.tools![0].name, input: toolProposals(text) }],
        usage: { totalTokens: 1 }, stopReason: "tool_use",
        ...respond(request, requests.length),
      } as ModelInvocationResult;
    },
  };
}

describe("per-proposal producedBy", () => {
  it("attributes each proposal to the model its own chunk's call reported", async () => {
    const calls: AnthropicMessageCreateParams[] = [];
    const client = {
      async create(params: AnthropicMessageCreateParams) {
        calls.push(params);
        const text = String(params.messages[0]?.content ?? "");
        return fakeAnthropicMessage("submit_extraction_proposals", toolProposals(text), { model: `served-model-${calls.length - 1}` });
      },
    };
    const result = await extract({
      content, contentType: "text", sourceRef: "fixture", targetSchema, ...chunking,
      provider: createAnthropicExtractionProvider({ client, model: "configured-model" }),
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(result.proposals.map((p) => [p.candidateValue, p.producedBy?.model, p.producedBy?.modelSource]), [
      ["Program 01 Alpha", "served-model-0", "provider-reported"],
      ["Program 02 Alpha", "served-model-1", "provider-reported"],
      ["Program 03 Alpha", "served-model-2", "provider-reported"],
    ]);
    // The run-level model still names the last chunk only.
    assert.equal(result.raw.model, "served-model-2");
    const digests = result.proposals.map((p) => p.producedBy?.requestDigest);
    assert.equal(new Set(digests).size, 3);
    for (const d of digests) assert.match(d ?? "", /^sha256:[a-f0-9]{64}$/);

    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.deepEqual(envelope.result.proposals.map((p: { producedBy: unknown }) => p.producedBy), result.proposals.map((p) => p.producedBy));
  });

  it("direct adapters say whether the model was reported or configured", async () => {
    const input = { content: "Alpha", contentType: "text" as const, targetSchema };
    const cases: Array<[string, (reported: string) => ExtractionProvider]> = [
      ["anthropic", (reported) => createAnthropicExtractionProvider({ model: "configured-model", client: { async create() { return { ...fakeAnthropicMessage("submit_extraction_proposals", { proposals: [] }), model: reported }; } } })],
      ["openai", (reported) => createOpenAIExtractionProvider({ model: "configured-model", client: { async create() { return { model: reported, choices: [{ finish_reason: "stop", message: { content: "" } }], usage: { total_tokens: 1 } }; } } as never })],
      ["gemini", (reported) => createGeminiExtractionProvider({ model: "configured-model", client: { async generateContent() { return { ...(reported ? { modelVersion: reported } : {}), usageMetadata: { totalTokenCount: 1 } }; } } as never })],
    ];
    for (const [label, create] of cases) {
      const served = await create("served-model").extract(input);
      assert.deepEqual([served.raw.model, served.raw.modelSource], ["served-model", "provider-reported"], label);
      const configured = await create("").extract(input);
      assert.deepEqual([configured.raw.model, configured.raw.modelSource], ["configured-model", "configured"], label);
    }
  });

  it("digests the request content, not its correlation fields", async () => {
    let seen: Parameters<ExtractionProvider["extract"]>[0] | undefined;
    const provider: ExtractionProvider = {
      name: "p",
      async extract(input) {
        seen = input;
        return { proposals: [{ fieldPath: "title", candidateValue: "Alpha", confidence: 1, extractor: "p", provenance: { excerpt: "Alpha", locator: "x" } }], raw: { response: "", model: "m", modelSource: "configured" } };
      },
    };
    const result = await extract({ content: "Alpha", contentType: "text", sourceRef: "fixture", targetSchema, fieldHints: { title: "hint" }, provider });
    assert.equal(seen?.chunkIndex, 0);
    assert.equal(seen?.runId, result.runId);
    const expected = `sha256:${createHash("sha256").update(canonicalTaskJson({ content: "Alpha", contentType: "text", targetSchema, fieldHints: { title: "hint" } })).digest("hex")}`;
    assert.deepEqual(result.proposals[0]?.producedBy, { model: "m", modelSource: "configured", requestDigest: expected });
  });

  it("carries a Relay runtime's configured modelSource and correlation metadata", async () => {
    const runtime = relayRuntime((_request, call) => ({ model: `alias-${call}`, modelSource: "configured" }));
    const result = await extract({ content, contentType: "text", sourceRef: "fixture", targetSchema, ...chunking, provider: createRelayExtractionProvider({ runtime }) });
    assert.deepEqual(result.proposals.map((p) => [p.producedBy?.model, p.producedBy?.modelSource]), [
      ["alias-1", "configured"], ["alias-2", "configured"], ["alias-3", "configured"],
    ]);
    assert.deepEqual(runtime.requests.map((r) => r.metadata), [0, 1, 2].map((i) => ({ chunkIndex: String(i), runId: result.runId })));
    const envelope = validatePortableExtractionResultEnvelope(JSON.parse(serializePortableExtractionResult(result)));
    assert.equal(envelope.status, "valid");
    if (envelope.status === "valid") assert.equal(envelope.envelope.result.proposals[2]?.producedBy?.modelSource, "configured");
  });

  it("keeps the model in process but leaves producedBy off the envelope when the source is unknown", async () => {
    const runtime = relayRuntime(() => ({ model: "served", modelSource: "guessed" }));
    const result = await extract({ content: "Program 01 Alpha", contentType: "text", sourceRef: "fixture", targetSchema, provider: createRelayExtractionProvider({ runtime }) });
    assert.equal(result.proposals[0]?.producedBy?.model, "served");
    assert.equal(result.proposals[0]?.producedBy?.modelSource, undefined);
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.equal("producedBy" in envelope.result.proposals[0], false);
  });

  it("omits producedBy when the reported model is not a stable identity, and ignores provider-supplied producedBy", async () => {
    const provider: ExtractionProvider = {
      name: "p",
      async extract() {
        return {
          proposals: [{
            fieldPath: "title", candidateValue: "Alpha", confidence: 1, extractor: "p", provenance: { excerpt: "Alpha", locator: "x" },
            producedBy: { model: "forged", modelSource: "provider-reported", requestDigest: `sha256:${"0".repeat(64)}` },
          }],
          raw: { response: "", model: "has space", modelSource: "provider-reported" },
        };
      },
    };
    const result = await extract({ content: "Alpha", contentType: "text", sourceRef: "fixture", targetSchema, provider });
    assert.equal(result.proposals[0]?.producedBy, undefined);
  });

  it("keeps the producedBy of the proposal dedup keeps", async () => {
    // Two chunks both see "Shared Title" in their overlap. Dedup keeps the
    // first-seen copy whole, whatever confidence either call reported.
    const overlapContent = `${"a".repeat(84)}Shared Title${"b".repeat(84)}`;
    for (const [confidences, winner] of [[[0.5, 0.9], "model-1"], [[0.7, 0.7], "model-1"]] as const) {
      let call = 0;
      const provider: ExtractionProvider = {
        name: "p",
        async extract(input) {
          call++;
          const confidence = confidences[call - 1];
          return {
            proposals: input.content.includes("Shared Title")
              ? [{ fieldPath: "title", candidateValue: "Shared Title", confidence, extractor: "p", provenance: { excerpt: "Shared Title", locator: "x" } }]
              : [],
            raw: { response: "", model: `model-${call}`, modelSource: "provider-reported" },
          };
        },
      };
      const result = await extract({ content: overlapContent, contentType: "text", sourceRef: "fixture", targetSchema, chunkSize: 100, chunkOverlap: 20, provider });
      assert.equal(call, 2);
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0]?.producedBy?.model, winner, JSON.stringify(confidences));
      assert.equal(result.proposals[0]?.confidence, confidences[0]);
    }
  });

  it("validates producedBy on the wire", async () => {
    const provider: ExtractionProvider = {
      name: "p",
      async extract() {
        return { proposals: [{ fieldPath: "title", candidateValue: "Alpha", confidence: 1, extractor: "p", provenance: { excerpt: "Alpha", locator: "x" } }], raw: { response: "", model: "m", modelSource: "provider-reported" } };
      },
    };
    const result = await extract({ content: "Alpha", contentType: "text", sourceRef: "fixture", targetSchema, provider });
    const base = JSON.parse(serializePortableExtractionResult(result));
    assert.equal(validatePortableExtractionResultEnvelope(base).status, "valid");
    const mutations: Array<[string, (p: Record<string, unknown>) => void]> = [
      ["non-identity model", (p) => { p.model = "has space"; }],
      ["credential model", (p) => { p.model = "sk-ant-private-value"; }],
      ["unknown modelSource", (p) => { p.modelSource = "guessed"; }],
      ["missing modelSource", (p) => { delete p.modelSource; }],
      ["bad requestDigest", (p) => { p.requestDigest = "sha256:xyz"; }],
      ["missing requestDigest", (p) => { delete p.requestDigest; }],
      ["extra key", (p) => { p.extra = true; }],
    ];
    for (const [label, mutate] of mutations) {
      const envelope = structuredClone(base);
      mutate(envelope.result.proposals[0].producedBy);
      const validation = validatePortableExtractionResultEnvelope(envelope);
      assert.equal(validation.status, "invalid", label);
      if (validation.status === "invalid") assert.match(validation.reason, /producedBy/, label);
    }
  });

  it("validates the portable failure code on the wire", () => {
    const envelope = (code: unknown) => ({
      format: "traverse-extraction-result", version: 1, source: { ref: "fixture" },
      result: {
        proposals: [], provider: "p", runId: "traverse-extraction-run:00000000-0000-4000-8000-000000000000", raw: {},
        outcome: { status: "failure", category: "provider", code: "provider-failure" },
        extractedAt: "2026-01-01T00:00:00.000Z", providerCalls: 1, totalTokensUsed: 0,
        providerFailures: [{ provider: "p", kind: "unknown", retryable: false, code }],
      },
    });
    assert.equal(validatePortableExtractionResultEnvelope(envelope("AUTHORIZATION_PERSISTENCE_FAILED")).status, "valid");
    assert.equal(validatePortableExtractionResultEnvelope(envelope("C".repeat(128))).status, "valid");
    for (const code of ["C".repeat(129), "has space", "sk-ant-private-value", 42, ""]) {
      assert.equal(validatePortableExtractionResultEnvelope(envelope(code)).status, "invalid", String(code));
    }
  });
});
