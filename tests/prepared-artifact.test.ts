import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInMemoryPreparedArtifactStore,
  createPreparedArtifact,
  isWellFormedUnicode,
  parsePreparedArtifactRef,
  resolvePreparedArtifact,
  validatePreparedArtifact,
} from "../src/prepared-artifact.js";
import { extract } from "../src/extract.js";
import { fetchAndExtract } from "../src/fetch/compose.js";
import { createInMemorySnapshotStore } from "../src/fetch/snapshot-store.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";
import { fakeFetch } from "./fixtures/fake-fetch.js";

const PREPARED_TEXT = "Sample heading\nRequested detail.";

function providerFor(excerpt: string) {
  return createMockExtractionProvider({
    proposals: [{
      fieldPath: "title",
      candidateValue: excerpt,
      confidence: 0.9,
      provenance: { excerpt, locator: "provisional" },
      extractor: "prepared-artifact-test-provider",
    }],
    raw: { response: "{}", model: "test" },
  });
}

function locatorSpan(locator: string): [number, number] {
  const match = /^chars:(\d+)-(\d+)$/.exec(locator);
  assert.ok(match, `expected chars locator, got ${locator}`);
  return [Number(match[1]), Number(match[2])];
}

describe("PreparedArtifact", () => {
  it("creates a versioned deterministic ref and invalidates it for content or preparation-version changes", () => {
    const first = createPreparedArtifact(PREPARED_TEXT, {
      preparationMode: "text",
      preparationVersion: "generic-prep-v1",
      sourceSnapshotRef: "snapshot:generic-v1",
    });
    const same = createPreparedArtifact(PREPARED_TEXT, {
      preparationMode: "text",
      preparationVersion: "generic-prep-v1",
      sourceSnapshotRef: "snapshot:generic-v1",
    });
    const changedText = createPreparedArtifact(`${PREPARED_TEXT}!`, {
      preparationMode: "text",
      preparationVersion: "generic-prep-v1",
      sourceSnapshotRef: "snapshot:generic-v1",
    });
    const changedPreparation = createPreparedArtifact(PREPARED_TEXT, {
      preparationMode: "text",
      preparationVersion: "generic-prep-v2",
      sourceSnapshotRef: "snapshot:generic-v1",
    });

    assert.deepEqual(first, same);
    assert.notEqual(first.ref, changedText.ref);
    assert.notEqual(first.ref, changedPreparation.ref);
    assert.equal(first.contentLength, PREPARED_TEXT.length);
    assert.deepEqual(parsePreparedArtifactRef(first.ref), {
      version: 1,
      identity: first.ref.slice(first.ref.lastIndexOf(":") + 1),
    });
  });

  it("returns typed available, unavailable, and digest-mismatch resolution states", async () => {
    const artifact = createPreparedArtifact(PREPARED_TEXT, { preparationMode: "text" });
    const store = createInMemoryPreparedArtifactStore();

    assert.deepEqual(await resolvePreparedArtifact(artifact, store), { status: "unavailable", artifact });
    await store.put!(artifact, PREPARED_TEXT);
    assert.deepEqual(await resolvePreparedArtifact(artifact, store), {
      status: "available",
      artifact,
      text: PREPARED_TEXT,
    });

    const mismatchedStore = { get: () => "changed text" };
    const mismatch = await resolvePreparedArtifact(artifact, mismatchedStore);
    assert.equal(mismatch.status, "digest-mismatch");
    if (mismatch.status === "digest-mismatch") {
      assert.notEqual(mismatch.actualDigest, artifact.digest);
      assert.equal(mismatch.actualContentLength, "changed text".length);
    }
  });

  it("rejects ill-formed Unicode instead of hashing replacement characters", async () => {
    const loneSurrogate = "bad\ud800text";
    assert.equal(isWellFormedUnicode(loneSurrogate), false);
    assert.throws(
      () => createPreparedArtifact(loneSurrogate, { preparationMode: "text" }),
      /well-formed Unicode/,
    );
    const artifact = createPreparedArtifact("valid", { preparationMode: "text" });
    const resolved = await resolvePreparedArtifact(artifact, { get: () => loneSurrogate });
    assert.deepEqual(resolved, { status: "invalid-artifact", reason: "invalid-resolved-text" });
  });

  it("validates complete metadata and canonical identity before touching a store", async () => {
    const artifact = createPreparedArtifact(PREPARED_TEXT, { preparationMode: "text" });
    let gets = 0;
    const store = { get: () => { gets++; return PREPARED_TEXT; } };
    const malformed = { ...artifact, ref: "not-a-prepared-ref" };
    assert.deepEqual(await resolvePreparedArtifact(malformed, store), {
      status: "invalid-artifact",
      reason: "invalid-ref",
    });
    assert.equal(gets, 0);

    const invalidFields: Array<[Record<string, unknown>, string]> = [
      [{ ...artifact, format: "other" }, "invalid-format"],
      [{ ...artifact, version: 2 }, "invalid-version"],
      [{ ...artifact, digest: "not-a-digest" }, "invalid-digest"],
      [{ ...artifact, preparationMode: "other" }, "invalid-preparation-mode"],
      [{ ...artifact, preparationVersion: "" }, "invalid-preparation-version"],
      [{ ...artifact, contentLength: -1 }, "invalid-content-length"],
      [{ ...artifact, sourceSnapshotRef: "" }, "invalid-source-snapshot-ref"],
      [{ ...artifact, preparationVersion: "bad\ud800version" }, "ill-formed-unicode"],
    ];
    for (const [candidate, reason] of invalidFields) {
      assert.deepEqual(await resolvePreparedArtifact(candidate, store), {
        status: "invalid-artifact",
        reason,
      });
    }
    assert.equal(gets, 0);

    const validButWrongRef = {
      ...artifact,
      ref: `${artifact.ref.slice(0, -1)}${artifact.ref.endsWith("0") ? "1" : "0"}`,
    };
    const identity = validatePreparedArtifact(validButWrongRef);
    assert.equal(identity.status, "identity-mismatch");
    const withUnexpectedText = validatePreparedArtifact({ ...artifact, text: "must not escape" });
    assert.equal(withUnexpectedText.status, "valid");
    if (withUnexpectedText.status === "valid") {
      assert.equal("text" in withUnexpectedText.artifact, false);
    }
    assert.equal((await resolvePreparedArtifact(validButWrongRef, store)).status, "identity-mismatch");
    assert.equal(gets, 0);
  });

  it("turns store failures into a typed non-sensitive outcome", async () => {
    const artifact = createPreparedArtifact(PREPARED_TEXT, { preparationMode: "text" });
    const resolved = await resolvePreparedArtifact(artifact, {
      get: async () => { throw new Error("sensitive backend detail"); },
    });
    assert.deepEqual(resolved, { status: "storage-error", artifact });
    assert.doesNotMatch(JSON.stringify(resolved), /sensitive backend detail/);
  });
});

describe("extract() prepared-artifact binding", () => {
  it("stores the exact full prepared text and every returned locator slices against it", async () => {
    const store = createInMemoryPreparedArtifactStore();
    const result = await extract({
      content: "<h1>Sample heading</h1><p>Requested detail.</p>",
      contentType: "html",
      sourceRef: "https://example.test/generic",
      targetSchema: genericTargetSchema,
      provider: providerFor("Sample heading"),
      preparedArtifact: { store, preparationVersion: "generic-prep-v1" },
    });

    assert.ok(result.preparedArtifact, "a completed prepared extraction has an identity");
    assert.equal(result.preparedArtifact!.preparationMode, "markdown");
    assert.equal(result.preparedArtifact!.sourceSnapshotRef, undefined);
    assert.equal("text" in result.preparedArtifact!, false, "result does not embed prepared text");
    const resolved = await resolvePreparedArtifact(result.preparedArtifact!, store);
    assert.equal(resolved.status, "available");
    if (resolved.status === "available") {
      for (const proposal of result.proposals) {
        const [start, end] = locatorSpan(proposal.provenance.locator);
        assert.equal(resolved.text.slice(start, end), proposal.provenance.excerpt);
      }
    }
  });

  it("keeps plain-text callers compatible while assigning deterministic inline preparation identity", async () => {
    const result = await extract({
      content: PREPARED_TEXT,
      contentType: "text",
      sourceRef: "caller-owned-ref",
      targetSchema: genericTargetSchema,
      provider: providerFor("Sample heading"),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.preparedArtifact?.preparationMode, "text");
    assert.equal(result.preparedArtifact?.sourceSnapshotRef, undefined);
  });

  it("records transcript cleanup as its actual preparation mode", async () => {
    const result = await extract({
      content: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nSample heading\n",
      contentType: "transcript",
      sourceRef: "caller-owned-transcript",
      targetSchema: genericTargetSchema,
      provider: providerFor("Sample heading"),
    });
    assert.equal(result.preparedArtifact?.preparationMode, "transcript");
  });

  it("records text when adversarial HTML forces markdown preparation to fall back", async () => {
    const deep = "<div>".repeat(40_000) + "Sample heading" + "</div>".repeat(40_000);
    const result = await extract({
      content: deep,
      contentType: "html",
      sourceRef: "caller-owned-adversarial-html",
      targetSchema: genericTargetSchema,
      provider: providerFor("Sample heading"),
    });
    assert.ok(result.warnings?.some((warning) => warning.includes("fell back to text chunking")));
    assert.equal(result.preparedArtifact?.preparationMode, "text");
  });

  it("redacts injected-store errors from extraction warnings", async () => {
    const result = await extract({
      content: PREPARED_TEXT,
      contentType: "text",
      sourceRef: "caller-owned-ref",
      targetSchema: genericTargetSchema,
      provider: providerFor("Sample heading"),
      preparedArtifact: {
        store: { get: () => undefined, put: async () => { throw new Error("sensitive backend detail"); } },
      },
    });
    assert.ok(result.warnings?.includes(
      "prepared artifact storage failed; exact text is unavailable from the configured store",
    ));
    assert.doesNotMatch(JSON.stringify(result.warnings), /sensitive backend detail/);
  });
});

describe("generic snapshot capture/replay", () => {
  it("keeps prepared-artifact identity stable from live capture through replay", async () => {
    const snapshotStore = createInMemorySnapshotStore();
    const preparedStore = createInMemoryPreparedArtifactStore();
    const body = "<h1>Sample heading</h1><p>Requested detail.</p>";
    const config = { id: "generic-source", url: "https://example.test/generic", respectRobots: false };
    const live = await fetchAndExtract(config, {
      targetSchema: genericTargetSchema,
      provider: providerFor("Sample heading"),
      store: snapshotStore,
      preparedArtifactStore: preparedStore,
      preparationVersion: "generic-prep-v1",
      mode: "live-with-capture",
      fetchOptions: {
        fetch: fakeFetch({ [config.url]: { headers: { "content-type": "text/html" }, body } }),
        sleep: async () => {},
        clock: () => "2026-07-20T00:00:00.000Z",
      },
    });
    const replay = await fetchAndExtract(config, {
      targetSchema: genericTargetSchema,
      provider: providerFor("Sample heading"),
      store: snapshotStore,
      preparedArtifactStore: preparedStore,
      preparationVersion: "generic-prep-v1",
      mode: "replay",
    });

    assert.equal(live.extraction!.preparedArtifact!.ref, replay.extraction!.preparedArtifact!.ref);
    assert.equal(live.extraction!.preparedArtifact!.digest, replay.extraction!.preparedArtifact!.digest);
    assert.equal(live.extraction!.preparedArtifact!.sourceSnapshotRef, live.sourceRef);
    const resolved = await resolvePreparedArtifact(replay.extraction!.preparedArtifact!, preparedStore);
    assert.equal(resolved.status, "available");
  });
});
