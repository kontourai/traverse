import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVIDENCE_MATCH_CHECKER_VERSION,
  deserializePortableExtractionResult,
  extract,
  serializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
} from "../src/index.js";
import type { ExtractionProposal, ExtractionProvider, ExtractionResult, TargetFieldSchema } from "../src/index.js";

// Each proposal carries deterministic facts about its value against the schema
// and against its own excerpt. Annotation only: nothing is dropped or warned.

type Item = { fieldPath: string; candidateValue: unknown; excerpt: string };

function provider(items: Item[]): ExtractionProvider {
  return {
    name: "p",
    async extract() {
      return {
        proposals: items.map(({ fieldPath, candidateValue, excerpt }) => ({
          fieldPath, candidateValue, extractor: "e", provenance: { excerpt, locator: "x" },
        })),
        raw: { response: "", model: "m" },
      };
    },
  };
}

async function run(content: string, targetSchema: TargetFieldSchema[], items: Item[]): Promise<ExtractionResult> {
  return extract({ sourceRef: "s", contentType: "text", content, targetSchema, provider: provider(items) });
}

function byField(result: ExtractionResult, fieldPath: string): ExtractionProposal {
  const found = result.proposals.find((proposal) => proposal.fieldPath === fieldPath);
  assert.ok(found, `no proposal for ${fieldPath}: ${JSON.stringify(result.warnings)}`);
  return found;
}

describe("evidenceMatch", () => {
  it("annotates the four reproduction proposals without dropping or warning", async () => {
    const content = "Price: $10 per session. Closed for renovations. Term: see contract. Rating: forty-five.";
    const result = await run(content, [
      { path: "price", type: "number", inferenceType: "explicit" },
      { path: "status", type: "enum", enumValues: ["open", "closed"], inferenceType: "explicit" },
      { path: "term", type: "enum", enumValues: ["annual", "monthly"], inferenceType: "explicit" },
      { path: "rating", type: "number", inferenceType: "explicit" },
    ], [
      { fieldPath: "price", candidateValue: 999, excerpt: "Price: $10 per session." },
      { fieldPath: "status", candidateValue: "open", excerpt: "Closed for renovations" },
      { fieldPath: "term", candidateValue: "perpetual", excerpt: "Term: see contract." },
      { fieldPath: "rating", candidateValue: "forty-five", excerpt: "Rating: forty-five." },
    ]);
    assert.equal(result.proposals.length, 4);
    assert.equal(result.warnings, undefined);
    assert.deepEqual(byField(result, "price").evidenceMatch, {
      checkerVersion: EVIDENCE_MATCH_CHECKER_VERSION, schema: "ok", valueInExcerpt: "mismatch", tokenBoundary: true,
    });
    assert.equal(byField(result, "status").evidenceMatch?.schema, "ok");
    assert.equal(byField(result, "status").evidenceMatch?.valueInExcerpt, "mismatch");
    assert.equal(byField(result, "term").evidenceMatch?.schema, "enum-mismatch");
    assert.equal(byField(result, "rating").evidenceMatch?.schema, "type-mismatch");
    // A value the number normalizer cannot read is never a mismatch.
    assert.equal(byField(result, "rating").evidenceMatch?.valueInExcerpt, "not-evaluated");
    assert.equal(EVIDENCE_MATCH_CHECKER_VERSION, "evidence-match-v1");
  });

  const matches: Array<[string, TargetFieldSchema["type"], unknown, string, string[]?]> = [
    ["45 vs $45.00", "number", 45, "Fee: $45.00"],
    ["4250 vs $4,250", "number", 4250, "Total $4,250 due"],
    ["true vs Yes", "boolean", true, "Parking: Yes"],
    ["2026-06-09 vs June 9, 2026", "date", "2026-06-09", "Opens June 9, 2026"],
    ["2026-06-09 vs 9 June 2026", "date", "2026-06-09", "Opens 9 June 2026"],
    ["2026-06-09 vs Jun. 9th 2026", "date", "2026-06-09", "Opens Jun. 9th 2026"],
    ["enum open vs Status: Open", "enum", "open", "Status: Open", ["open", "closed"]],
    ["phone 303.555.1234 vs (303) 555-1234", "string", "303.555.1234", "(303) 555-1234"],
  ];
  for (const [name, type, value, excerpt, enumValues] of matches) {
    it(`keeps a well-formatted value a match: ${name}`, async () => {
      const result = await run(`x ${excerpt} y`, [{ path: "f", type, inferenceType: "explicit", ...(enumValues ? { enumValues } : {}) }], [
        { fieldPath: "f", candidateValue: value, excerpt },
      ]);
      assert.equal(result.warnings, undefined);
      assert.equal(byField(result, "f").evidenceMatch?.schema, "ok");
      assert.equal(byField(result, "f").evidenceMatch?.valueInExcerpt, "match");
    });
  }

  const mismatches: Array<[string, TargetFieldSchema["type"], unknown, string]> = [
    ["a different number", "number", 46, "Fee: $45.00"],
    ["a number inside a longer one", "number", 3, "Built 2023, fee 7"],
    ["the opposite boolean", "boolean", false, "Parking: Yes"],
    ["a different date", "date", "2026-06-10", "Opens June 9, 2026"],
    ["a word inside a longer word", "string", "open", "Reopened in spring"],
  ];
  for (const [name, type, value, excerpt] of mismatches) {
    it(`reports a mismatch for ${name}`, async () => {
      const result = await run(`x ${excerpt} y`, [{ path: "f", type, inferenceType: "explicit" }], [
        { fieldPath: "f", candidateValue: value, excerpt },
      ]);
      assert.equal(byField(result, "f").evidenceMatch?.valueInExcerpt, "mismatch");
    });
  }

  const unreadable: Array<[string, TargetFieldSchema["type"], unknown, string]> = [
    ["a number written in words", "number", 45, "Fee: forty-five dollars"],
    ["an excerpt with no yes/no word", "boolean", true, "Parking available"],
    ["an ambiguous numeric date", "date", "2026-06-09", "Opens 06/09/2026"],
    ["a date value that is not a full calendar date", "date", "2026-06", "Opens June 9, 2026"],
    ["a value with no word characters", "string", "--", "Phone: --"],
  ];
  for (const [name, type, value, excerpt] of unreadable) {
    it(`reports not-evaluated, never mismatch, for ${name}`, async () => {
      const result = await run(`x ${excerpt} y`, [{ path: "f", type, inferenceType: "explicit" }], [
        { fieldPath: "f", candidateValue: value, excerpt },
      ]);
      assert.equal(byField(result, "f").evidenceMatch?.valueInExcerpt, "not-evaluated");
    });
  }

  it("does not apply the value-in-excerpt check to inferred, unclassified, or structured fields", async () => {
    const result = await run("Price: $10. Tags: a, b.", [
      { path: "inferred", type: "number", inferenceType: "inferred" },
      { path: "unclassified", type: "number" },
      { path: "tags", type: "array", inferenceType: "explicit" },
    ], [
      { fieldPath: "inferred", candidateValue: 999, excerpt: "Price: $10." },
      { fieldPath: "unclassified", candidateValue: 999, excerpt: "Price: $10." },
      { fieldPath: "tags", candidateValue: ["a", "b"], excerpt: "Tags: a, b." },
    ]);
    for (const field of ["inferred", "unclassified", "tags"]) {
      assert.equal(byField(result, field).evidenceMatch?.valueInExcerpt, "not-applicable", field);
    }
    // The schema check still runs on every field.
    assert.equal(byField(result, "unclassified").evidenceMatch?.schema, "ok");
  });

  it("checks date format exactly", async () => {
    const schema: TargetFieldSchema[] = [{ path: "d", type: "date" }];
    const cases: Array<[unknown, string]> = [
      ["2026-06-09", "ok"],
      ["2026-06-09T10:30:00Z", "ok"],
      ["2026-06-09T10:30+02:00", "ok"],
      ["2026-06", "ok"],
      ["2024-02-29", "ok"],
      ["2026-02-29", "format-invalid"],
      ["2026-13-01", "format-invalid"],
      ["2026-06-09T25:00", "format-invalid"],
      ["June 9, 2026", "format-invalid"],
      [20260609, "type-mismatch"],
    ];
    for (const [value, expected] of cases) {
      const result = await run("Opens June 9, 2026.", schema, [{ fieldPath: "d", candidateValue: value, excerpt: "June 9, 2026" }]);
      assert.equal(byField(result, "d").evidenceMatch?.schema, expected, JSON.stringify(value));
    }
  });

  it("marks an excerpt cut from inside a word as off a token boundary", async () => {
    const result = await run("Established 2023 in town.", [
      { path: "cut", type: "number" },
      { path: "whole", type: "number" },
    ], [
      { fieldPath: "cut", candidateValue: 3, excerpt: "3" },
      { fieldPath: "whole", candidateValue: 2023, excerpt: "2023" },
    ]);
    assert.equal(byField(result, "cut").evidenceMatch?.tokenBoundary, false);
    assert.equal(byField(result, "whole").evidenceMatch?.tokenBoundary, true);
  });

  it("ignores a provider-supplied evidenceMatch", async () => {
    const forged: ExtractionProvider = {
      name: "p",
      async extract() {
        return {
          proposals: [{
            fieldPath: "f", candidateValue: 999, extractor: "e", provenance: { excerpt: "Fee: $10", locator: "x" },
            evidenceMatch: { checkerVersion: "forged", schema: "ok", valueInExcerpt: "match" },
          }],
          raw: { response: "", model: "m" },
        };
      },
    };
    const result = await extract({
      sourceRef: "s", contentType: "text", content: "Fee: $10", provider: forged,
      targetSchema: [{ path: "f", type: "number", inferenceType: "explicit" }],
    });
    assert.equal(result.proposals[0].evidenceMatch?.checkerVersion, EVIDENCE_MATCH_CHECKER_VERSION);
    assert.equal(result.proposals[0].evidenceMatch?.valueInExcerpt, "mismatch");
  });

  it("round-trips through the portable envelope, whose validator checks the enums", async () => {
    const result = await run("Fee: $45.00", [{ path: "f", type: "number", inferenceType: "explicit" }], [
      { fieldPath: "f", candidateValue: 45, excerpt: "Fee: $45.00" },
    ]);
    const text = serializePortableExtractionResult(result);
    const envelope = JSON.parse(text);
    assert.deepEqual(envelope.result.proposals[0].evidenceMatch, {
      checkerVersion: "evidence-match-v1", schema: "ok", tokenBoundary: true, valueInExcerpt: "match",
    });
    assert.equal(serializePortableExtractionResult(deserializePortableExtractionResult(text)), text);

    const invalid = (mutate: (match: Record<string, unknown>) => void) => {
      const copy = JSON.parse(text);
      mutate(copy.result.proposals[0].evidenceMatch);
      return validatePortableExtractionResultEnvelope(copy);
    };
    assert.equal(invalid(() => {}).status, "valid");
    assert.equal(invalid((m) => { delete m.tokenBoundary; }).status, "valid");
    for (const mutate of [
      (m: Record<string, unknown>) => { m.schema = "maybe"; },
      (m: Record<string, unknown>) => { m.valueInExcerpt = "close"; },
      (m: Record<string, unknown>) => { m.tokenBoundary = "yes"; },
      (m: Record<string, unknown>) => { m.checkerVersion = ""; },
      (m: Record<string, unknown>) => { delete m.valueInExcerpt; },
      (m: Record<string, unknown>) => { m.verdict = "trusted"; },
    ]) {
      assert.equal(invalid(mutate).status, "invalid", String(mutate));
    }
  });
});
