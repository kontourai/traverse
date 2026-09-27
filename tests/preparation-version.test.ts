import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { importExtractionEnvelope } from "@kontourai/survey";
import {
  PREPARED_ARTIFACT_PREPARATION_VERSION,
  createPreparedArtifact,
  extract,
  preparationVersionFor,
  serializePortableExtractionResult,
} from "../src/index.js";
import type { ContentType, ExtractionProvider, PreparedArtifact, TargetFieldSchema } from "../src/index.js";

// Pinned prepared-text digests for a fixed input set. When one of these fails
// because the digest changed but the version did not, preparation output
// changed: bump PREPARED_ARTIFACT_PREPARATION_VERSION and re-record the golden
// file (tests/fixtures/preparation-goldens.json) in the same change.

const fixture = (name: string) => readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf8");
const goldens = JSON.parse(fixture("preparation-goldens.json")) as {
  baseVersion: string;
  cases: Record<string, { preparationMode: string; preparationVersion: string; digest: string }>;
};

// Text that Turndown escapes (emphasis, list and heading markers, brackets)
// so an escaping change moves the HTML digests.
const detailHtml = `<!DOCTYPE html><html><body><h1>Riverside Clinic</h1><main>
<section><p>Annual enrollment fee: $4,250 per participant.</p>
<p>1. Bring *two* forms_of ID [original] # not a heading</p></section>
<section><ul><li>Parking available</li><li>Wheelchair accessible</li><li>Open weekends</li></ul></section>
</main></body></html>`;

const inputs: Record<string, { content: string; contentType: ContentType }> = {
  "html-listing": { content: fixture("repeated-cards-page.html"), contentType: "html" },
  "html-detail": { content: detailHtml, contentType: "html" },
  transcript: { content: fixture("auto-captions.vtt"), contentType: "transcript" },
  text: { content: "Title: Alpine Hut\nFee: 1. *Twenty* dollars_per night", contentType: "text" },
};

const schema: TargetFieldSchema[] = [{ path: "title", type: "string" }];
const silent: ExtractionProvider = {
  name: "preparation-fixture",
  async extract() { return { proposals: [], raw: { response: "", model: "fixture-model" } }; },
};

async function artifactFor(name: string): Promise<PreparedArtifact> {
  const result = await extract({ ...inputs[name], sourceRef: `fixture:${name}`, targetSchema: schema, provider: silent });
  assert.equal(result.error, undefined);
  return result.preparedArtifact!;
}

function installedVersion(name: string): string {
  return (JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8")) as { version: string }).version;
}

describe("preparationVersion", () => {
  it("golden inputs cover every case and the current base version", () => {
    assert.deepEqual(Object.keys(goldens.cases).sort(), Object.keys(inputs).sort());
    assert.equal(goldens.baseVersion, PREPARED_ARTIFACT_PREPARATION_VERSION);
    assert.equal(PREPARED_ARTIFACT_PREPARATION_VERSION, "2");
  });

  for (const name of Object.keys(inputs)) {
    it(`${name}: prepared text matches its golden digest for this version`, async () => {
      const golden = goldens.cases[name];
      const artifact = await artifactFor(name);
      assert.equal(artifact.preparationMode, golden.preparationMode);
      assert.equal(
        artifact.preparationVersion,
        golden.preparationVersion,
        "the preparation version changed; re-record the goldens for it",
      );
      assert.equal(
        artifact.digest,
        golden.digest,
        `prepared text for "${name}" changed while preparationVersion stayed ${artifact.preparationVersion}: ` +
          "bump PREPARED_ARTIFACT_PREPARATION_VERSION and re-record tests/fixtures/preparation-goldens.json",
      );
    });
  }

  it("names the installed linkedom and turndown versions for HTML Markdown only", async () => {
    const expected = `${PREPARED_ARTIFACT_PREPARATION_VERSION}+linkedom@${installedVersion("linkedom")}+turndown@${installedVersion("turndown")}`;
    assert.equal((await artifactFor("html-listing")).preparationVersion, expected);
    assert.equal((await artifactFor("transcript")).preparationVersion, PREPARED_ARTIFACT_PREPARATION_VERSION);
    assert.equal((await artifactFor("text")).preparationVersion, PREPARED_ARTIFACT_PREPARATION_VERSION);
    const htmlAsText = await extract({ ...inputs["html-detail"], prep: "text", sourceRef: "fixture", targetSchema: schema, provider: silent });
    assert.equal(htmlAsText.preparedArtifact?.preparationVersion, PREPARED_ARTIFACT_PREPARATION_VERSION);
  });

  it("a different installed library version gives a different version and ref", () => {
    const installed = preparationVersionFor("markdown");
    const stubbed = preparationVersionFor("markdown", (name) => (name === "turndown" ? "7.3.0" : installedVersion(name)));
    assert.notEqual(stubbed, installed);
    assert.match(stubbed, /\+turndown@7\.3\.0$/);
    const text = "# Riverside Clinic";
    const current = createPreparedArtifact(text, { preparationMode: "markdown" });
    const other = createPreparedArtifact(text, { preparationMode: "markdown", preparationVersion: stubbed });
    assert.equal(current.preparationVersion, installed);
    assert.notEqual(other.ref, current.ref);
    assert.equal(other.digest, current.digest);
  });

  it("a caller-supplied preparationVersion still wins", async () => {
    const result = await extract({ ...inputs["html-detail"], sourceRef: "fixture", targetSchema: schema, provider: silent, preparedArtifact: { preparationVersion: "caller-v1" } });
    assert.equal(result.preparedArtifact?.preparationVersion, "caller-v1");
  });

  it("an envelope carrying the derived version imports through Survey's importer", async () => {
    const quoting: ExtractionProvider = {
      name: "preparation-fixture",
      async extract() {
        return {
          proposals: [{ fieldPath: "title", candidateValue: "Riverside Clinic", confidence: 0.9, extractor: "fixture", provenance: { excerpt: "Riverside Clinic", locator: "x" } }],
          raw: { response: "", model: "fixture-model" },
        };
      },
    };
    const result = await extract({ ...inputs["html-detail"], sourceRef: "fixture", targetSchema: schema, provider: quoting });
    assert.match(result.preparedArtifact!.preparationVersion, /\+linkedom@.+\+turndown@/);
    const imported = importExtractionEnvelope(serializePortableExtractionResult(result), {
      sourceKind: "uploaded-document",
      claimTarget: () => ({
        subjectType: "fixture", subjectId: "fixture-1", facet: "fixture", claimType: "field-value",
        fieldOrBehavior: "title", impactLevel: "low",
      }),
    });
    assert.ok(JSON.stringify(imported).includes(result.preparedArtifact!.ref));
  });
});
