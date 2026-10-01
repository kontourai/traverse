import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime, RecordingModelRuntime } from "@kontourai/relay";
import { importExtractionEnvelope } from "@kontourai/survey";
import {
  deserializePortableExtractionResult,
  extract,
  sameResolvedOccurrence,
  serializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
} from "../src/index.js";
import type { ExactOccurrenceResolution, ExtractionProvider, TargetFieldSchema } from "../src/index.js";
import {
  MAX_ENUM_VALUE_VARIANTS,
  buildExtractionMessages,
  buildExtractionTool,
  buildStrictExtractionSchema,
  createAnthropicExtractionProvider,
  enumFieldsLeftUnrestricted,
  enumValuesUnrestrictedWarnings,
} from "../src/anthropic.js";
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

describe("enum variants are capped so the schema stays bounded", () => {
  const enums = (count: number): TargetFieldSchema[] =>
    Array.from({ length: count }, (_, i) => ({ path: `e${i}`, type: "enum" as const, enumValues: [`a${i}`, `b${i}`] }));
  const variantsOf = (schema: unknown) => (schema as { properties: { proposals: { items: { anyOf: Variant[] } } } }).properties.proposals.items.anyOf;

  it("pins the cap", () => assert.equal(MAX_ENUM_VALUE_VARIANTS, 8));

  it("at the cap every enum is restricted and nothing is reported", () => {
    const schema = enums(8);
    assert.equal(variantsOf(buildStrictExtractionSchema(schema)).length, 8);
    assert.deepEqual(enumFieldsLeftUnrestricted(schema), []);
    assert.deepEqual(enumValuesUnrestrictedWarnings(schema), []);
  });

  it("past the cap the overflow enums share one plain-string variant, in both dialects", () => {
    const schema = enums(200);
    for (const built of [buildStrictExtractionSchema(schema), buildExtractionTool(schema).input_schema]) {
      const variants = variantsOf(built);
      assert.equal(variants.length, 9);
      assert.deepEqual(valueSchemaFor(built, "e7"), { type: "string", enum: ["a7", "b7"] });
      assert.deepEqual(valueSchemaFor(built, "e8"), { type: "string" });
      assert.deepEqual(valueSchemaFor(built, "e199"), { type: "string" });
      assert.ok(JSON.stringify(built).length < 12_000, `schema is ${JSON.stringify(built).length} bytes`);
    }
    assert.deepEqual(enumFieldsLeftUnrestricted(schema), schema.slice(8).map((field) => field.path));
  });

  it("fields sharing one enum count once against the cap", () => {
    const shared = Array.from({ length: 50 }, (_, i) => ({ path: `s${i}`, type: "enum" as const, enumValues: ["x", "y"] }));
    assert.deepEqual(enumFieldsLeftUnrestricted([...enums(7), ...shared]), []);
  });

  it("every adapter warns that typing was not applied, and extract() reports it once across chunks", async () => {
    const schema = enums(10);
    const expected = 'provider tool schema left enum values unrestricted for 2 field(s) (more than 8 distinct enums): "e8", "e9"';
    assert.deepEqual(enumValuesUnrestrictedWarnings(schema), [expected]);
    const overInput = { content: "x", contentType: "text" as const, targetSchema: schema };
    const outputs = [
      await createAnthropicExtractionProvider({ client: { async create() { return { id: "m", type: "message", role: "assistant", model: "a", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t", name: "submit_extraction_proposals", input: noProposals }] }; } } }).extract(overInput),
      await createOpenAIExtractionProvider({ client: { async create() { return { model: "o", choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "submit_extraction_proposals", arguments: JSON.stringify(noProposals) } }] } }] }; } } }).extract(overInput),
      await createGeminiExtractionProvider({ client: { async generateContent() { return { functionCalls: [{ name: "submit_extraction_proposals", args: noProposals }] }; } } }).extract(overInput),
      await createRelayExtractionProvider({ runtime: new FakeModelRuntime([{ provider: "fixture", model: "r", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: noProposals }], usage: {}, latencyMs: 0 }]) }).extract(overInput),
    ];
    for (const output of outputs) assert.deepEqual(output.warnings, [expected]);

    const responses = Array.from({ length: 3 }, () => ({ provider: "fixture", model: "r", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: noProposals }], usage: {}, latencyMs: 0 }));
    const result = await extract({
      sourceRef: "s", contentType: "text", targetSchema: schema, content: "word ".repeat(60), chunkSize: 120, chunkOverlap: 0,
      provider: createRelayExtractionProvider({ runtime: new FakeModelRuntime(responses) }),
    });
    assert.equal(result.providerCalls, 3);
    assert.equal(result.warnings?.filter((warning) => warning === expected).length, 1);
    const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result));
    assert.ok(envelope.result.warningClassifications?.some((item) => item.category === "provider" && item.code === "provider-warning"));
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
    assert.deepEqual(normalizeCandidateValue("0.5", number).value, 0.5);
    assert.deepEqual(normalizeCandidateValue("1000", number).value, 1000);
  });
  it("leaves every other string for a number field untouched", () => {
    for (const text of ["2.10", "1.000", "1.0", "5.50", "1,234", "007", "2.1 kg", "$5", "1e3", "5%", "-0", "", ".5", "5.", "12345678901234567890", "0.1000000000000000055", "two", "Infinity", "0x10"]) {
      assert.deepEqual(normalizeCandidateValue(text, number), { value: text }, text);
    }
  });
  it("rewrites a written English date for a date field and records it", () => {
    for (const text of ["21 March 2013", "March 21, 2013", "March 21 2013", "21st Mar 2013", "Mar. 21, 2013", " 21 march 2013 "]) {
      assert.deepEqual(normalizeCandidateValue(text, date), { value: "2013-03-21", normalization: { kind: "date-to-iso", from: text } }, text);
    }
  });
  it("leaves an ISO, ambiguous, partial or impossible date untouched", () => {
    for (const text of ["2013-03-21", "03/04/2013", "21.03.2013", "March 2013", "30 February 2013", "21 Marchtember 2013", "signed 21 March 2013", "21 March 13", "21 March 0000", "21 March 0999", "21 March 3000"]) {
      assert.deepEqual(normalizeCandidateValue(text, date), { value: text }, text);
    }
  });
  it("accepts the first and last plausible year", () => {
    assert.equal(normalizeCandidateValue("1 January 1000", date).value, "1000-01-01");
    assert.equal(normalizeCandidateValue("31 December 2999", date).value, "2999-12-31");
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
    assert.deepEqual(result.warnings, ['coerced string value "2.1" to number for "version"']);
  });

  it("a written date becomes ISO, recorded on the proposal and in a warning", async () => {
    const result = await run([proposal("signedDate", "21 March 2013", "Signed on 21 March 2013.")]);
    const [only] = result.proposals;
    assert.equal(only.candidateValue, "2013-03-21");
    assert.deepEqual(only.valueNormalization, { kind: "date-to-iso", from: "21 March 2013" });
    assert.equal(only.evidenceMatch?.schema, "ok");
    assert.equal(only.evidenceMatch?.valueInExcerpt, "match");
    assert.deepEqual(result.warnings, ['normalized date value "21 March 2013" to ISO 8601 for "signedDate"']);
  });

  it("a value already in its type carries no valueNormalization and no warning", async () => {
    const result = await run([proposal("version", 2.1, "Version: 2.1"), proposal("signedDate", "2013-03-22", "Signature date: 2013-03-22")]);
    assert.equal(result.proposals.length, 2);
    for (const item of result.proposals) assert.equal("valueNormalization" in item, false);
    assert.equal(result.warnings, undefined);
  });

  it("a value that cannot be rewritten losslessly is left as written for evidenceMatch to flag", async () => {
    const result = await run([proposal("version", "2.1 kg", "Version: 2.1"), proposal("signedDate", "03/04/2013", "Signature date: 2013-03-22"), proposal("version", "2.10", "Version: 2.1"), proposal("version", "1.000", "Version: 2.1")]);
    assert.deepEqual(result.proposals.map((item) => [item.candidateValue, item.evidenceMatch?.schema, "valueNormalization" in item]), [
      ["2.1 kg", "type-mismatch", false],
      ["03/04/2013", "format-invalid", false],
      ["2.10", "type-mismatch", false],
      ["1.000", "type-mismatch", false],
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

  it("the envelope stays in its released shape: no new proposal key, the rewrite as an existing warning code", async () => {
    const result = await run([proposal("version", "2.1", "Version: 2.1"), proposal("signedDate", "21 March 2013", "Signed on 21 March 2013.")]);
    assert.equal(result.proposals.filter((item) => item.valueNormalization).length, 2);
    const serialized = serializePortableExtractionResult(result);
    assert.equal(serialized.includes("valueNormalization"), false);
    const envelope = deserializePortableExtractionResult(serialized);
    assert.deepEqual(envelope.result.proposals.map((item) => item.candidateValue), [2.1, "2013-03-21"]);
    assert.deepEqual(envelope.result.proposals.map((item) => item.evidenceMatch?.schema), ["ok", "ok"]);
    assert.deepEqual(envelope.result.warningClassifications, [
      { category: "normalization", code: "proposal-normalization" },
      { category: "normalization", code: "proposal-normalization" },
    ]);
    // The key is not part of the wire contract in either direction.
    const withKey = JSON.parse(serialized);
    withKey.result.proposals[0].valueNormalization = { kind: "string-to-number", from: "2.1" };
    assert.equal(validatePortableExtractionResultEnvelope(withKey).status, "invalid");
  });

  it("an envelope from a run with rewritten values imports under the published Survey reader", async () => {
    const result = await run([proposal("version", "2.1", "Version: 2.1"), proposal("signedDate", "21 March 2013", "Signed on 21 March 2013.")]);
    const imported = importExtractionEnvelope(serializePortableExtractionResult(result), {
      sourceKind: "uploaded-document",
      claimTarget: (item: { fieldPath: string }) => ({
        subjectType: "fixture", subjectId: "fixture-1", facet: "fixture", claimType: "field-value",
        fieldOrBehavior: item.fieldPath, impactLevel: "low",
      }),
    });
    assert.deepEqual(imported.record.spec.envelope.result.proposals.map((item: { candidateValue: unknown }) => item.candidateValue), [2.1, "2013-03-21"]);
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
    const result = await run([proposal("version", "2.1", "Version: 2.1"), proposal("version", 2.1, "Version: 2.1"), proposal("version", " 2.1", "Version: 2.1")]);
    assert.equal(result.proposals.length, 1);
    assert.strictEqual(result.proposals[0].candidateValue, 2.1);
    assert.deepEqual(result.warnings, ["dropped 2 duplicate proposals (same field + value + source span)"]);
  });

  const written = { ...proposal("signedDate", "21 March 2013", "Signed on 21 March 2013."), extractor: "written" };
  const monthFirst = { ...proposal("signedDate", "March 21, 2013", "Signed on 21 March 2013."), extractor: "month-first" };
  const iso = { ...proposal("signedDate", "2013-03-21", "Signed on 21 March 2013."), extractor: "iso" };
  const text = { ...proposal("version", "2.1", "Version: 2.1"), extractor: "text" };
  const typed = { ...proposal("version", 2.1, "Version: 2.1"), extractor: "typed" };

  for (const [label, order] of [["typed first", [iso, written, typed, text]], ["rewritten first", [written, iso, text, typed]]] as const) {
    it(`a typed duplicate survives a rewritten one whatever the provider order (${label})`, async () => {
      const result = await run([...order]);
      assert.deepEqual(result.proposals.map((item) => [item.fieldPath, item.candidateValue, item.extractor, item.valueNormalization]).sort(), [
        ["signedDate", "2013-03-21", "iso", undefined],
        ["version", 2.1, "typed", undefined],
      ]);
      // No warning for a record no proposal carries.
      assert.deepEqual(result.warnings, ["dropped 2 duplicate proposals (same field + value + source span)"]);
    });
  }

  for (const [label, order] of [["one order", [written, monthFirst]], ["the other", [monthFirst, written]]] as const) {
    it(`two rewritten duplicates leave the same survivor and exactly its warning (${label})`, async () => {
      const result = await run([...order]);
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0].extractor, "written");
      assert.deepEqual(result.proposals[0].valueNormalization, { kind: "date-to-iso", from: "21 March 2013" });
      assert.deepEqual(result.warnings, [
        "dropped 1 duplicate proposal (same field + value + source span)",
        'normalized date value "21 March 2013" to ISO 8601 for "signedDate"',
      ]);
    });
  }
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
