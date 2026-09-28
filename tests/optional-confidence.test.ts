import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deserializePortableExtractionResult,
  extract,
  serializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
} from "../src/index.js";
import type { ExtractionProvider, TargetFieldSchema } from "../src/index.js";
import { buildExtractionMessages } from "../src/anthropic.js";

// Confidence is an optional provider self-report: a grounded proposal survives
// without it, the envelope carries it only when present, and dedup never
// depends on it.

const targetSchema: TargetFieldSchema[] = [{ path: "fee", type: "number" }];

function providerOf(proposals: unknown[]): ExtractionProvider {
  return {
    name: "p",
    async extract() {
      return { proposals: proposals as never, raw: { response: "", model: "m" } };
    },
  };
}
const fee = { fieldPath: "fee", candidateValue: 5, extractor: "e", provenance: { excerpt: "Fee: 5", locator: "x" } };

describe("optional proposer confidence", () => {
  it("core keeps a grounded proposal with no confidence, silently, and serializes it without the field", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider: providerOf([fee]) });
    assert.equal(result.proposals.length, 1);
    assert.ok(!("confidence" in result.proposals[0]));
    assert.equal(result.warnings, undefined);
    const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
    assert.equal(envelope.result.proposals.length, 1);
    assert.ok(!("confidence" in envelope.result.proposals[0]));
  });

  it("core treats a null confidence as absent, with no warning", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider: providerOf([{ ...fee, confidence: null }]) });
    assert.equal(result.proposals.length, 1);
    assert.ok(!("confidence" in result.proposals[0]));
    assert.equal(result.warnings, undefined);
  });

  for (const [label, value] of [["NaN", Number.NaN], ["a string", "high"], ["Infinity", Infinity]] as const) {
    it(`core omits a non-numeric confidence (${label}) with a warning and keeps the proposal`, async () => {
      const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider: providerOf([{ ...fee, confidence: value }]) });
      assert.equal(result.proposals.length, 1);
      assert.ok(!("confidence" in result.proposals[0]));
      assert.deepEqual(result.warnings, ['omitted non-numeric confidence for "fee"']);
      const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
      assert.deepEqual(envelope.result.warningClassifications, [{ category: "normalization", code: "proposal-normalization" }]);
    });
  }

  it("a reported confidence of 0.4 is carried as 0.4 in the envelope", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider: providerOf([{ ...fee, confidence: 0.4 }]) });
    const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
    assert.equal(envelope.result.proposals[0].confidence, 0.4);
  });

  it("dedup keeps the first-seen duplicate's extractor and metadata, not the higher confidence", async () => {
    // Two overlapping chunks both see "Fee: 5"; the second reports more confidence.
    const content = `${"a".repeat(84)}Fee: 5${"b".repeat(84)}`;
    let call = 0;
    const provider: ExtractionProvider = {
      name: "p",
      async extract(input) {
        call++;
        const first = call === 1;
        return {
          proposals: input.content.includes("Fee: 5")
            ? [{ ...fee, confidence: first ? 0.2 : 0.95, extractor: first ? "first-extractor" : "second-extractor" }]
            : [],
          raw: { response: "", model: first ? "model-1" : "model-2", modelSource: "provider-reported" },
        };
      },
    };
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content, chunkSize: 100, chunkOverlap: 20, provider });
    assert.equal(call, 2);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].extractor, "first-extractor");
    assert.equal(result.proposals[0].confidence, 0.2);
    assert.equal(result.proposals[0].producedBy?.model, "model-1");
  });

  it("the default instructions no longer ask for confidence scores", () => {
    const { systemPrompt } = buildExtractionMessages({ content: "c", contentType: "text", targetSchema });
    assert.ok(!/confidence/i.test(systemPrompt), systemPrompt);
  });
});

describe("portable envelope confidence validation", () => {
  async function envelopeWith(confidence: unknown) {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider: providerOf([{ ...fee, confidence: 0.5 }]) });
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    if (confidence === undefined) delete envelope.result.proposals[0].confidence;
    else envelope.result.proposals[0].confidence = confidence;
    return envelope;
  }

  it("accepts an absent confidence", async () => {
    assert.equal(validatePortableExtractionResultEnvelope(await envelopeWith(undefined)).status, "valid");
  });

  for (const [label, value] of [["NaN", Number.NaN], ["-1", -1], ['"high"', "high"], ["1.5", 1.5], ["null", null]] as const) {
    it(`rejects a confidence of ${label}`, async () => {
      assert.equal(validatePortableExtractionResultEnvelope(await envelopeWith(value)).status, "invalid");
    });
  }
});
