// Cost-guard coverage: ExtractInput.maxProviderCalls / maxTotalTokens.
//
// Uses the shared `createRegexScanProvider` fixture (tests/fixtures/mock-provider.ts)
// — a provider that scans "Program NN Alpha" out of whatever chunk content it
// is handed, records every call, can throw on a given 1-based call number,
// and reports a configurable per-call `raw.tokensUsed` — the same
// implementation tests/chunking.test.ts uses for its multi-call cases, per
// Task E's fixture-reuse finding — the thunk-form `createMockExtractionProvider`
// seam is the other documented option, used for the single-chunk cases below
// where per-call variation is not needed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { extract } from "../src/extract.js";
import type { ExtractionProvider, ProviderExtractionOutput } from "../src/types.js";
import { createMockExtractionProvider, createRegexScanProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

const cardsHtml = readFileSync(
  new URL("../../tests/fixtures/repeated-cards-page.html", import.meta.url),
  "utf8",
);

// Structural chunking of cardsHtml at chunkSize 400 yields exactly 6 chunks
// (12 cards, ~2 per chunk) — confirmed via a one-off probe against
// prepareAndChunk this session; reused below as a stable "6 natural calls"
// baseline for every ceiling scenario.
const CHUNK_SIZE = 400;
const NATURAL_CHUNK_COUNT = 6;

describe("extract() cost guard — invalid config", () => {
  const invalidMaxProviderCalls = [0, -1, NaN, 1.5];
  for (const v of invalidMaxProviderCalls) {
    it(`rejects maxProviderCalls=${v} with ExtractionResult.error, zero calls issued`, async () => {
      const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
      const result = await extract({
        content: "some text",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
        maxProviderCalls: v,
      });
      assert.match(result.error ?? "", /^invalid maxProviderCalls: must be a positive integer/);
      assert.equal(result.providerCalls, 0);
      assert.equal(result.totalTokensUsed, 0);
      assert.equal(provider.calls.length, 0);
      assert.equal(result.proposals.length, 0);
    });
  }

  const invalidMaxTotalTokens = [0, -1, NaN, Infinity];
  for (const v of invalidMaxTotalTokens) {
    it(`rejects maxTotalTokens=${v} with ExtractionResult.error, zero calls issued`, async () => {
      const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
      const result = await extract({
        content: "some text",
        contentType: "text",
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
        maxTotalTokens: v,
      });
      assert.match(result.error ?? "", /^invalid maxTotalTokens: must be a positive finite number/);
      assert.equal(result.providerCalls, 0);
      assert.equal(result.totalTokensUsed, 0);
      assert.equal(provider.calls.length, 0);
      assert.equal(result.proposals.length, 0);
    });
  }

  it("validates maxProviderCalls before maxTotalTokens when both are invalid", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const result = await extract({
      content: "some text",
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      maxProviderCalls: -1,
      maxTotalTokens: -1,
    });
    assert.match(result.error ?? "", /^invalid maxProviderCalls/);
  });
});

describe("extract() cost guard — maxProviderCalls", () => {
  it("stops issuing calls once maxProviderCalls is reached, keeps partial proposals, and warns", async () => {
    const provider = createRegexScanProvider();
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxProviderCalls: 3,
    });
    assert.equal(result.error, undefined);
    assert.equal(provider.callContents.length, 3, "exactly 3 calls issued, not the natural 6");
    assert.equal(result.providerCalls, 3);
    assert.ok(result.proposals.length > 0, "partial proposals from the calls that did run survive");
    assert.ok(result.proposals.length < 12, "not every card was reached");
    assert.ok(
      result.warnings?.some(
        (w) => w === "stopped after 3 provider call(s): maxProviderCalls (3) reached; 3 chunk(s) not processed",
      ),
      `expected ceiling warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("never blocks the first call, even with the smallest valid ceiling (maxProviderCalls: 1)", async () => {
    const provider = createRegexScanProvider();
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxProviderCalls: 1,
    });
    assert.equal(provider.callContents.length, 1, "exactly one call was made");
    assert.equal(result.providerCalls, 1);
    assert.ok(result.proposals.length > 0, "the one call that ran still produced proposals");
    assert.ok(
      result.warnings?.some(
        (w) => w === "stopped after 1 provider call(s): maxProviderCalls (1) reached; 5 chunk(s) not processed",
      ),
    );
  });

  it("does not fire when maxProviderCalls is not reached (natural chunk count is smaller)", async () => {
    const provider = createRegexScanProvider();
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxProviderCalls: 100,
    });
    assert.equal(provider.callContents.length, NATURAL_CHUNK_COUNT);
    assert.equal(result.providerCalls, NATURAL_CHUNK_COUNT);
    assert.ok(!result.warnings?.some((w) => /maxProviderCalls/.test(w)));
  });
});

describe("extract() cost guard — maxTotalTokens", () => {
  it("stops issuing calls once accumulated tokensUsed crosses maxTotalTokens, keeps partial proposals, and warns", async () => {
    const provider = createRegexScanProvider({ tokensUsed: 100 });
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxTotalTokens: 250,
    });
    assert.equal(result.error, undefined);
    // Checked BEFORE each call using only tokens already spent: after 2 calls
    // (200 < 250) a 3rd call is still issued, then the accumulated 300 trips
    // the ceiling before a 4th — the ceiling is crossed, not landed on
    // exactly (Stop-short risk 3: a stop-issuing bound, not a hard cap).
    assert.equal(provider.callContents.length, 3);
    assert.equal(result.providerCalls, 3);
    assert.equal(result.totalTokensUsed, 300);
    assert.ok(result.proposals.length > 0, "partial proposals from the calls that did run survive");
    assert.ok(
      result.warnings?.some(
        (w) =>
          w === "stopped after 3 provider call(s): maxTotalTokens (250) reached (300 tokens used); 3 chunk(s) not processed",
      ),
      `expected ceiling warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("does not fire when accumulated tokensUsed never reaches maxTotalTokens", async () => {
    const provider = createRegexScanProvider({ tokensUsed: 10 });
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxTotalTokens: 10_000,
    });
    assert.equal(provider.callContents.length, NATURAL_CHUNK_COUNT);
    assert.equal(result.totalTokensUsed, 10 * NATURAL_CHUNK_COUNT);
    assert.ok(!result.warnings?.some((w) => /maxTotalTokens/.test(w)));
  });
});

describe("extract() cost guard — graceful degrade (provider omits raw.tokensUsed)", () => {
  it("maxTotalTokens never fires for a provider that never reports tokensUsed — all chunks processed, totalTokensUsed 0", async () => {
    const provider = createRegexScanProvider(); // no `tokensUsed` option -> raw.tokensUsed omitted every call
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxTotalTokens: 1, // smallest valid ceiling — would fire immediately if tokens were (mis)counted
    });
    assert.equal(provider.callContents.length, NATURAL_CHUNK_COUNT, "all chunks processed, guard never tripped");
    assert.equal(result.totalTokensUsed, 0);
    assert.ok(!result.warnings?.some((w) => /maxTotalTokens/.test(w)));
  });

  it("maxProviderCalls still works normally for a provider that never reports tokensUsed, even with maxTotalTokens also set", async () => {
    const provider = createRegexScanProvider();
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxProviderCalls: 2,
      maxTotalTokens: 1,
    });
    // maxProviderCalls is checked first each iteration, so it is the one that
    // trips (at 2 calls) — the token ceiling never gets a chance to "false
    // stop" a token-silent provider before that.
    assert.equal(provider.callContents.length, 2);
    assert.equal(result.totalTokensUsed, 0);
    assert.ok(result.warnings?.some((w) => /maxProviderCalls \(2\) reached/.test(w)));
  });
});

describe("extract() cost guard — both ceilings configured", () => {
  it("maxProviderCalls trips first when it is the tighter bound — only that warning is emitted", async () => {
    const provider = createRegexScanProvider({ tokensUsed: 10 }); // low per-call cost, won't trip the token ceiling
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxProviderCalls: 2,
      maxTotalTokens: 1_000,
    });
    assert.equal(provider.callContents.length, 2);
    assert.equal(result.providerCalls, 2);
    assert.ok(result.warnings?.some((w) => /maxProviderCalls \(2\) reached/.test(w)));
    assert.ok(!result.warnings?.some((w) => /maxTotalTokens/.test(w)), "only ONE warning for the stop event");
  });

  it("maxTotalTokens trips first when maxProviderCalls is set loosely — only that warning is emitted", async () => {
    const provider = createRegexScanProvider({ tokensUsed: 100 });
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxProviderCalls: 100, // far looser than the natural 6 calls
      maxTotalTokens: 250,
    });
    assert.equal(provider.callContents.length, 3);
    assert.equal(result.totalTokensUsed, 300);
    assert.ok(result.warnings?.some((w) => /maxTotalTokens \(250\) reached \(300 tokens used\)/.test(w)));
    assert.ok(!result.warnings?.some((w) => /maxProviderCalls \(100\)/.test(w)), "only ONE warning for the stop event");
  });
});

describe("extract() cost guard — maxChunks interplay", () => {
  it("maxChunks truncation and a maxProviderCalls stop are independent and both surface as warnings", async () => {
    const provider = createRegexScanProvider();
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: CHUNK_SIZE,
      maxChunks: 4, // caps how many chunks EXIST (6 -> 4), independent of the guard below
      maxProviderCalls: 2, // then bounds how many of those 4 already-capped chunks get processed
    });
    assert.equal(provider.callContents.length, 2);
    assert.ok(
      result.warnings?.some((w) => w === "dropped 2 chunks beyond maxChunks; content truncated"),
      `expected maxChunks warning, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings?.some(
        (w) => w === "stopped after 2 provider call(s): maxProviderCalls (2) reached; 2 chunk(s) not processed",
      ),
      `expected ceiling warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });
});

describe("extract() cost guard — usage surfaced on every return path", () => {
  it("success path with NO ceilings configured still reports accurate providerCalls/totalTokensUsed", async () => {
    const provider = createMockExtractionProvider({
      proposals: [],
      raw: { response: "{}", model: "mock-model", tokensUsed: 42 },
    });
    const result = await extract({
      content: "Beginner Bouldering Session details.",
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.providerCalls, 1);
    assert.equal(result.totalTokensUsed, 42);
  });

  it("pdf-deferred path reports providerCalls: 0, totalTokensUsed: 0 (provider never called)", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const result = await extract({
      content: new Uint8Array([1, 2, 3]),
      contentType: "pdf",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.match(result.error ?? "", /not implemented/);
    assert.equal(provider.calls.length, 0);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.totalTokensUsed, 0);
  });

  it("all-chunks-failed fatal path still reports calls attempted (all failed) and zero tokens", async () => {
    const alwaysThrows: ExtractionProvider = {
      name: "always-throws",
      async extract(): Promise<ProviderExtractionOutput> {
        throw new Error("provider boom");
      },
    };
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider: alwaysThrows,
      chunkSize: CHUNK_SIZE,
    });
    assert.equal(result.error, "provider boom");
    assert.equal(result.proposals.length, 0);
    // Every one of the natural 6 chunks WAS attempted (all failed) — call
    // count is still accurate on this path.
    assert.equal(result.providerCalls, NATURAL_CHUNK_COUNT);
    assert.equal(result.totalTokensUsed, 0);
    // Known, pre-existing gap (Stop-short risk 1, not introduced by this
    // delivery): the all-chunks-failed fatal path constructs its
    // ExtractionResult WITHOUT a `warnings` field at all, so even the
    // per-chunk "provider call failed" warnings are dropped here, same as
    // today for any other warning on this path. This test documents that
    // gap rather than asserting a warning this code path cannot carry.
    assert.equal(result.warnings, undefined);
  });
});
