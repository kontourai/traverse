import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExtractionTaskSpec, extract } from "../src/index.js";
import type { TargetFieldSchema } from "../src/index.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";

const schema: TargetFieldSchema[] = [
  { path: "title", type: "string" },
  { path: "status", type: "enum", enumValues: ["open", "closed"] },
];

function task(guidance = "Copy exact titles") {
  return createExtractionTaskSpec({
    version: "1.0.0",
    targetSchema: schema,
    guidance,
    examples: [{
      content: "Alpha is open.",
      proposals: [
        { fieldPath: "title", candidateValue: "Alpha", excerpt: "Alpha" },
        { fieldPath: "status", candidateValue: "open", excerpt: "open" },
      ],
    }],
  });
}

describe("versioned extraction task specs", () => {
  it("computes stable provenance digests and changes them with guidance", () => {
    const first = task();
    assert.equal(first.digest, task().digest);
    assert.equal(first.examples?.[0].digest, task("Different guidance").examples?.[0].digest);
    assert.notEqual(first.digest, task("Different guidance").digest);
  });

  it("passes a validated task to the provider and records its digests", async () => {
    let observed: unknown;
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const original = provider.extract;
    provider.extract = async (input) => { observed = input.taskSpec; return original(input); };
    const spec = task();
    const result = await extract({ content: "Current title", contentType: "text", sourceRef: "test", targetSchema: schema, taskSpec: spec, provider });
    assert.equal(observed, spec);
    assert.equal(result.taskDigest, spec.digest);
    assert.deepEqual(result.exampleDigests, [spec.examples?.[0].digest]);
  });

  it("rejects unknown fields, wrong value types, and ungrounded excerpts before paid work", async () => {
    for (const mutate of [
      (draft: any) => { draft.examples[0].proposals[0].fieldPath = "missing"; },
      (draft: any) => { draft.examples[0].proposals[0].candidateValue = 42; },
      (draft: any) => { draft.examples[0].proposals[0].excerpt = "absent"; },
    ]) {
      const draft: any = { version: "1", targetSchema: schema, examples: [{ content: "Alpha", proposals: [{ fieldPath: "title", candidateValue: "Alpha", excerpt: "Alpha" }] }] };
      mutate(draft);
      const spec = createExtractionTaskSpec(draft);
      const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
      const result = await extract({ content: "Current", contentType: "text", sourceRef: "test", targetSchema: schema, taskSpec: spec, provider });
      assert.match(result.error ?? "", /invalid taskSpec/);
      assert.equal(result.providerCalls, 0);
      assert.equal(provider.calls.length, 0);
    }
  });

  it("keeps schema-only provider requests and result provenance unchanged", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const result = await extract({ content: "Current", contentType: "text", sourceRef: "test", targetSchema: schema, provider });
    assert.equal("taskSpec" in provider.calls[0], false);
    assert.equal("taskDigest" in result, false);
    assert.equal("exampleDigests" in result, false);
  });
});
