// Anthropic adapter tests. All tests use an injected fake client — no network,
// no ANTHROPIC_API_KEY. They assert the request shape (dynamic tool schema built
// from the caller's TargetFieldSchema, forced tool_choice, model) and the
// response parsing (provenance-bearing proposals, raw.model/raw.tokensUsed, and
// defensive handling of malformed output).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExtractionTool,
  createAnthropicExtractionProvider,
  parseProposals,
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
    // Missing locator synthesized deterministically.
    assert.equal(out.proposals[0].provenance.locator, "html:field:title");
    // Provided locator preserved.
    assert.equal(out.proposals[1].provenance.locator, "html:field:priceAmount");
    // extractor identity stamped from the provider name.
    assert.equal(out.proposals[0].extractor, "anthropic-extraction-provider:claude-sonnet-4-6");

    // raw carries model + token usage.
    assert.equal(out.raw.model, "claude-sonnet-4-6");
    assert.equal(out.raw.tokensUsed, 280);
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

  it("drops malformed tool items (missing excerpt / out-of-range confidence)", async () => {
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
});

describe("buildExtractionTool / parseProposals (units)", () => {
  it("requires fieldPath, value, confidence, and excerpt in the tool schema", () => {
    const tool = buildExtractionTool(genericTargetSchema);
    const itemRequired = (tool.input_schema.properties.proposals as {
      items: { required: string[] };
    }).items.required;
    assert.deepEqual([...itemRequired].sort(), ["confidence", "excerpt", "fieldPath", "value"]);
  });

  it("returns [] for non-record / missing proposals input", () => {
    assert.deepEqual(parseProposals(undefined, "x", "html"), []);
    assert.deepEqual(parseProposals({ nope: 1 }, "x", "html"), []);
    assert.deepEqual(parseProposals("string", "x", "html"), []);
  });
});
