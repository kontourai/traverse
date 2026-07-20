import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract } from "../src/extract.js";
import { ExactOccurrenceResolver, enumerateExactOccurrences } from "../src/occurrence-resolver.js";
import type { ExtractionProvider } from "../src/types.js";

const schema = [
  { path: "label", type: "string" as const },
  { path: "summary", type: "string" as const },
];

function repeatedProposal(occurrenceHint?: number) {
  return {
    fieldPath: "label",
    candidateValue: "Marker",
    confidence: 0.9,
    provenance: { excerpt: "Marker", locator: "untrusted" },
    extractor: "occurrence-fixture",
    ...(occurrenceHint === undefined ? {} : { occurrenceHint }),
  };
}

describe("exact occurrence resolver", () => {
  it("enumerates every exact span in source order without a fuzzy fallback", () => {
    assert.deepEqual(enumerateExactOccurrences("Marker; Marker; Marker", "Marker"), [
      { index: 0, start: 0, end: 6 },
      { index: 1, start: 8, end: 14 },
      { index: 2, start: 16, end: 22 },
    ]);
    assert.deepEqual(enumerateExactOccurrences("Marker", "not present"), []);
    assert.deepEqual(enumerateExactOccurrences("aaa", "aa"), [
      { index: 0, start: 0, end: 2 },
      { index: 1, start: 1, end: 3 },
    ]);
  });

  it("uses only bounded integer hints and exposes the selection audit", () => {
    const hinted = new ExactOccurrenceResolver().resolve({
      text: "Marker; Marker", visibleText: "Marker; Marker", visibleStart: 0,
      excerpt: "Marker", occurrenceHint: 2, sourceOrderKey: "label",
    });
    assert.deepEqual(hinted, {
      resolverVersion: "exact-occurrence-v1",
      count: 2,
      selected: { index: 1, start: 8, end: 14 },
      selection: "occurrence-hint",
      hintUsed: true,
      ambiguous: true,
    });

    const invalid = new ExactOccurrenceResolver().resolve({
      text: "Marker; Marker", visibleText: "Marker; Marker", visibleStart: 0,
      excerpt: "Marker", occurrenceHint: 3, sourceOrderKey: "label",
    });
    assert.equal(invalid?.selected.index, 0);
    assert.equal(invalid?.selection, "source-order");
    assert.equal(invalid?.hintUsed, false);
  });

  it("maps a chunk-local hint to global occurrence metadata without escaping the visible slice", () => {
    const resolved = new ExactOccurrenceResolver().resolve({
      text: "Marker......Marker",
      visibleText: "Marker",
      visibleStart: 12,
      excerpt: "Marker",
      occurrenceHint: 1,
      sourceOrderKey: "label",
    });
    assert.deepEqual(resolved, {
      resolverVersion: "exact-occurrence-v1",
      count: 2,
      selected: { index: 1, start: 12, end: 18 },
      selection: "occurrence-hint",
      hintUsed: true,
      ambiguous: true,
    });
  });

  it("allocates unhinted repeated field/value proposals to distinct exact spans", async () => {
    const provider: ExtractionProvider = {
      name: "occurrence-fixture",
      async extract() {
        return {
          proposals: [repeatedProposal(), repeatedProposal()],
          raw: { response: "fixture", model: "fixture" },
        };
      },
    };
    const result = await extract({
      content: "Marker; Marker", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider,
    });
    assert.deepEqual(result.proposals.map((proposal) => proposal.provenance.locator), ["chars:0-6", "chars:8-14"]);
    assert.deepEqual(result.proposals.map((proposal) => proposal.provenance.occurrence?.selected.index), [0, 1]);
  });

  it("preserves different fields sharing an exact span and different spans sharing a value", async () => {
    const provider: ExtractionProvider = {
      name: "occurrence-fixture",
      async extract() {
        return {
          proposals: [
            { ...repeatedProposal(1), fieldPath: "label" },
            { ...repeatedProposal(1), fieldPath: "summary" },
            repeatedProposal(2),
          ],
          raw: { response: "fixture", model: "fixture" },
        };
      },
    };
    const result = await extract({
      content: "Marker; Marker", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider,
    });
    assert.equal(result.proposals.length, 3);
    assert.deepEqual(result.proposals.map((proposal) => [proposal.fieldPath, proposal.provenance.locator]), [
      ["label", "chars:0-6"],
      ["summary", "chars:0-6"],
      ["label", "chars:8-14"],
    ]);
  });

  it("collapses only an identical field, value, and selected span", async () => {
    const provider: ExtractionProvider = {
      name: "occurrence-fixture",
      async extract() {
        return {
          proposals: [
            { ...repeatedProposal(1), confidence: 0.6 },
            { ...repeatedProposal(1), confidence: 0.9 },
          ],
          raw: { response: "fixture", model: "fixture" },
        };
      },
    };
    const result = await extract({
      content: "Marker; Marker", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider,
    });
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].confidence, 0.9);
    assert.ok(result.warnings?.includes("dropped 1 duplicate proposal (same field + value + source span)"));
  });

  it("does not allocate an unseen occurrence beyond maxChunks from overlapping visible chunks", async () => {
    const content = `${".".repeat(12)}Marker${".".repeat(22)}Marker`;
    const provider: ExtractionProvider = {
      name: "occurrence-fixture",
      async extract(input) {
        return {
          proposals: input.content.includes("Marker") ? [repeatedProposal()] : [],
          raw: { response: input.content, model: "fixture" },
        };
      },
    };
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "fixture",
      targetSchema: schema,
      provider,
      chunkSize: 20,
      chunkOverlap: 8,
      maxChunks: 2,
    });
    assert.deepEqual(result.proposals.map((proposal) => proposal.provenance.locator), ["chars:12-18"]);
    assert.ok(!result.proposals.some((proposal) => proposal.provenance.locator === "chars:40-46"));
    assert.ok(result.warnings?.includes("dropped 1 duplicate proposal (same field + value + source span)"));
  });

  it("keeps a second chunk's local hint 1 on its globally second occurrence", async () => {
    const provider: ExtractionProvider = {
      name: "occurrence-fixture",
      async extract(input) {
        return {
          proposals: input.content === "Marker" ? [repeatedProposal(1)] : [],
          raw: { response: input.content, model: "fixture" },
        };
      },
    };
    const result = await extract({
      content: "Marker......Marker",
      contentType: "text",
      sourceRef: "fixture",
      targetSchema: schema,
      provider,
      chunkSize: 12,
      chunkOverlap: 0,
    });
    assert.equal(result.proposals[0].provenance.locator, "chars:12-18");
    assert.equal(result.proposals[0].provenance.occurrence?.selected.index, 1);
    assert.equal(result.proposals[0].provenance.occurrence?.hintUsed, true);
  });

  it("remains stable when chunk batching, concurrency, and replay timing vary", async () => {
    const proposalOutput = async (input: Parameters<ExtractionProvider["extract"]>[0], delay: boolean) => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, input.content.startsWith("Marker") ? 8 : 1));
      return {
        proposals: input.content.includes("Marker") ? [repeatedProposal()] : [],
        raw: { response: input.content, model: "fixture" },
      };
    };
    const provider = (delay: boolean): ExtractionProvider => ({
      name: "occurrence-fixture",
      capabilities: { supported: ["structured-output", "exact-excerpts"] },
      async extract(input) { return proposalOutput(input, delay); },
      async extractBatch(inputs) { return Promise.all(inputs.map((input) => proposalOutput(input, delay))); },
    });
    const input = {
      content: "Marker 1234567890 Marker",
      contentType: "text" as const,
      sourceRef: "fixture-replay",
      targetSchema: schema,
      chunkSize: 15,
      chunkOverlap: 0,
    };
    const sequential = await extract({ ...input, provider: provider(false) });
    const concurrent = await extract({ ...input, provider: provider(true), concurrency: 2, batchSize: 1 });
    const batched = await extract({ ...input, provider: provider(true), concurrency: 2, batchSize: 2 });
    const replay = await extract({ ...input, provider: provider(true), concurrency: 2, batchSize: 1 });
    const view = (result: typeof sequential) => result.proposals.map((proposal) => ({
      locator: proposal.provenance.locator,
      occurrence: proposal.provenance.occurrence,
    }));
    assert.deepEqual(view(concurrent), view(sequential));
    assert.deepEqual(view(batched), view(sequential));
    assert.deepEqual(view(replay), view(sequential));
  });

  it("drops paraphrases and hallucinations instead of assigning an approximate offset", async () => {
    const provider: ExtractionProvider = {
      name: "occurrence-fixture",
      async extract() {
        return {
          proposals: [{ ...repeatedProposal(), provenance: { excerpt: "Marked", locator: "untrusted" } }],
          raw: { response: "fixture", model: "fixture" },
        };
      },
    };
    const result = await extract({
      content: "Marker", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider,
    });
    assert.deepEqual(result.proposals, []);
    assert.ok(result.warnings?.some((warning) => warning.includes("excerpt not found")));
  });
});
