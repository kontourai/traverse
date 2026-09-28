import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract, serializePortableExtractionResult, validatePortableExtractionResultEnvelope } from "../src/index.js";
import type { ExtractionProvider, TargetFieldSchema } from "../src/index.js";

const targetSchema: TargetFieldSchema[] = [{ path: "fee", type: "number" }];

describe("provider error text is bounded", () => {
  const long = `upstream rejected request: ${"x".repeat(5000)}`;

  it("cuts a long provider error in result.error and the chunk warning, keeping the full text on providerFailures", async () => {
    const provider: ExtractionProvider = { name: "p", async extract() { throw new Error(long); } };
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    assert.equal(result.error, `${long.slice(0, 500)}… (${long.length} chars)`);
    const warning = result.warnings?.find((w) => w.startsWith("chunk 1/1 provider call failed: "));
    assert.equal(warning, `chunk 1/1 provider call failed: ${long.slice(0, 500)}… (${long.length} chars) (chars:0-7 not read)`);
    assert.equal(result.providerFailures?.[0].message, long);
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.deepEqual(envelope.result.outcome, { status: "failure", category: "provider", code: "provider-failure" });
  });

  it("keeps a short provider error whole", async () => {
    const provider: ExtractionProvider = { name: "p", async extract() { throw new Error("503 unavailable"); } };
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    assert.equal(result.error, "503 unavailable");
  });

  it("does not split a surrogate pair at the cut", async () => {
    const message = `${"a".repeat(499)}\u{1F600}${"b".repeat(100)}`;
    const provider: ExtractionProvider = { name: "p", async extract() { throw new Error(message); } };
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider });
    assert.equal(result.error, `${"a".repeat(499)}… (${message.length} chars)`);
  });
});

describe("malformedToolItems counts from a custom provider", () => {
  const withCounts = (malformedToolItems: unknown): ExtractionProvider => ({
    name: "p",
    async extract() {
      return {
        proposals: [{ fieldPath: "fee", candidateValue: 5, extractor: "e", provenance: { excerpt: "Fee: 5", locator: "x" } }],
        raw: { response: "", model: "m" },
        malformedToolItems: malformedToolItems as never,
      };
    },
  });
  const malformedWarnings = (warnings: string[] | undefined) => (warnings ?? []).filter((w) => w.includes("tool items as malformed"));

  it("reports an in-range count", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider: withCounts({ dropped: 1, total: 2 }) });
    assert.deepEqual(malformedWarnings(result.warnings), ["chunk 1/1 (chars:0-7): dropped 1 of 2 tool items as malformed"]);
  });

  const outOfRange: Array<[string, unknown]> = [
    ["dropped > total", { dropped: 3, total: 2 }],
    ["negative dropped", { dropped: -1, total: 2 }],
    ["non-integer dropped", { dropped: 1.5, total: 2 }],
    ["non-integer total", { dropped: 1, total: 2.5 }],
    ["unsafe integer", { dropped: 1, total: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero dropped", { dropped: 0, total: 2 }],
  ];
  for (const [name, counts] of outOfRange) {
    it(`ignores ${name} and keeps the envelope valid`, async () => {
      const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content: "Fee: 5.", provider: withCounts(counts) });
      assert.equal(result.error, undefined);
      assert.equal(result.proposals.length, 1);
      assert.deepEqual(malformedWarnings(result.warnings), []);
      const envelope = JSON.parse(serializePortableExtractionResult(result));
      assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "valid");
      assert.deepEqual(envelope.result.outcome, { status: "success" });
    });
  }
});

describe("documented outcomes when nothing was answered", () => {
  const failing: ExtractionProvider = { name: "p", async extract() { throw Object.assign(new Error("boom"), { status: 503 }); } };
  const content = "x".repeat(40000);

  it("an early stop wins: the envelope is partial and only coverage shows nothing was answered", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content, provider: failing, maxProviderCalls: 1 });
    assert.equal(result.error, "boom");
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.deepEqual(envelope.result.outcome, { status: "partial", reason: "max-provider-calls" });
    const statuses = envelope.result.coverage.map((entry: { status: string; reason?: string }) => `${entry.status}/${entry.reason}`);
    assert.deepEqual(statuses, ["unread/provider-failure", "unread/not-dispatched", "unread/not-dispatched", "unread/not-dispatched"]);
  });

  it("maxChunks truncation is not an early stop: the envelope is a failure without coverage", async () => {
    const result = await extract({ sourceRef: "s", contentType: "text", targetSchema, content, provider: failing, maxChunks: 1 });
    assert.ok(result.coverage?.some((entry) => entry.reason === "not-dispatched"), JSON.stringify(result.coverage));
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.deepEqual(envelope.result.outcome, { status: "failure", category: "provider", code: "provider-failure" });
    assert.equal(envelope.result.coverage, undefined);
  });
});
