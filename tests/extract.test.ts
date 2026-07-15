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

  describe("indexed fieldPath normalization (against declared array paths)", () => {
    it("accepts an indexed fieldPath that normalizes to a declared array path, warning-free", async () => {
      // genericTargetSchema declares "schedules[].startDate"; the provider emits
      // the indexed form a real model (glm-5.2, observed in a pilot adjudication)
      // produces.
      const content = "Session begins March 3.";
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "schedules[0].startDate",
            candidateValue: "2026-03-03",
            provenance: { excerpt: "March 3", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content,
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
      assert.equal(result.proposals.length, 1);
      // Rewritten to the declared (un-indexed) schema path...
      assert.equal(result.proposals[0].fieldPath, "schedules[].startDate");
      // ...with the stripped index preserved for grouping.
      assert.deepEqual(result.proposals[0].pathIndices, [0]);
      // Excerpt/locator enforcement still ran, unchanged, against the normalized proposal.
      const expectedIndex = content.indexOf("March 3");
      assert.equal(
        result.proposals[0].provenance.locator,
        `chars:${expectedIndex}-${expectedIndex + "March 3".length}`,
      );
      // Happy path: normalization itself never produces a warning.
      assert.equal(result.warnings, undefined);
    });

    it("preserves distinct indices for multiple proposals from different array items", async () => {
      const content = "First session March 3. Second session April 4.";
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "schedules[0].startDate",
            candidateValue: "2026-03-03",
            provenance: { excerpt: "March 3", locator: "provisional" },
          }),
          proposal({
            fieldPath: "schedules[1].startDate",
            candidateValue: "2026-04-04",
            provenance: { excerpt: "April 4", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content,
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
      assert.equal(result.proposals.length, 2);
      const byIndex = Object.fromEntries(
        result.proposals.map((p) => [p.pathIndices?.[0], p]),
      );
      assert.equal(byIndex[0]?.fieldPath, "schedules[].startDate");
      assert.equal(byIndex[0]?.candidateValue, "2026-03-03");
      assert.equal(byIndex[1]?.fieldPath, "schedules[].startDate");
      assert.equal(byIndex[1]?.candidateValue, "2026-04-04");
      assert.equal(result.warnings, undefined);
    });

    it("normalizes multi-level indexed paths consistently (a[2].b[0].c -> a[].b[].c)", async () => {
      const multiLevelSchema = [
        {
          path: "a[].b[].c",
          type: "string" as const,
          description: "A doubly-nested array field, for multi-level index normalization.",
        },
      ];
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "a[2].b[0].c",
            candidateValue: "nested value",
            provenance: { excerpt: "nested value", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content: "The nested value appears here.",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: multiLevelSchema,
        provider,
      });
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0].fieldPath, "a[].b[].c");
      // Outermost-first source order: the "a[2]" index before the "b[0]" index.
      assert.deepEqual(result.proposals[0].pathIndices, [2, 0]);
      assert.equal(result.warnings, undefined);
    });

    it("drops a proposal whose normalized fieldPath still doesn't match the schema, with a warning", async () => {
      const provider = createMockExtractionProvider(
        output([proposal({ fieldPath: "notDeclared[0].startDate" })]),
      );
      const result = await extract({
        content: "text",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
      assert.equal(result.proposals.length, 0);
      assert.ok(
        result.warnings?.some((w) => /unknown fieldPath "notDeclared\[0\]\.startDate"/.test(w)),
      );
    });

    it("still drops a normalized-and-matched proposal whose excerpt is not found, with a warning naming the normalized path", async () => {
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "schedules[0].startDate",
            provenance: { excerpt: "not anywhere in the content", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content: "Completely unrelated text.",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
      assert.equal(result.proposals.length, 0);
      assert.ok(
        result.warnings?.some(
          (w) => w === 'dropped proposal for "schedules[].startDate": excerpt not found in prepared content',
        ),
      );
    });

    it("leaves an already-declared, non-indexed fieldPath untouched (no pathIndices)", async () => {
      const provider = createMockExtractionProvider(output([proposal()]));
      const result = await extract({
        content: "Beginner Bouldering Session details.",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0].fieldPath, "title");
      assert.equal(result.proposals[0].pathIndices, undefined);
    });

    it("looks up inferenceType by the DECLARED (normalized) path, not the raw indexed one", async () => {
      // Declares "schedules[].startDate" (the array form) with inferenceType:
      // "inferred"; the provider emits the raw indexed form. The tag must
      // still attach to the recovered proposal via the declared path.
      const taggedSchema = [
        {
          path: "schedules[].startDate",
          type: "date" as const,
          description: "The start date of one schedule item in a repeating series.",
          inferenceType: "inferred" as const,
        },
      ];
      const content = "Session begins March 3.";
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "schedules[0].startDate",
            candidateValue: "2026-03-03",
            provenance: { excerpt: "March 3", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content,
        contentType: "text",
        sourceRef: "ref",
        targetSchema: taggedSchema,
        provider,
      });
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0].fieldPath, "schedules[].startDate");
      assert.deepEqual(result.proposals[0].pathIndices, [0]);
      assert.equal(result.proposals[0].inferenceType, "inferred");
    });

    it("echoes the matched schema's value type onto the proposal (so a reviewer can render/validate it)", async () => {
      // "title" is declared type "string"; "priceAmount" type "number". The
      // declared type travels with the value — no enumValues on a plain type.
      const provider = createMockExtractionProvider(
        output([
          proposal(),
          proposal({
            fieldPath: "priceAmount",
            candidateValue: 25,
            provenance: { excerpt: "Beginner Bouldering Session", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content: "Beginner Bouldering Session details.",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
      const byPath = new Map(result.proposals.map((p) => [p.fieldPath, p]));
      assert.equal(byPath.get("title")!.valueType, "string");
      assert.equal(byPath.get("title")!.enumValues, undefined);
      assert.equal(byPath.get("priceAmount")!.valueType, "number");
    });

    it("echoes enumValues (a defensive copy) when the matched schema declares a constrained set", async () => {
      const enumSchema = [
        {
          path: "difficulty",
          type: "enum" as const,
          enumValues: ["beginner", "intermediate", "advanced"],
          description: "The difficulty tier of the session.",
        },
      ];
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "difficulty",
            candidateValue: "beginner",
            provenance: { excerpt: "Beginner Bouldering Session", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content: "Beginner Bouldering Session details.",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: enumSchema,
        provider,
      });
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0].valueType, "enum");
      assert.deepEqual(result.proposals[0].enumValues, ["beginner", "intermediate", "advanced"]);
      // Defensive copy — mutating the proposal's array never reaches the schema.
      result.proposals[0].enumValues!.push("expert");
      assert.deepEqual(enumSchema[0].enumValues, ["beginner", "intermediate", "advanced"]);
    });

    it("looks up valueType/enumValues by the DECLARED (normalized) path, not the raw indexed one", async () => {
      const taggedSchema = [
        {
          path: "schedules[].startDate",
          type: "date" as const,
          description: "The start date of one schedule item in a repeating series.",
        },
      ];
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "schedules[0].startDate",
            candidateValue: "2026-03-03",
            provenance: { excerpt: "March 3", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content: "Session begins March 3.",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: taggedSchema,
        provider,
      });
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0].fieldPath, "schedules[].startDate");
      assert.equal(result.proposals[0].valueType, "date");
    });
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

  describe("inferenceType carry-through", () => {
    // Inline schema (NOT genericTargetSchema, which stays untagged/unmodified
    // so it remains a clean zero-diff baseline fixture for other tests).
    const taggedSchema = [
      {
        path: "explicitField",
        type: "string" as const,
        inferenceType: "explicit" as const,
      },
      {
        path: "inferredField",
        type: "string" as const,
        inferenceType: "inferred" as const,
      },
      {
        path: "untaggedField",
        type: "string" as const,
      },
    ];

    it("attaches inferenceType from the matched schema entry when declared, and leaves it absent otherwise", async () => {
      const content = "Explicit value here. Inferred value here. Untagged value here.";
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "explicitField",
            candidateValue: "Explicit value",
            provenance: { excerpt: "Explicit value", locator: "provisional" },
          }),
          proposal({
            fieldPath: "inferredField",
            candidateValue: "Inferred value",
            provenance: { excerpt: "Inferred value", locator: "provisional" },
          }),
          proposal({
            fieldPath: "untaggedField",
            candidateValue: "Untagged value",
            provenance: { excerpt: "Untagged value", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content,
        contentType: "text",
        sourceRef: "ref",
        targetSchema: taggedSchema,
        provider,
      });
      assert.equal(result.proposals.length, 3);
      const byField = Object.fromEntries(result.proposals.map((p) => [p.fieldPath, p]));
      assert.equal(byField["explicitField"]?.inferenceType, "explicit");
      assert.equal(byField["inferredField"]?.inferenceType, "inferred");
      // Key-presence assertion, not just value-equality — an absent key, not
      // a present key holding `undefined`.
      assert.equal("inferenceType" in (byField["untaggedField"] as object), false);
    });

    it("[AC5] never attaches inferenceType to any proposal when the schema never declares it (genericTargetSchema, unmodified)", async () => {
      const content = "Beginner Bouldering Session details.";
      const provider = createMockExtractionProvider(
        output([
          proposal(),
          proposal({ fieldPath: "priceAmount", candidateValue: 12 }),
        ]),
      );
      const result = await extract({
        content,
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
      assert.equal(result.proposals.length, 2);
      for (const p of result.proposals) {
        assert.equal("inferenceType" in (p as object), false);
      }
    });

    it("[AC6] adds no new drop/warning/clamp condition for an explicit field whose candidateValue is reformatted differently from the (still verbatim-matching) excerpt", async () => {
      // The excerpt itself must still verbatim-match the prepared content
      // (that enforcement is unchanged and pre-existing); only
      // `candidateValue` differs in format from the excerpt text. No
      // stricter "candidateValue must be groundable" check exists this
      // slice — the proposal survives untouched.
      const content = "Contact us at (303) 555-1234 for details.";
      const provider = createMockExtractionProvider(
        output([
          proposal({
            fieldPath: "explicitField",
            candidateValue: "303.555.1234", // reformatted vs. the excerpt's "(303) 555-1234"
            provenance: { excerpt: "(303) 555-1234", locator: "provisional" },
          }),
        ]),
      );
      const result = await extract({
        content,
        contentType: "text",
        sourceRef: "ref",
        targetSchema: taggedSchema,
        provider,
      });
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0].candidateValue, "303.555.1234");
      assert.equal(result.proposals[0].inferenceType, "explicit");
      assert.equal(result.warnings, undefined);
    });
  });
});
