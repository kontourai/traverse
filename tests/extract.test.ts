import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract } from "../src/extract.js";
import type { ExtractionProposal, ProviderExtractionOutput } from "../src/index.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

function proposal(overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  return {
    fieldPath: "title",
    candidateValue: "Beginner Bouldering Session",
    confidence: 0.9,
    provenance: { excerpt: "Beginner Bouldering Session", locator: "html:field:title" },
    extractor: "mock-extraction-provider",
    ...overrides,
  };
}

function output(
  proposals: ExtractionProposal[],
  warnings?: string[],
): ProviderExtractionOutput {
  return {
    proposals,
    raw: { response: "{}", model: "mock-model", tokensUsed: 42 },
    ...(warnings ? { warnings } : {}),
  };
}

describe("extract()", () => {
  it("returns well-formed proposals with a verified excerpt and a derived chars: locator", async () => {
    const provider = createMockExtractionProvider(output([proposal()]));
    const result = await extract({
      content: "<p>Beginner Bouldering Session</p>",
      contentType: "html",
      sourceRef: "https://example.test/schedule",
      targetSchema: genericTargetSchema,
      provider,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].provenance.excerpt, "Beginner Bouldering Session");
    // "Beginner Bouldering Session" occurs at offset 0 in the prepared text
    // ("<p>...</p>" strips to exactly that string), length 27 — normalization
    // always derives/overwrites the locator from the verified offset, ignoring
    // whatever the provider supplied ("html:field:title" in `proposal()`).
    assert.equal(result.proposals[0].provenance.locator, "chars:0-27");
    assert.equal(result.raw.model, "mock-model");
    assert.equal(result.raw.tokensUsed, 42);
    assert.match(result.extractedAt, /\dT\d/);
  });

  it("respects maxContentChars when preparing content for the provider", async () => {
    const provider = createMockExtractionProvider(output([]));
    await extract({
      content: "<p>" + "a".repeat(500) + "</p>",
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      maxContentChars: 50,
    });
    assert.equal(provider.calls.length, 1);
    assert.ok(provider.calls[0].content.length <= 50, "content handed to provider is truncated");
  });

  it("never throws when the provider rejects — surfaces ExtractionResult.error", async () => {
    const provider = createMockExtractionProvider(output([]), {
      throwError: new Error("provider boom"),
    });
    const result = await extract({
      content: "text",
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 0);
    assert.equal(result.error, "provider boom");
  });

  it("returns a typed error for deferred pdf content without calling the provider", async () => {
    const provider = createMockExtractionProvider(output([]));
    const result = await extract({
      content: new Uint8Array([1, 2, 3]),
      contentType: "pdf",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.match(result.error ?? "", /not implemented/);
    assert.equal(provider.calls.length, 0);
  });

  it("drops proposals with an unknown fieldPath and records a warning", async () => {
    const provider = createMockExtractionProvider(
      output([proposal({ fieldPath: "notInSchema" })]),
    );
    const result = await extract({
      content: "text",
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 0);
    assert.ok(result.warnings?.some((w) => /unknown fieldPath "notInSchema"/.test(w)));
  });

  it("drops proposals lacking a provenance excerpt", async () => {
    const bad = proposal();
    // Simulate a provider that violated the contract at runtime.
    (bad as { provenance: { excerpt: string; locator: string } }).provenance = {
      excerpt: "",
      locator: "html:field:title",
    };
    const provider = createMockExtractionProvider(output([bad]));
    const result = await extract({
      content: "text",
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 0);
    assert.ok(result.warnings?.some((w) => /missing provenance excerpt/.test(w)));
  });

  it("drops a proposal whose excerpt does not occur in the prepared content, with a warning", async () => {
    // The prepared content never mentions "Beginner Bouldering Session" — the
    // provenance contract is ENFORCED (indexOf against the prepared text), not
    // merely trusted because the field is present and non-empty.
    const provider = createMockExtractionProvider(output([proposal()]));
    const result = await extract({
      content: "This page describes an entirely different activity.",
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 0);
    assert.ok(
      result.warnings?.some((w) => w === 'dropped proposal for "title": excerpt not found in prepared content'),
    );
  });

  it("derives provenance.locator from the verified excerpt offset (non-zero offset)", async () => {
    const content = "Intro noise before the real content. Beginner Bouldering Session. Trailing notes.";
    const expectedIndex = content.indexOf("Beginner Bouldering Session");
    const provider = createMockExtractionProvider(output([proposal()]));
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 1);
    assert.equal(
      result.proposals[0].provenance.locator,
      `chars:${expectedIndex}-${expectedIndex + "Beginner Bouldering Session".length}`,
    );
  });

  it("anchors the locator to the FIRST occurrence when the excerpt appears more than once", async () => {
    const content = "Beginner Bouldering Session (repeat: Beginner Bouldering Session).";
    const provider = createMockExtractionProvider(output([proposal()]));
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 1);
    // indexOf finds the first match (offset 0), not the later repeated one.
    assert.equal(result.proposals[0].provenance.locator, "chars:0-27");
  });

  it("clamps out-of-range confidence into 0..1 and warns", async () => {
    const content = "Beginner Bouldering Session — full details for this listing.";
    const provider = createMockExtractionProvider(
      output([proposal({ confidence: 1.7 }), proposal({ fieldPath: "priceAmount", confidence: -0.5 })]),
    );
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 2);
    const byField = Object.fromEntries(result.proposals.map((p) => [p.fieldPath, p.confidence]));
    assert.equal(byField["title"], 1);
    assert.equal(byField["priceAmount"], 0);
    assert.ok(result.warnings?.some((w) => /clamped out-of-range confidence/.test(w)));
  });

  it("omits `warnings` entirely when there is nothing to report", async () => {
    const content = "Beginner Bouldering Session details.";
    const provider = createMockExtractionProvider(output([proposal()]));
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 1);
    assert.equal(result.warnings, undefined);
  });

  it("merges provider warnings with normalization warnings on the final result", async () => {
    const content = "Beginner Bouldering Session details.";
    const provider = createMockExtractionProvider(
      output([proposal({ fieldPath: "notInSchema" })], ["response truncated at maxTokens; proposals may be incomplete"]),
    );
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 0);
    // Provider-side warning survives end-to-end...
    assert.ok(result.warnings?.includes("response truncated at maxTokens; proposals may be incomplete"));
    // ...alongside extract()'s own normalization warning for the same call.
    assert.ok(result.warnings?.some((w) => /unknown fieldPath "notInSchema"/.test(w)));
    // Provider warnings are surfaced ahead of normalization warnings.
    assert.equal(result.warnings?.[0], "response truncated at maxTokens; proposals may be incomplete");
  });
});
