// Anthropic adapter tests. All tests use an injected fake client — no network,
// no ANTHROPIC_API_KEY. They assert the request shape (dynamic tool schema built
// from the caller's TargetFieldSchema, forced tool_choice, model), the response
// parsing (provenance-bearing proposals, raw.model/raw.tokensUsed, and defensive
// handling of malformed output), and the adapter's warnings channel (malformed
// tool items, maxTokens truncation) — nothing the adapter drops or notices is
// silent.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExtractionTool,
  createAnthropicExtractionProvider,
  parseProposals,
  resolveSdkClientOptions,
} from "../src/anthropic.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";
import {
  fakeAnthropicClient,
  fakeAnthropicMessage,
  fakeAnthropicTextMessage,
} from "./fixtures/mock-provider.js";

const TOOL_NAME = "submit_extraction_proposals";

function wellFormedInput() {
  return {
    proposals: [
      {
        fieldPath: "title",
        value: "Beginner Bouldering Session",
        confidence: 0.92,
        excerpt: "Beginner Bouldering Session",
      },
      {
        fieldPath: "priceAmount",
        value: 24,
        confidence: 0.8,
        excerpt: "Drop-in price: $24 per person.",
        locator: "html:field:priceAmount",
      },
    ],
  };
}

describe("createAnthropicExtractionProvider", () => {
  it("parses a well-formed tool_use response into provenance-bearing proposals", async () => {
    const client = fakeAnthropicClient(
      fakeAnthropicMessage(TOOL_NAME, wellFormedInput(), { inputTokens: 200, outputTokens: 80 }),
    );
    const provider = createAnthropicExtractionProvider({ client });
    const out = await provider.extract({
      content: "prepared text",
      contentType: "html",
      targetSchema: genericTargetSchema,
    });

    assert.equal(out.proposals.length, 2);
    assert.equal(out.proposals[0].fieldPath, "title");
    assert.equal(out.proposals[0].provenance.excerpt, "Beginner Bouldering Session");
    // Missing locator synthesized deterministically (provisional — extract()'s
    // normalization is the sole owner of the final locator value).
    assert.equal(out.proposals[0].provenance.locator, "html:field:title");
    // Provided locator preserved at the adapter layer.
    assert.equal(out.proposals[1].provenance.locator, "html:field:priceAmount");
    // extractor identity stamped from the provider name.
    assert.equal(out.proposals[0].extractor, "anthropic-extraction-provider:claude-sonnet-4-6");

    // raw carries model + token usage.
    assert.equal(out.raw.model, "claude-sonnet-4-6");
    assert.equal(out.raw.tokensUsed, 280);

    // Well-formed, non-truncated response: no warnings key at all.
    assert.equal(out.warnings, undefined);
  });

  it("sends a forced tool-use request whose tool schema is built from the target schema", async () => {
    const client = fakeAnthropicClient(fakeAnthropicMessage(TOOL_NAME, { proposals: [] }));
    const provider = createAnthropicExtractionProvider({ client });
    await provider.extract({
      content: "prepared text",
      contentType: "html",
      targetSchema: genericTargetSchema,
      fieldHints: { title: "the session name" },
    });

    assert.equal(client.calls.length, 1);
    const call = client.calls[0];
    assert.deepEqual(call.tool_choice, { type: "tool", name: TOOL_NAME });
    assert.equal(call.tools.length, 1);
    assert.equal(call.tools[0].name, TOOL_NAME);
    // Dynamic tool description enumerates the caller's fields.
    assert.match(call.tools[0].description, /"title"/);
    assert.match(call.tools[0].description, /"priceAmount"/);
    // Field hints are serialized into the prompt.
    assert.match(call.messages[0].content, /the session name/);
    // Prepared content is serialized into the prompt.
    assert.match(call.messages[0].content, /prepared text/);
  });

  it("returns empty proposals (never throws) when the model does not use the tool", async () => {
    const client = fakeAnthropicClient(fakeAnthropicTextMessage("I could not extract anything."));
    const provider = createAnthropicExtractionProvider({ client });
    const out = await provider.extract({
      content: "prepared text",
      contentType: "html",
      targetSchema: genericTargetSchema,
    });
    assert.equal(out.proposals.length, 0);
    assert.equal(out.raw.response, "");
  });

  it("drops malformed tool items (missing excerpt / out-of-range confidence) and reports each drop as a warning", async () => {
    const client = fakeAnthropicClient(
      fakeAnthropicMessage(TOOL_NAME, {
        proposals: [
          { fieldPath: "title", value: "x", confidence: 0.5 }, // no excerpt -> dropped
          { fieldPath: "title", value: "y", confidence: 5, excerpt: "y" }, // bad confidence -> dropped
          { fieldPath: "title", value: "z", confidence: 0.7, excerpt: "z" }, // kept
        ],
      }),
    );
    const provider = createAnthropicExtractionProvider({ client });
    const out = await provider.extract({
      content: "prepared text",
      contentType: "html",
      targetSchema: genericTargetSchema,
    });
    assert.equal(out.proposals.length, 1);
    assert.equal(out.proposals[0].candidateValue, "z");
    // Both drops are reported — nothing is silently discarded.
    assert.equal(out.warnings?.length, 2);
    assert.ok(out.warnings?.some((w) => /index 0/.test(w) && /missing\/blank excerpt/.test(w)));
    assert.ok(out.warnings?.some((w) => /index 1/.test(w) && /missing\/out-of-range confidence/.test(w)));
  });

  it("warns when the response is truncated at maxTokens, without discarding whatever proposals parsed", async () => {
    const client = fakeAnthropicClient(
      fakeAnthropicMessage(
        TOOL_NAME,
        { proposals: [{ fieldPath: "title", value: "z", confidence: 0.7, excerpt: "z" }] },
        { stopReason: "max_tokens" },
      ),
    );
    const provider = createAnthropicExtractionProvider({ client });
    const out = await provider.extract({
      content: "prepared text",
      contentType: "html",
      targetSchema: genericTargetSchema,
    });
    assert.equal(out.proposals.length, 1);
    assert.ok(out.warnings?.includes("response truncated at maxTokens; proposals may be incomplete"));
  });

  it("defaults the model to claude-sonnet-4-6 and reflects it in provider.name", () => {
    const provider = createAnthropicExtractionProvider();
    assert.equal(provider.name, "anthropic-extraction-provider:claude-sonnet-4-6");
  });

  it("honors opts.model override in provider.name and the request", async () => {
    const client = fakeAnthropicClient(
      fakeAnthropicMessage(TOOL_NAME, { proposals: [] }, { model: "claude-opus-4-1" }),
    );
    const provider = createAnthropicExtractionProvider({ client, model: "claude-opus-4-1" });
    assert.equal(provider.name, "anthropic-extraction-provider:claude-opus-4-1");
    await provider.extract({
      content: "c",
      contentType: "text",
      targetSchema: genericTargetSchema,
    });
    assert.equal(client.calls[0].model, "claude-opus-4-1");
  });

  it("does not reflect baseUrl in provider.name when unset (default behavior unchanged)", () => {
    const provider = createAnthropicExtractionProvider({ client: fakeAnthropicClient(fakeAnthropicMessage(TOOL_NAME, { proposals: [] })) });
    assert.equal(provider.name, "anthropic-extraction-provider:claude-sonnet-4-6");
  });

  it("reflects a custom baseUrl's host as a name suffix, for parity reports to distinguish backends", () => {
    const provider = createAnthropicExtractionProvider({
      client: fakeAnthropicClient(fakeAnthropicMessage(TOOL_NAME, { proposals: [] })),
      model: "glm-4.6",
      baseUrl: "https://api.z.ai/api/anthropic",
    });
    assert.equal(provider.name, "anthropic-extraction-provider:glm-4.6@api.z.ai");
  });
});

describe("resolveSdkClientOptions (unit)", () => {
  it("passes opts.baseUrl through to the SDK constructor options as baseURL", () => {
    assert.deepEqual(
      resolveSdkClientOptions({ apiKey: "k", baseUrl: "https://api.z.ai/api/anthropic" }),
      { apiKey: "k", baseURL: "https://api.z.ai/api/anthropic" },
    );
  });

  it("omits baseURL entirely when opts.baseUrl is unset, preserving the SDK's own ANTHROPIC_BASE_URL env fallback", () => {
    const result = resolveSdkClientOptions({ apiKey: "k" });
    assert.deepEqual(result, { apiKey: "k" });
    assert.ok(!("baseURL" in result));
  });

  it("throws when no apiKey is available from opts or ANTHROPIC_API_KEY", () => {
    const savedKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      assert.throws(() => resolveSdkClientOptions({}), /no API key/);
    } finally {
      if (savedKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedKey;
    }
  });
});

describe("buildExtractionTool / parseProposals (units)", () => {
  it("requires fieldPath, value, confidence, and excerpt in the tool schema", () => {
    const tool = buildExtractionTool(genericTargetSchema);
    const itemRequired = (tool.input_schema.properties.proposals as {
      items: { required: string[] };
    }).items.required;
    assert.deepEqual([...itemRequired].sort(), ["confidence", "excerpt", "fieldPath", "value"]);
    const properties = (tool.input_schema.properties.proposals as {
      items: { properties: Record<string, { type?: string; minimum?: number }> };
    }).items.properties;
    assert.deepEqual(properties.occurrenceHint, {
      type: "integer",
      minimum: 1,
      description: "Optional 1-based occurrence of the exact repeated excerpt.",
    });
  });

  it("returns empty proposals/warnings for non-record / missing proposals input", () => {
    assert.deepEqual(parseProposals(undefined, "x", "html"), { proposals: [], warnings: [] });
    assert.deepEqual(parseProposals({ nope: 1 }, "x", "html"), { proposals: [], warnings: [] });
    assert.deepEqual(parseProposals("string", "x", "html"), { proposals: [], warnings: [] });
  });

  it("preserves an optional integer occurrence hint for exact resolver verification", () => {
    const parsed = parseProposals({
      proposals: [{ fieldPath: "title", value: "Alpha", confidence: 0.8, excerpt: "Alpha", occurrenceHint: 2 }],
    }, "fixture", "text");
    assert.equal(parsed.proposals[0].occurrenceHint, 2);
  });

  describe("inferenceType prompt guidance", () => {
    it("[AC5] produces a BYTE-IDENTICAL description for the untagged genericTargetSchema fixture", () => {
      const tool = buildExtractionTool(genericTargetSchema);
      assert.equal(
        tool.description,
        [
          "Submit an array of extraction proposals for the requested target fields.",
          "You are PROPOSING for review — every proposal is a reviewable record, not a resolved value.",
          "For EACH field you can find in the content, return one proposal with:",
          "  - fieldPath: the exact target field path from the list below,",
          "  - value: the extracted value (typed per the field),",
          "  - confidence: 0.0-1.0,",
          "  - excerpt: the VERBATIM span of source text the value was drawn from (required — no excerpt, no proposal).",
          "  - occurrenceHint: optional 1-based occurrence of that exact excerpt when it repeats; omit it when uncertain.",
          "Only propose fields you can ground in a verbatim excerpt. Omit fields you cannot find.",
          "",
          "Target fields:",
          "- \"title\" (string, required) The name of the activity or session.",
          "- \"priceAmount\" (number) The drop-in price in whole currency units.",
          "- \"scheduleSummary\" (string) A short human-readable summary of when the activity runs.",
          "- \"schedules[].startDate\" (date) The start date of one schedule item in a repeating series.",
        ].join("\n"),
      );
    });

    it("appends a verbatim-copy sentence for explicit fields, a derived-value sentence for inferred fields, and NOTHING extra for untagged fields", () => {
      const tool = buildExtractionTool([
        { path: "explicitField", type: "string", inferenceType: "explicit" },
        { path: "inferredField", type: "string", inferenceType: "inferred" },
        { path: "untaggedField", type: "string" },
      ]);
      const lines = tool.description.split("\n");
      const explicitLine = lines.find((l) => l.startsWith('- "explicitField"'));
      const inferredLine = lines.find((l) => l.startsWith('- "inferredField"'));
      const untaggedLine = lines.find((l) => l.startsWith('- "untaggedField"'));

      assert.equal(explicitLine, '- "explicitField" (string) Copy this value verbatim from the source text — do not paraphrase, reformat, or normalize it.');
      assert.equal(inferredLine, '- "inferredField" (string) This value may be derived, normalized, or classified from the source text — it still needs a grounding excerpt, but the value itself need not match verbatim.');
      // Untagged field's rendered line is byte-identical to the pre-change format: just the type, no trailing sentence.
      assert.equal(untaggedLine, '- "untaggedField" (string)');
    });

    it("leaves input_schema (fieldPath/value/confidence/excerpt shape and required list) unchanged when fields are inferenceType-tagged", () => {
      const tool = buildExtractionTool([
        { path: "explicitField", type: "string", inferenceType: "explicit" },
        { path: "inferredField", type: "string", inferenceType: "inferred" },
      ]);
      const itemRequired = (tool.input_schema.properties.proposals as {
        items: { required: string[] };
      }).items.required;
      assert.deepEqual([...itemRequired].sort(), ["confidence", "excerpt", "fieldPath", "value"]);
    });
  });
});
