import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime, RecordingModelRuntime } from "@kontourai/relay";
import {
  deserializePortableExtractionResult,
  extract,
  sameResolvedOccurrence,
  serializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
} from "../src/index.js";
import type { ExactOccurrenceResolution, ExtractionProvider, TargetFieldSchema } from "../src/index.js";
import { buildExtractionMessages, buildExtractionTool, buildStrictExtractionSchema, createAnthropicExtractionProvider } from "../src/anthropic.js";
import { createOpenAIExtractionProvider } from "../src/openai.js";
import { createGeminiExtractionProvider } from "../src/gemini.js";
import { createRelayExtractionProvider } from "../src/relay.js";
import { normalizeCandidateValue } from "../src/value-normalization.js";
import { EVIDENCE_MATCH_CHECKER_VERSION, schemaMatch } from "../src/evidence-match.js";

// A proposal's value is typed by its own field in every adapter's tool schema,
// rewritten into that type only when the rewrite is lossless and recorded, and
// one field can carry several distinct values.

const targetSchema: TargetFieldSchema[] = [
  { path: "title", type: "string" },
  { path: "version", type: "number" },
  { path: "signedDate", type: "date" },
  { path: "active", type: "boolean" },
  { path: "status", type: "enum", enumValues: ["open", "closed"] },
];

type Variant = { properties: { fieldPath: { enum?: string[] }; value: Record<string, unknown> }; additionalProperties?: boolean; required: string[] };

/** The `value` schema the item schema allows for `path`: the variant whose fieldPath enum names it. */
function valueSchemaFor(schema: unknown, path: string): Record<string, unknown> {
  const items = (schema as { properties: { proposals: { items: { anyOf?: Variant[] } & Variant } } }).properties.proposals.items;
  const variants = items.anyOf ?? [items];
  const matches = variants.filter((variant) => variant.properties.fieldPath.enum?.includes(path));
  assert.equal(matches.length, 1, `exactly one item variant names ${path}`);
  return matches[0].properties.value;
}

const EXPECTED_VALUE_SCHEMAS: Array<[string, Record<string, unknown>]> = [
  ["title", { type: "string" }],
  ["version", { type: "number" }],
  ["signedDate", { type: "string", description: "ISO 8601 date, e.g. 2026-06-09." }],
  ["active", { type: "boolean" }],
  ["status", { type: "string", enum: ["open", "closed"] }],
];

const input = { content: "Version: 2.1", contentType: "text" as const, targetSchema };
const noProposals = { proposals: [] };

/** The tool schema each bundled adapter actually sends for `input`. */
async function sentSchemas(): Promise<Array<[string, unknown]>> {
  const sent: Array<[string, unknown]> = [];
  await createAnthropicExtractionProvider({
    client: { async create(params) { sent.push(["anthropic", params.tools[0].input_schema]); return { id: "m", type: "message", role: "assistant", model: "a", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t", name: "submit_extraction_proposals", input: noProposals }] }; } },
  }).extract(input);
  await createOpenAIExtractionProvider({
    client: { async create(params) {
      const fn = (params.tools as Array<{ function: { parameters: unknown; strict: boolean } }>)[0].function;
      assert.equal(fn.strict, true);
      sent.push(["openai", fn.parameters]);
      return { model: "o", choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "submit_extraction_proposals", arguments: JSON.stringify(noProposals) } }] } }] };
    } },
  }).extract(input);
  await createGeminiExtractionProvider({
    client: { async generateContent(params) {
      const config = params.config as { tools: Array<{ functionDeclarations: Array<{ parametersJsonSchema: unknown }> }> };
      sent.push(["gemini", config.tools[0].functionDeclarations[0].parametersJsonSchema]);
      return { functionCalls: [{ name: "submit_extraction_proposals", args: noProposals }] };
    } },
  }).extract(input);
  const runtime = new RecordingModelRuntime(new FakeModelRuntime([{ provider: "fixture", model: "r", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: noProposals }], usage: {}, latencyMs: 0 }]));
  await createRelayExtractionProvider({ runtime }).extract(input);
  sent.push(["relay", runtime.records[0].request.tools![0].inputSchema]);
  return sent;
}

describe("per-field value typing in the tool schema", () => {
  it("every bundled adapter sends a schema that types each field's value by that field", async () => {
    const sent = await sentSchemas();
    assert.deepEqual(sent.map(([name]) => name), ["anthropic", "openai", "gemini", "relay"]);
    for (const [name, schema] of sent) {
      for (const [path, expected] of EXPECTED_VALUE_SCHEMAS) {
        assert.deepEqual(valueSchemaFor(schema, path), expected, `${name}: ${path}`);
      }
    }
  });

  it("a number field's value cannot be a string in the strict schema", () => {
    const value = valueSchemaFor(buildStrictExtractionSchema(targetSchema), "version");
    assert.deepEqual(value, { type: "number" });
    assert.equal(JSON.stringify(value).includes("string"), false);
  });

  it("the strict dialect closes every item variant and requires every key", () => {
    const items = (buildStrictExtractionSchema(targetSchema) as { properties: { proposals: { items: { anyOf: Variant[] } } } }).properties.proposals.items;
    assert.equal(items.anyOf.length, 5);
    for (const variant of items.anyOf) {
      assert.equal(variant.additionalProperties, false);
      assert.deepEqual(variant.required, ["fieldPath", "value", "confidence", "excerpt", "locator", "occurrenceHint"]);
    }
  });

  it("fields sharing a value type share one variant, and one field gets no anyOf", () => {
    const two = buildStrictExtractionSchema([{ path: "a", type: "string" }, { path: "b", type: "string" }]) as { properties: { proposals: { items: Variant } } };
    assert.deepEqual(two.properties.proposals.items.properties.fieldPath.enum, ["a", "b"]);
    assert.equal("anyOf" in two.properties.proposals.items, false);
  });

  it("strict mode is not claimed for a target whose nested shape is undeclared", async () => {
    assert.equal(buildStrictExtractionSchema([{ path: "tags", type: "array" }]), undefined);
    assert.equal(buildStrictExtractionSchema([]), undefined);
    let strict: unknown;
    let parameters: unknown;
    await createOpenAIExtractionProvider({
      client: { async create(params) {
        ({ strict, parameters } = (params.tools as Array<{ function: { parameters: unknown; strict: boolean } }>)[0].function);
        return { model: "o", choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "submit_extraction_proposals", arguments: JSON.stringify(noProposals) } }] } }] };
      } },
    }).extract({ content: "x", contentType: "text", targetSchema: [{ path: "tags", type: "array" }, { path: "meta", type: "object" }] });
    assert.equal(strict, false);
    assert.deepEqual(valueSchemaFor(parameters, "tags"), { type: "array", items: {} });
    assert.deepEqual(valueSchemaFor(parameters, "meta"), { type: "object" });
  });

  it("the non-strict tool leaves an array path open to an indexed answer", () => {
    const tool = buildExtractionTool([{ path: "schedules[].startDate", type: "date" }]);
    const item = (tool.input_schema.properties.proposals as { items: Variant }).items;
    assert.equal(item.properties.fieldPath.enum, undefined);
    assert.equal(item.properties.value.type, "string");
  });
});

describe("the prompt asks for one proposal per distinct value", () => {
  const description = buildExtractionTool(targetSchema).description;
  it("asks for each distinct value and not for each mention", () => {
    assert.match(description, /one proposal per DISTINCT value the content states for it/);
    assert.match(description, /two different values for one field are two proposals/);
    assert.match(description, /the same value stated more than once is ONE proposal/);
    assert.doesNotMatch(description, /return one proposal with/);
  });
  it("says so in the schema and the message too, which reach a runtime that never sends the tool description", async () => {
    const rule = /One proposal per DISTINCT value the content states for a field: two different values for one field are two proposals.*the same value stated more than once is ONE proposal\./;
    for (const [name, schema] of await sentSchemas()) {
      assert.match((schema as { properties: { proposals: { description: string } } }).properties.proposals.description, rule, name);
    }
    assert.match(buildExtractionMessages(input).systemPrompt, rule);
    const runtime = new RecordingModelRuntime(new FakeModelRuntime([{ provider: "fixture", model: "r", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: noProposals }], usage: {}, latencyMs: 0 }]));
    await createRelayExtractionProvider({ runtime }).extract(input);
    assert.match(runtime.records[0].request.messages[0].content as string, rule);
  });
  it("tells the model the JSON type of a number and the form of a date", () => {
    assert.match(description, /a number field is a JSON number, never a string/);
    assert.match(description, /a date field is an ISO 8601 date/);
  });
  it("does not ask for an explicit date verbatim and in ISO form at once", () => {
    const lines = buildExtractionTool([
      { path: "d", type: "date", inferenceType: "explicit" },
      { path: "s", type: "string", inferenceType: "explicit" },
    ]).description.split("\n");
    const dateLine = lines.find((line) => line.startsWith('- "d"'))!;
    assert.match(dateLine, /write it as ISO 8601 \(YYYY-MM-DD\)/);
    assert.doesNotMatch(dateLine, /verbatim/);
    assert.match(lines.find((line) => line.startsWith('- "s"'))!, /Copy this value verbatim/);
  });
});

describe("normalizeCandidateValue", () => {
  const number = { type: "number" as const };
  const date = { type: "date" as const };
  it("rewrites a plain decimal string for a number field and records it", () => {
    assert.deepEqual(normalizeCandidateValue("2.1", number), { value: 2.1, normalization: { kind: "string-to-number", from: "2.1" } });
    assert.deepEqual(normalizeCandidateValue(" -40 ", number), { value: -40, normalization: { kind: "string-to-number", from: " -40 " } });
    assert.deepEqual(normalizeCandidateValue("2.10", number).value, 2.1);
  });
  it("leaves every other string for a number field untouched", () => {
    for (const text of ["1,234", "007", "2.1 kg", "$5", "1e3", "5%", "-0", "", ".5", "5.", "12345678901234567890", "0.1000000000000000055", "two", "Infinity", "0x10"]) {
      assert.deepEqual(normalizeCandidateValue(text, number), { value: text }, text);
    }
  });
  it("rewrites a written English date for a date field and records it", () => {
    for (const text of ["21 March 2013", "March 21, 2013", "March 21 2013", "21st Mar 2013", "Mar. 21, 2013", " 21 march 2013 "]) {
      assert.deepEqual(normalizeCandidateValue(text, date), { value: "2013-03-21", normalization: { kind: "date-to-iso", from: text } }, text);
    }
  });
  it("leaves an ISO, ambiguous, partial or impossible date untouched", () => {
    for (const text of ["2013-03-21", "03/04/2013", "21.03.2013", "March 2013", "30 February 2013", "21 Marchtember 2013", "signed 21 March 2013", "21 March 13"]) {
      assert.deepEqual(normalizeCandidateValue(text, date), { value: text }, text);
    }
  });
  it("rewrites nothing for another type or a non-string value", () => {
    assert.deepEqual(normalizeCandidateValue("2.1", { type: "string" }), { value: "2.1" });
    assert.deepEqual(normalizeCandidateValue("21 March 2013", { type: "string" }), { value: "21 March 2013" });
    assert.deepEqual(normalizeCandidateValue("true", { type: "boolean" }), { value: "true" });
    assert.deepEqual(normalizeCandidateValue(2.1, number), { value: 2.1 });
  });
});

function providerOf(proposals: unknown[]): ExtractionProvider {
  return { name: "p", async extract() { return { proposals: proposals as never, raw: { response: "", model: "m" } }; } };
}
const explicit: TargetFieldSchema[] = [
  { path: "version", type: "number", inferenceType: "explicit" },
  { path: "signedDate", type: "date", inferenceType: "explicit" },
];
const content = "Version: 2.1\nSigned on 21 March 2013.\nSignature date: 2013-03-22\n";
const proposal = (fieldPath: string, candidateValue: unknown, excerpt: string) =>
  ({ fieldPath, candidateValue, extractor: "e", provenance: { excerpt, locator: "x" } });
const run = (proposals: unknown[]) =>
  extract({ sourceRef: "s", contentType: "text", targetSchema: explicit, content, provider: providerOf(proposals) });

describe("extract() rewrites a value into its declared type only losslessly, and says so", () => {
  it("a number answered as a plain decimal string becomes a number, recorded on the proposal and in a warning", async () => {
    const result = await run([proposal("version", "2.1", "Version: 2.1")]);
    const [only] = result.proposals;
    assert.strictEqual(only.candidateValue, 2.1);
    assert.deepEqual(only.valueNormalization, { kind: "string-to-number", from: "2.1" });
    assert.equal(only.evidenceMatch?.schema, "ok");
    assert.equal(only.evidenceMatch?.valueInExcerpt, "match");
    assert.deepEqual(result.warnings, ['coerced string value to number for "version"']);
  });

  it("a written date becomes ISO, recorded on the proposal and in a warning", async () => {
    const result = await run([proposal("signedDate", "21 March 2013", "Signed on 21 March 2013.")]);
    const [only] = result.proposals;
    assert.equal(only.candidateValue, "2013-03-21");
    assert.deepEqual(only.valueNormalization, { kind: "date-to-iso", from: "21 March 2013" });
    assert.equal(only.evidenceMatch?.schema, "ok");
    assert.equal(only.evidenceMatch?.valueInExcerpt, "match");
    assert.deepEqual(result.warnings, ['normalized date value to ISO 8601 for "signedDate"']);
  });

  it("a value already in its type carries no valueNormalization and no warning", async () => {
    const result = await run([proposal("version", 2.1, "Version: 2.1"), proposal("signedDate", "2013-03-22", "Signature date: 2013-03-22")]);
    assert.equal(result.proposals.length, 2);
    for (const item of result.proposals) assert.equal("valueNormalization" in item, false);
    assert.equal(result.warnings, undefined);
  });

  it("a value that cannot be rewritten losslessly is left as written for evidenceMatch to flag", async () => {
    const result = await run([proposal("version", "2.1 kg", "Version: 2.1"), proposal("signedDate", "03/04/2013", "Signature date: 2013-03-22")]);
    assert.deepEqual(result.proposals.map((item) => [item.candidateValue, item.evidenceMatch?.schema, "valueNormalization" in item]), [
      ["2.1 kg", "type-mismatch", false],
      ["03/04/2013", "format-invalid", false],
    ]);
    assert.equal(result.warnings, undefined);
  });

  it("the checker itself is unchanged: it still reports the written form as format-invalid", () => {
    assert.equal(schemaMatch("21 March 2013", { path: "d", type: "date" }), "format-invalid");
    assert.equal(schemaMatch("2.1", { path: "n", type: "number" }), "type-mismatch");
    assert.equal(EVIDENCE_MATCH_CHECKER_VERSION, "evidence-match-v4");
  });

  it("ignores a provider-supplied valueNormalization", async () => {
    const result = await run([{ ...proposal("version", 2.1, "Version: 2.1"), valueNormalization: { kind: "string-to-number", from: "9" } }]);
    assert.equal("valueNormalization" in result.proposals[0], false);
  });

  it("the envelope carries the record, classifies the warning, and rejects a record that does not rewrite to the value", async () => {
    const result = await run([proposal("version", "2.1", "Version: 2.1"), proposal("signedDate", "21 March 2013", "Signed on 21 March 2013.")]);
    const serialized = serializePortableExtractionResult(result);
    const envelope = deserializePortableExtractionResult(serialized);
    assert.deepEqual(envelope.result.proposals.map((item) => item.valueNormalization), [
      { kind: "string-to-number", from: "2.1" },
      { kind: "date-to-iso", from: "21 March 2013" },
    ]);
    assert.deepEqual(envelope.result.warningClassifications, [
      { category: "normalization", code: "value-normalized" },
      { category: "normalization", code: "value-normalized" },
    ]);
    const tamper = (edit: (proposals: Array<Record<string, any>>) => void) => {
      const copy = JSON.parse(serialized);
      edit(copy.result.proposals);
      return validatePortableExtractionResultEnvelope(copy);
    };
    assert.equal(tamper(() => {}).status, "valid");
    assert.equal(tamper((p) => { p[0].valueNormalization.from = "2.2"; }).status, "invalid");
    assert.equal(tamper((p) => { p[1].valueNormalization.kind = "string-to-number"; }).status, "invalid");
    assert.equal(tamper((p) => { p[0].valueNormalization.extra = 1; }).status, "invalid");
    assert.equal(tamper((p) => { p[1].valueNormalization = { kind: "date-to-iso", from: "2013-03-21" }; }).status, "invalid");
  });
});

describe("several values for one field", () => {
  it("keeps two distinct values for one field, each with its own span", async () => {
    const result = await run([
      proposal("signedDate", "21 March 2013", "Signed on 21 March 2013."),
      proposal("signedDate", "2013-03-22", "Signature date: 2013-03-22"),
    ]);
    assert.deepEqual(result.proposals.map((item) => [item.fieldPath, item.candidateValue]), [
      ["signedDate", "2013-03-21"],
      ["signedDate", "2013-03-22"],
    ]);
    assert.notEqual(result.proposals[0].provenance.locator, result.proposals[1].provenance.locator);
  });

  it("keeps two distinct values grounded in the same span", async () => {
    const result = await run([proposal("version", 2.1, "Version: 2.1"), proposal("version", 2, "Version: 2.1")]);
    assert.deepEqual(result.proposals.map((item) => item.candidateValue), [2.1, 2]);
  });

  it("does not multiply one value: the string and number forms of one span are one proposal", async () => {
    const result = await run([proposal("version", "2.1", "Version: 2.1"), proposal("version", 2.1, "Version: 2.1"), proposal("version", "2.10", "Version: 2.1")]);
    assert.equal(result.proposals.length, 1);
    assert.strictEqual(result.proposals[0].candidateValue, 2.1);
    assert.ok(result.warnings?.includes("dropped 2 duplicate proposals (same field + value + source span)"));
  });
});

describe("sameResolvedOccurrence", () => {
  const base: ExactOccurrenceResolution = {
    resolverVersion: "exact-occurrence-v1", count: 2, selected: { index: 1, start: 10, end: 14 },
    selection: "occurrence-hint", hintUsed: true, ambiguous: true,
  };
  it("ignores how the occurrence was selected", () => {
    const unhinted: ExactOccurrenceResolution = { ...base, selection: "source-order", hintUsed: false };
    assert.equal(sameResolvedOccurrence(base, unhinted), true);
    assert.notDeepEqual(base, unhinted);
  });
  it("distinguishes a different span, index, count or resolver version", () => {
    assert.equal(sameResolvedOccurrence(base, { ...base, selected: { index: 0, start: 2, end: 6 } }), false);
    assert.equal(sameResolvedOccurrence(base, { ...base, selected: { ...base.selected, end: 15 } }), false);
    assert.equal(sameResolvedOccurrence(base, { ...base, selected: { ...base.selected, start: 9 } }), false);
    assert.equal(sameResolvedOccurrence(base, { ...base, selected: { ...base.selected, index: 0 } }), false);
    assert.equal(sameResolvedOccurrence(base, { ...base, count: 3 }), false);
    assert.equal(sameResolvedOccurrence(base, { ...base, resolverVersion: "exact-occurrence-v2" as never }), false);
  });
  it("two runs of one document that differ only in whether the hint was sent resolve the same occurrence", async () => {
    const hinted = await run([{ ...proposal("version", 2.1, "Version: 2.1"), occurrenceHint: 1 }]);
    const unhinted = await run([proposal("version", 2.1, "Version: 2.1")]);
    const [a, b] = [hinted.proposals[0].provenance.occurrence!, unhinted.proposals[0].provenance.occurrence!];
    assert.deepEqual([a.selection, b.selection], ["occurrence-hint", "source-order"]);
    assert.equal(sameResolvedOccurrence(a, b), true);
  });
});
