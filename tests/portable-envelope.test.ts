import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  createExtractionTaskSpec,
  createInMemoryPreparedArtifactStore,
  createPreparedArtifact,
  deserializePortableExtractionResult,
  extract,
  resolvePreparedArtifact,
  serializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
} from "../src/index.js";
import type { TargetFieldSchema } from "../src/index.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";

const schema: TargetFieldSchema[] = [
  { path: "title", type: "string", inferenceType: "explicit" },
  { path: "alias", type: "string", inferenceType: "inferred" },
];

async function completeResult() {
  const provider = createMockExtractionProvider({
    proposals: [
      { fieldPath: "title", candidateValue: "Alpha", confidence: 0.8, occurrenceHint: 1, provenance: { excerpt: "Alpha", locator: "provisional" }, extractor: "portable-test" },
      { fieldPath: "title", candidateValue: "Alpha", confidence: 0.7, occurrenceHint: 2, provenance: { excerpt: "Alpha", locator: "provisional" }, extractor: "portable-test" },
      { fieldPath: "alias", candidateValue: "Alpha", confidence: 0.6, occurrenceHint: 1, provenance: { excerpt: "Alpha", locator: "provisional" }, extractor: "portable-test" },
    ],
    raw: { response: "{\"ok\":true}", model: "generic-model", tokensUsed: 12 },
    warnings: ["provider-note"],
  });
  const taskSpec = createExtractionTaskSpec({
    version: "1", targetSchema: schema,
    examples: [{ content: "Alpha", proposals: [{ fieldPath: "title", candidateValue: "Alpha", excerpt: "Alpha" }] }],
  });
  return extract({
    content: "Alpha then Alpha", contentType: "text", sourceRef: "source:portable-test", targetSchema: schema, taskSpec, provider,
    preparedArtifact: { sourceSnapshotRef: "snapshot:portable-test" },
  });
}

describe("portable extraction-result envelope", () => {
  it("accepts the checked-in v1 fixture and preserves its canonical bytes", async () => {
    // Tests run from dist/, while the checked-in fixture intentionally remains
    // source data rather than a published runtime asset.
    const fixture = await readFile(new URL("../../tests/fixtures/portable-extraction-result.v1.json", import.meta.url), "utf8");
    assert.equal(serializePortableExtractionResult(deserializePortableExtractionResult(fixture.trim())), fixture.trim());
  });

  it("round-trips byte-stably with source, task, artifact, usage, and exact-span provenance", async () => {
    const result = await completeResult();
    const serialized = serializePortableExtractionResult(result);
    const parsed = deserializePortableExtractionResult(serialized);

    assert.equal(serializePortableExtractionResult(parsed), serialized);
    assert.equal(parsed.source.ref, "source:portable-test");
    assert.equal(parsed.source.snapshotRef, "snapshot:portable-test");
    assert.equal(parsed.result.model, "generic-model");
    assert.equal(parsed.result.raw.tokensUsed, 12);
    assert.equal(parsed.result.provider, result.provider);
    assert.equal(parsed.result.runId, result.runId);
    assert.equal(parsed.result.taskDigest, result.taskDigest);
    assert.deepEqual(parsed.result.exampleDigests, result.exampleDigests);
    assert.deepEqual(parsed.result.proposals.map((proposal) => [proposal.fieldPath, proposal.provenance.locator]), [
      ["title", "chars:0-5"], ["title", "chars:11-16"], ["alias", "chars:0-5"],
    ]);
    assert.doesNotMatch(serialized, /Alpha then Alpha/);
    assert.doesNotMatch(serialized, /\"text\"\s*:/);
    assert.equal("response" in parsed.result.raw, false);
    assert.equal("warnings" in parsed.result, false);
    assert.equal("error" in parsed.result, false);
  });

  it("omits diagnostic strings by default and keeps identity for a zero-proposal success", async () => {
    const result = await extract({
      content: "No match", contentType: "text", sourceRef: "source:empty", targetSchema: schema,
      provider: createMockExtractionProvider({ proposals: [], raw: { response: "authorization: private-value", model: "generic-model" }, warnings: ["private warning"] }),
    });
    result.error = "private error";
    result.providerFailures = [{ provider: "portable-test", kind: "timeout", retryable: true, message: "private failure", native: new Error("private native") }];
    const serialized = serializePortableExtractionResult(result);
    const parsed = deserializePortableExtractionResult(serialized);
    assert.deepEqual(parsed.result.proposals, []);
    assert.equal(parsed.result.provider, result.provider);
    assert.equal(parsed.result.runId, result.runId);
    assert.deepEqual(parsed.result.providerFailures, [{ provider: "portable-test", kind: "timeout", retryable: true }]);
    assert.equal(parsed.result.outcome.status, "failure");
    assert.deepEqual(parsed.result.warningClassifications, [{ category: "other", code: "unclassified-warning" }]);
    assert.doesNotMatch(serialized, /private|authorization|response|"error"|message|native/i);
  });

  it("projects text resolution into a typed artifact state without serializing text", async () => {
    const result = await completeResult();
    const store = createInMemoryPreparedArtifactStore();
    const resolution = await resolvePreparedArtifact(result.preparedArtifact!, store);
    assert.equal(resolution.status, "unavailable");
    const parsed = deserializePortableExtractionResult(serializePortableExtractionResult(result, { preparedArtifactResolution: resolution }));
    assert.deepEqual(parsed.result.preparedArtifactState, {
      status: "unavailable",
      requestedRef: result.preparedArtifact!.ref,
      canonicalRef: result.preparedArtifact!.ref,
    });
    assert.equal("text" in (parsed.result.preparedArtifactState as object), false);
  });

  it("rejects unknown versions, invalid locator/occurrence metadata, hidden artifact text, and non-lossless JSON", async () => {
    const result = await completeResult();
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    envelope.version = 2;
    assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "invalid");

    envelope.version = 1;
    envelope.result.proposals[0].provenance.locator = "field:title";
    assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "invalid");

    envelope.result.proposals[0].provenance.locator = "chars:0-5";
    envelope.result.proposals[0].candidateValue = -0;
    assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "invalid");

    envelope.result.proposals[0].candidateValue = "Alpha";
    envelope.result.preparedArtifact.text = "must never enter the envelope";
    assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "invalid");

    const sparse = JSON.parse(serializePortableExtractionResult(result));
    sparse.result.proposals[0].pathIndices = new Array(2);
    assert.equal(validatePortableExtractionResultEnvelope(sparse).status, "invalid");

    const wrongLength = JSON.parse(serializePortableExtractionResult(result));
    wrongLength.result.proposals[0].provenance.excerpt = "Alph";
    assert.equal(validatePortableExtractionResultEnvelope(wrongLength).status, "invalid");

    const mismatchedArtifact = createPreparedArtifact("different", { preparationMode: "text" });
    const mismatchedResolution = await resolvePreparedArtifact(mismatchedArtifact, createInMemoryPreparedArtifactStore());
    assert.throws(
      () => serializePortableExtractionResult(result, { preparedArtifactResolution: mismatchedResolution }),
      /metadata does not match/,
    );

    const stateMismatch = JSON.parse(serializePortableExtractionResult(result));
    stateMismatch.result.preparedArtifactState = { status: "unavailable", requestedRef: mismatchedArtifact.ref, canonicalRef: mismatchedArtifact.ref };
    assert.equal(validatePortableExtractionResultEnvelope(stateMismatch).status, "invalid");
  });

  it("faithfully projects every real prepared-artifact resolver status", async () => {
    const result = await completeResult();
    const artifact = result.preparedArtifact!;
    const availableStore = createInMemoryPreparedArtifactStore();
    await availableStore.put!(artifact, "Alpha then Alpha");
    const tampered = { ...artifact, ref: `${artifact.ref.slice(0, -1)}${artifact.ref.endsWith("0") ? "1" : "0"}` };
    const statuses = await Promise.all([
      resolvePreparedArtifact(artifact, availableStore),
      resolvePreparedArtifact(artifact, createInMemoryPreparedArtifactStore()),
      resolvePreparedArtifact(artifact, { get: () => { throw new Error("private storage detail"); } }),
      resolvePreparedArtifact(artifact, { get: () => "changed" }),
      resolvePreparedArtifact(tampered, createInMemoryPreparedArtifactStore()),
      resolvePreparedArtifact({ nope: true }, createInMemoryPreparedArtifactStore()),
    ]);
    assert.deepEqual(statuses.map((status) => status.status), ["available", "unavailable", "storage-error", "digest-mismatch", "identity-mismatch", "invalid-artifact"]);
    for (const resolution of statuses) {
      const envelope = deserializePortableExtractionResult(serializePortableExtractionResult(result, { preparedArtifactResolution: resolution }));
      assert.equal(envelope.result.preparedArtifactState?.status, resolution.status);
      assert.equal(envelope.result.preparedArtifactState?.canonicalRef, artifact.ref);
      assert.doesNotMatch(JSON.stringify(envelope.result.preparedArtifactState), /private storage detail|Alpha then Alpha/);
    }
  });

  it("rejects credential-shaped or unstable retained identities", async () => {
    const result = await completeResult();
    for (const mutate of [
      (candidate: any) => { candidate.provider = "provider?token=private"; },
      (candidate: any) => { candidate.raw.model = "model with spaces"; },
      (candidate: any) => { candidate.proposals[0].extractor = "https://user:password@example.test"; },
      (candidate: any) => { candidate.providerFailures = [{ provider: "provider?api_key=private", kind: "timeout", retryable: true, message: "x", native: null }]; },
    ]) {
      const candidate: any = structuredClone(result);
      mutate(candidate);
      assert.throws(() => serializePortableExtractionResult(candidate), /credential-free stable identity/);
    }
  });

  it("rejects symbol, non-enumerable, accessor, and unexpected own properties without invoking accessors", async () => {
    const result = await completeResult();
    const symbolEnvelope = JSON.parse(serializePortableExtractionResult(result));
    symbolEnvelope[Symbol("hidden")] = "value";
    assert.equal(validatePortableExtractionResultEnvelope(symbolEnvelope).status, "invalid");

    const hiddenEnvelope = JSON.parse(serializePortableExtractionResult(result));
    Object.defineProperty(hiddenEnvelope.result, "hidden", { value: "value", enumerable: false });
    assert.equal(validatePortableExtractionResultEnvelope(hiddenEnvelope).status, "invalid");

    const accessorEnvelope = JSON.parse(serializePortableExtractionResult(result));
    let invoked = false;
    Object.defineProperty(accessorEnvelope.result, "hidden", { enumerable: true, get() { invoked = true; return "value"; } });
    assert.equal(validatePortableExtractionResultEnvelope(accessorEnvelope).status, "invalid");
    assert.equal(invoked, false);
  });
});
