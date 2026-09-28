import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime } from "@kontourai/relay";
import { importExtractionEnvelope } from "@kontourai/survey";
import {
  deserializePortableExtractionResult,
  extract,
  serializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
} from "../src/index.js";
import type { ExtractionCoverageEntry, ExtractionProvider, ExtractionResult, TargetFieldSchema } from "../src/index.js";
import { createRelayExtractionProvider } from "../src/relay.js";

// A run that leaves part of the prepared text unread (or unanswered) is a
// typed partial outcome on the portable envelope, with a per-chunk coverage
// record naming each range.

const targetSchema: TargetFieldSchema[] = [{ path: "fee", type: "number" }];
const empty = { proposals: [], raw: { response: "", model: "m" } };

function envelopeOf(result: ExtractionResult) {
  return deserializePortableExtractionResult(serializePortableExtractionResult(result));
}

function relayProvider(result: { stopReason: string; outputText?: string; toolCalls?: unknown[] }) {
  return createRelayExtractionProvider({
    runtime: new FakeModelRuntime([{
      provider: "fixture", model: "relay-test", outputText: result.outputText ?? "", toolCalls: result.toolCalls ?? [],
      usage: { totalTokens: 3 }, latencyMs: 0, stopReason: result.stopReason,
    } as never]),
  });
}

/** Fails the given 1-based calls; every other call answers with nothing. */
function failingCalls(...failures: number[]): ExtractionProvider {
  let call = 0;
  return {
    name: "p",
    async extract() {
      call++;
      if (failures.includes(call)) throw Object.assign(new Error("503"), { status: 503 });
      return empty;
    },
  };
}

// 30,000 chars with the default 12,000/200 window: three overlapping chunks.
const threeChunks = "x".repeat(30000);
const complete = (chunk: number, start: number, end: number): ExtractionCoverageEntry => ({ chunk, start, end, status: "complete" });

describe("partial outcome and coverage for chunk losses", () => {
  it("a failed middle chunk serializes partial/provider-failure with an unread entry for that chunk", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: threeChunks, provider: failingCalls(2) });
    assert.equal(result.error, undefined);
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "provider-failure" });
    assert.deepEqual(envelope.result.partial, { reason: "provider-failure", completedChunks: 3, remainingChunks: 0 });
    // Overlapping ranges (chunkOverlap 200) are valid on the wire.
    assert.deepEqual(envelope.result.coverage, [
      complete(1, 0, 12000),
      { chunk: 2, start: 11800, end: 23800, status: "unread", reason: "provider-failure" },
      complete(3, 23600, 30000),
    ]);
  });

  it("a chunk cut at maxContentChars has a complete entry for the sent part and an unread entry for the tail only", async () => {
    const content = "x".repeat(65000);
    const result = await extract({
      sourceRef: "s", contentType: "text", targetSchema, content, provider: failingCalls(),
      chunkSize: 30000, chunkOverlap: 0, maxContentChars: 20000,
    });
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "content-truncated" });
    assert.deepEqual(envelope.result.coverage, [
      complete(1, 0, 20000),
      { chunk: 1, start: 20000, end: 30000, status: "unread", reason: "content-truncated" },
      complete(2, 30000, 50000),
      // start = chunk start (30000) + maxContentChars (20000); end = chunk end.
      { chunk: 2, start: 50000, end: 60000, status: "unread", reason: "content-truncated" },
      complete(3, 60000, 65000),
    ]);
  });

  it("an answer stopped at the output cap serializes partial/output-truncated", async () => {
    const provider = relayProvider({
      stopReason: "max_tokens",
      toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [] } }],
    });
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "output-truncated" });
    assert.deepEqual(envelope.result.coverage, [{ chunk: 1, start: 0, end: 7, status: "output-truncated" }]);
  });

  it("a missing tool call serializes partial/provider-failure with an unread missing-tool-call entry", async () => {
    const provider = relayProvider({ stopReason: "end_turn", outputText: "The fee is 5." });
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "provider-failure" });
    assert.deepEqual(envelope.result.coverage, [{ chunk: 1, start: 0, end: 7, status: "unread", reason: "missing-tool-call" }]);
  });

  it("an answer that is not a proposals array leaves the chunk unread/provider-failure", async () => {
    const provider: ExtractionProvider = {
      name: "p",
      async extract(input) {
        return input.chunkIndex === 1 ? { proposals: "garbage" as never, raw: { response: "", model: "m" } } : empty;
      },
    };
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: threeChunks, provider });
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "provider-failure" });
    assert.deepEqual(envelope.result.coverage?.[1], { chunk: 2, start: 11800, end: 23800, status: "unread", reason: "provider-failure" });
  });

  it("an answer whose normalization throws leaves the chunk unread/provider-failure", async () => {
    const hostile = Object.defineProperty({}, "fieldPath", { enumerable: true, get() { throw new Error("hostile getter"); } });
    const provider: ExtractionProvider = {
      name: "p",
      async extract(input) {
        return input.chunkIndex === 1 ? { proposals: [hostile] as never, raw: { response: "", model: "m" } } : empty;
      },
    };
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: threeChunks, provider });
    assert.ok(result.warnings?.includes("chunk 2/3 normalization failed: hostile getter"), JSON.stringify(result.warnings));
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "provider-failure" });
    assert.deepEqual(envelope.result.coverage?.[1], { chunk: 2, start: 11800, end: 23800, status: "unread", reason: "provider-failure" });
  });

  for (const [label, value] of [["undefined", undefined], ["null", null], ["a string", "nope"]] as const) {
    it(`a provider resolving with ${label} for one chunk loses only that chunk`, async () => {
      const provider: ExtractionProvider = {
        name: "p",
        async extract(input) { return (input.chunkIndex === 1 ? value : empty) as never; },
      };
      const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: threeChunks, provider });
      assert.equal(result.error, undefined);
      const envelope = envelopeOf(result);
      assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "provider-failure" });
      assert.deepEqual(envelope.result.coverage?.[1], { chunk: 2, start: 11800, end: 23800, status: "unread", reason: "provider-failure" });
      assert.ok(result.warnings?.includes("chunk 2/3 (chars:11800-23800): provider answer unusable; the chunk is recorded as not read"));
    });
  }

  it("unusable: true from a custom provider records the chunk as not read", async () => {
    const provider: ExtractionProvider = { name: "p", async extract() { return { ...empty, unusable: true }; } };
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "provider-failure" });
    assert.deepEqual(envelope.result.warningClassifications, [{ category: "provider", code: "unusable-answer" }]);
  });

  it("the first loss in prepared-text order is the reason when several chunks lose text", async () => {
    // Chunks 1 and 2 are cut at dispatch, and chunk 2's call also fails: the
    // cut tail of chunk 1 comes first.
    const content = "x".repeat(70000);
    const result = await extract({
      sourceRef: "s", contentType: "text", targetSchema, content, provider: failingCalls(2),
      chunkSize: 30000, chunkOverlap: 0, maxContentChars: 25000,
    });
    assert.equal(result.partial?.reason, "content-truncated");
    const lost = result.coverage?.filter((entry) => entry.status !== "complete");
    assert.deepEqual(lost, [
      { chunk: 1, start: 25000, end: 30000, status: "unread", reason: "content-truncated" },
      { chunk: 2, start: 30000, end: 55000, status: "unread", reason: "provider-failure" },
      { chunk: 2, start: 55000, end: 60000, status: "unread", reason: "content-truncated" },
    ]);
  });

  it("an early stop keeps its own reason, and coverage still names the lost and never-dispatched ranges", async () => {
    const content = "x".repeat(65000);
    const result = await extract({
      sourceRef: "s", contentType: "text", targetSchema, content, provider: failingCalls(),
      chunkSize: 30000, chunkOverlap: 0, maxContentChars: 20000, maxProviderCalls: 2,
    });
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "max-provider-calls" });
    assert.deepEqual(envelope.result.partial, { reason: "max-provider-calls", completedChunks: 2, remainingChunks: 1 });
    assert.deepEqual(envelope.result.coverage?.at(-1), { chunk: 3, start: 60000, end: 65000, status: "unread", reason: "not-dispatched" });
    assert.equal(envelope.result.coverage?.filter((entry) => entry.reason === "content-truncated").length, 2);
  });

  it("chunks dropped beyond maxChunks continue the numbering as not-dispatched ranges", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: threeChunks, provider: failingCalls(), maxChunks: 1 });
    const envelope = envelopeOf(result);
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "max-chunks" });
    assert.deepEqual(envelope.result.coverage, [
      complete(1, 0, 12000),
      { chunk: 2, start: 11800, end: 23800, status: "unread", reason: "not-dispatched" },
      { chunk: 3, start: 23600, end: 30000, status: "unread", reason: "not-dispatched" },
    ]);
  });

  it("a multi-chunk run with no losses is a success, keeps overlapping complete coverage in process, and serializes as before", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: threeChunks, provider: failingCalls() });
    assert.equal(result.partial, undefined);
    assert.deepEqual(result.coverage, [complete(1, 0, 12000), complete(2, 11800, 23800), complete(3, 23600, 30000)]);
    const serialized = serializePortableExtractionResult(result);
    const envelope = JSON.parse(serialized);
    assert.deepEqual(envelope.result.outcome, { status: "success" });
    assert.equal("coverage" in envelope.result, false, "a complete run's envelope keeps the pre-coverage shape");

    // A producer may still send complete coverage with a success outcome:
    // overlapping complete ranges are valid.
    envelope.result.coverage = result.coverage;
    assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "valid");
  });

  it("a complete run's envelope still imports through the pinned Survey importer", async () => {
    const provider: ExtractionProvider = {
      name: "p",
      async extract() {
        return {
          proposals: [{ fieldPath: "fee", candidateValue: 5, confidence: 0.9, extractor: "e", provenance: { excerpt: "Fee: 5", locator: "x" } }],
          raw: { response: "", model: "m" },
        };
      },
    };
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    const imported = importExtractionEnvelope(serializePortableExtractionResult(result), {
      sourceKind: "uploaded-document",
      claimTarget: () => ({
        subjectType: "fixture", subjectId: "fixture-1", facet: "fixture", claimType: "field-value",
        fieldOrBehavior: "fee", impactLevel: "low",
      }),
    });
    assert.equal(imported.record.spec.envelope.result.proposals.length, 1);
  });
});

describe("typed output-cap and missing-tool-call signals", () => {
  const codes = (result: ExtractionResult) => (envelopeOf(result).result.warningClassifications ?? []).map((w) => w.code);
  const withOutput = (extra: Record<string, unknown>): ExtractionProvider => ({
    name: "p", async extract() { return { ...empty, ...extra }; },
  });
  const run = (provider: ExtractionProvider) => extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });

  it("a custom warning that merely contains the truncation text is neither a loss nor an output-truncated code", async () => {
    const result = await run(withOutput({ warnings: ["my-adapter: response truncated at maxTokens; proposals may be incomplete"] }));
    assert.deepEqual(envelopeOf(result).result.outcome, { status: "success" });
    assert.ok(!codes(result).includes("output-truncated"), JSON.stringify(codes(result)));
  });

  it("truncated: true with no warning records the loss and writes the located warning", async () => {
    const result = await run(withOutput({ truncated: true }));
    assert.deepEqual(envelopeOf(result).result.outcome, { status: "partial", reason: "output-truncated" });
    assert.deepEqual(result.warnings, ["chunk 1/1 (chars:0-7): response truncated at maxTokens; proposals may be incomplete"]);
    assert.deepEqual(codes(result), ["output-truncated"]);
  });

  it("truncated: false overrides a matching warning, and the warning is not classified as a loss", async () => {
    const result = await run(withOutput({ truncated: false, warnings: ["response truncated at maxTokens; proposals may be incomplete"] }));
    assert.deepEqual(envelopeOf(result).result.outcome, { status: "success" });
    assert.deepEqual(codes(result), ["provider-warning"]);
  });

  it("missingToolCall: true with no warning records the loss and writes the located warning", async () => {
    const result = await run(withOutput({ missingToolCall: true }));
    assert.deepEqual(envelopeOf(result).result.outcome, { status: "partial", reason: "provider-failure" });
    assert.deepEqual(result.warnings, ["chunk 1/1 (chars:0-7): provider returned no extraction tool call"]);
    assert.deepEqual(codes(result), ["missing-tool-call"]);
  });

  it("the bundled adapters set the typed signals", async () => {
    const truncated = await relayProvider({ stopReason: "max_tokens", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [] } }] })
      .extract({ content: "c", contentType: "text", targetSchema });
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.missingToolCall, false);
    const missing = await relayProvider({ stopReason: "end_turn", outputText: "no call" }).extract({ content: "c", contentType: "text", targetSchema });
    assert.equal(missing.truncated, false);
    assert.equal(missing.missingToolCall, true);
  });
});

describe("portable envelope coverage validation", () => {
  async function partialEnvelope() {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: threeChunks, provider: failingCalls(2) });
    return JSON.parse(serializePortableExtractionResult(result));
  }
  function reasonFor(envelope: unknown): string {
    const validation = validatePortableExtractionResultEnvelope(envelope);
    assert.equal(validation.status, "invalid");
    return (validation as { reason: string }).reason;
  }

  it("accepts a chunk's sent part followed by its content-truncated tail", async () => {
    const result = await extract({
      sourceRef: "s", contentType: "text", targetSchema, content: "x".repeat(30000), provider: failingCalls(),
      chunkSize: 30000, maxContentChars: 20000,
    });
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.equal(envelope.result.coverage.length, 2);
    assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "valid");
  });

  it("accepts every new partial reason", async () => {
    for (const reason of ["provider-failure", "content-truncated", "output-truncated"]) {
      const envelope = await partialEnvelope();
      envelope.result.outcome.reason = reason;
      envelope.result.partial.reason = reason;
      assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "valid", reason);
    }
  });

  const cases: Array<[string, (coverage: Array<Record<string, unknown>>, envelope: { result: Record<string, unknown> }) => void, RegExp]> = [
    ["a reversed range", (c) => { c[0].start = 12000; c[0].end = 0; }, /must have start < end/],
    ["an empty range", (c) => { c[0].end = c[0].start; }, /must have start < end/],
    ["a range past contentLength", (c) => { c[2].end = 30001; }, /exceeds prepared artifact contentLength/],
    ["entries out of start order", (c) => { c.reverse(); }, /ordered by start/],
    ["an unread entry without reason", (c) => { delete c[1].reason; }, /reason is required when status is unread/],
    ["a reason on a complete entry", (c) => { c[0].reason = "provider-failure"; }, /reason is only allowed when status is unread/],
    ["an unknown status", (c) => { c[0].status = "skipped"; }, /status has an unsupported value/],
    ["an unknown reason", (c) => { c[1].reason = "timeout"; }, /reason has an unsupported value/],
    ["chunk 0", (c) => { c[0].chunk = 0; }, /chunk must be positive/],
    ["an extra key", (c) => { c[0].note = "x"; }, /note is not allowed/],
    ["coverage without a prepared artifact", (_c, e) => { delete e.result.preparedArtifact; }, /coverage requires result\.preparedArtifact/],
    ["an unread range on a success outcome", (_c, e) => {
      e.result.outcome = { status: "success" };
      delete e.result.partial;
    }, /outcome is success/],
    ["a loss reason with every entry complete", (c) => {
      c[1].status = "complete";
      delete c[1].reason;
    }, /requires a result\.coverage entry for a dispatched chunk/],
    ["a loss reason with no coverage", (_c, e) => { delete e.result.coverage; }, /requires a result\.coverage entry for a dispatched chunk/],
    ["a loss reason whose only lost range was never dispatched", (c) => { c[1].reason = "not-dispatched"; }, /requires a result\.coverage entry for a dispatched chunk/],
    ["a content-truncated tail after a never-dispatched range", (c) => {
      c[0].status = "unread"; c[0].reason = "not-dispatched"; c[0].end = 11800;
      c[1].chunk = 1; c[1].reason = "content-truncated";
    }, /more than one entry for chunk 1/],
    ["two entries for one chunk", (c) => { c[2].chunk = 2; }, /more than one entry for chunk 2/],
    ["a content-truncated tail that does not start where the sent part ends", (c) => {
      c[1].chunk = 1;
      c[1].reason = "content-truncated";
    }, /more than one entry for chunk 1/],
  ];
  for (const [name, mutate, expected] of cases) {
    it(`rejects ${name}`, async () => {
      const envelope = await partialEnvelope();
      assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "valid", "fixture starts valid");
      mutate(envelope.result.coverage, envelope);
      assert.match(reasonFor(envelope), expected);
    });
  }
});
