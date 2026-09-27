import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract, serializePortableExtractionResult } from "../src/index.js";
import type { ExtractionProvider, ExtractionResult, TargetFieldSchema } from "../src/index.js";

// Every value extract() keeps as a proposal must serialize through the
// portable envelope; a value the envelope cannot carry is dropped at
// normalization, before occurrence resolution, so it can never shift a valid
// neighbour's locator.

const schema: TargetFieldSchema[] = [
  { path: "fee", type: "number" },
  { path: "meta", type: "object" },
];
// "Fee: 5" occurs twice, so an extra allocation would move a neighbour to the
// second occurrence.
const content = "Fee: 5 and Fee: 5 again. Meta: ok and Meta: ok. \u{1F600}";

function provider(proposals: unknown[], model = "generic-model"): ExtractionProvider & { calls: number } {
  const p = {
    name: "generic-provider",
    calls: 0,
    async extract() {
      p.calls++;
      return { proposals: proposals as never, raw: { response: "", model } };
    },
  };
  return p;
}

function run(proposals: unknown[], model?: string): Promise<ExtractionResult> {
  return extract({ sourceRef: "source:safe-normalization", contentType: "text", content, targetSchema: schema, provider: provider(proposals, model) });
}

const fee = { fieldPath: "fee", candidateValue: 5, confidence: 0.9, extractor: "generic-extractor", provenance: { excerpt: "Fee: 5", locator: "x" } };
const meta = { fieldPath: "meta", candidateValue: { a: 0 }, confidence: 0.9, extractor: "generic-extractor", provenance: { excerpt: "Meta: ok", locator: "x" } };

// Each trigger is paired with the valid neighbour it most resembles. Where the
// trigger shares the neighbour's allocation identity (field + value + excerpt),
// a drop after resolution would visibly shift the neighbour.
const triggers: Array<{ name: string; bad: unknown; neighbour: typeof fee | typeof meta; warning: string }> = [
  { name: "unstable extractor", bad: { ...fee, extractor: "my extractor (v1)" }, neighbour: fee, warning: 'dropped proposal for "fee": extractor is not a stable identity' },
  { name: "non-numeric confidence", bad: { ...fee, confidence: Number.NaN }, neighbour: fee, warning: 'dropped proposal for "fee": non-numeric confidence' },
  { name: "NaN value", bad: { ...fee, candidateValue: Number.NaN }, neighbour: fee, warning: 'dropped proposal for "fee": value not representable as portable JSON' },
  { name: "undefined value", bad: { ...fee, candidateValue: undefined }, neighbour: fee, warning: 'dropped proposal for "fee": value not representable as portable JSON' },
  { name: "non-plain object value", bad: { ...meta, candidateValue: new Date(0) }, neighbour: meta, warning: 'dropped proposal for "meta": value not representable as portable JSON' },
  { name: "lone-surrogate excerpt", bad: { ...fee, provenance: { excerpt: "\ud83d", locator: "x" } }, neighbour: fee, warning: 'dropped proposal for "fee": excerpt is ill-formed Unicode' },
];

describe("envelope-safe proposal normalization", () => {
  for (const trigger of triggers) {
    it(`drops only the ${trigger.name} proposal, keeps the neighbour's exact span, and serializes`, async () => {
      const alone = await run([trigger.neighbour]);
      assert.equal(alone.proposals.length, 1);
      const expected = alone.proposals[0].provenance;
      assert.equal(expected.locator, trigger.neighbour === fee ? "chars:0-6" : "chars:25-33");

      const mixed = await run([trigger.bad, trigger.neighbour]);
      assert.equal(mixed.error, undefined);
      assert.equal(mixed.proposals.length, 1, "only the unrepresentable proposal is dropped");
      assert.deepEqual(mixed.proposals[0].provenance.locator, expected.locator);
      assert.deepEqual(mixed.proposals[0].provenance.occurrence, expected.occurrence);
      assert.ok(mixed.warnings?.includes(trigger.warning), `expected warning ${trigger.warning}; got ${JSON.stringify(mixed.warnings)}`);
      assert.doesNotThrow(() => serializePortableExtractionResult(mixed));
    });
  }

  it("normalizes -0 confidence and -0 candidateValue to 0 so they serialize as 0", async () => {
    const result = await run([{ ...fee, candidateValue: -0, confidence: -0 }]);
    assert.equal(result.proposals.length, 1);
    assert.ok(Object.is(result.proposals[0].candidateValue, 0));
    assert.ok(Object.is(result.proposals[0].confidence, 0));
    const serialized = serializePortableExtractionResult(result);
    const proposal = JSON.parse(serialized).result.proposals[0];
    assert.equal(proposal.candidateValue, 0);
    assert.equal(proposal.confidence, 0);
  });

  it("normalizes a nested -0 candidateValue to 0 instead of dropping the proposal", async () => {
    const result = await run([{ ...meta, candidateValue: { a: -0, b: [1, -0, { c: -0 }] } }]);
    assert.equal(result.proposals.length, 1, "the proposal is kept, not dropped");
    assert.deepEqual(result.proposals[0].candidateValue, { a: 0, b: [1, 0, { c: 0 }] });
    assert.ok(Object.is((result.proposals[0].candidateValue as { a: number }).a, 0), "rewritten, not just equal to -0");
    const serialized = serializePortableExtractionResult(result);
    const proposal = JSON.parse(serialized).result.proposals[0];
    assert.deepEqual(proposal.candidateValue, { a: 0, b: [1, 0, { c: 0 }] });
  });

  it("omits an unstable raw.model with a warning and keeps the proposals serializable", async () => {
    const result = await run([fee], "generic model (beta)");
    assert.equal(result.proposals.length, 1);
    assert.equal(result.raw.model, "");
    assert.ok(result.warnings?.some((w) => w.startsWith("provider returned a model identity that is not a stable identity")));
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.equal(envelope.result.model, undefined);
    assert.equal(envelope.result.proposals.length, 1);
  });

  it("keeps a stable raw.model unchanged", async () => {
    const result = await run([fee]);
    assert.equal(result.raw.model, "generic-model");
    assert.equal(JSON.parse(serializePortableExtractionResult(result)).result.model, "generic-model");
  });

  it("fails fast with an invalid-config error for an unstable provider name", async () => {
    const p = provider([fee]);
    p.name = "generic provider";
    const result = await extract({ sourceRef: "source:safe-normalization", contentType: "text", content, targetSchema: schema, provider: p });
    assert.match(result.error ?? "", /^invalid provider name: /);
    assert.equal(p.calls, 0);
    assert.equal(result.providerCalls, 0);
  });
});
