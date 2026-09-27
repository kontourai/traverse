import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createExtractionTaskSpec, serializePortableExtractionResult, extract } from "../src/index.js";
import type { ExtractionTaskSpec, TargetFieldSchema } from "../src/index.js";
import { canonicalTaskJson } from "../src/task.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";

const execFileAsync = promisify(execFile);
const indexUrl = new URL("../src/index.js", import.meta.url).href;
const legacyFixturePath = fileURLToPath(new URL("../../tests/fixtures/legacy-locale-digest-task-spec.en-US.json", import.meta.url));

// Mixed-case, `_`-prefixed, non-ASCII and integer-like keys: the key classes
// whose order differs between locale collation and UTF-16 code-unit order.
const trickyValue = { Zeta: 1, alpha: 2, _id: 3, "ä": 4, "10": 5, "9": 6 };
const targetSchema: TargetFieldSchema[] = [{ path: "meta", type: "object" }];
const draft = {
  version: "1",
  targetSchema,
  examples: [{ content: "Meta: ok", proposals: [{ fieldPath: "meta", candidateValue: trickyValue, excerpt: "Meta: ok" }] }],
};

// Pinned literals for `draft` (code-unit key order). Changing them breaks
// every task spec already written by this version.
const PINNED_CANONICAL_VALUE = '{"10":5,"9":6,"Zeta":1,"_id":3,"alpha":2,"ä":4}';
const PINNED_TASK_DIGEST = "sha256:205ec874b0da398228a6e6bd674fb5917ead356f5bbd8d35081f68252b2b49f0";
const PINNED_EXAMPLE_DIGEST = "sha256:c428831b06e8665fbf4bafe0204dfafa054861e04513d62a3be1634bbe1ad2fb";

/** Run a module snippet in a child Node process under the given locale; returns its parsed JSON stdout. */
async function inLocale(locale: string, body: string): Promise<any> {
  const script = `import * as traverse from ${JSON.stringify(indexUrl)};\n${body}`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, LC_ALL: locale, LANG: locale },
  });
  return JSON.parse(stdout);
}

const probe = `
const draft = ${JSON.stringify(draft)};
const spec = traverse.createExtractionTaskSpec(draft);
console.log(JSON.stringify({
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  collation: Math.sign("ä".localeCompare("z")),
  digest: spec.digest,
  exampleDigest: spec.examples[0].digest,
}));`;

describe("task-spec digests are independent of the host locale", () => {
  it("computes identical digests under sv_SE and en_US child processes", async () => {
    const en = await inLocale("en_US.UTF-8", probe);
    const sv = await inLocale("sv_SE.UTF-8", probe);
    // Reachability: the two children really run under collations that order
    // "ä" differently; otherwise digest equality would prove nothing.
    assert.equal(en.locale, "en-US");
    assert.equal(sv.locale, "sv-SE");
    assert.equal(en.collation, -1);
    assert.equal(sv.collation, 1);
    assert.equal(sv.digest, en.digest);
    assert.equal(sv.exampleDigest, en.exampleDigest);
    assert.equal(en.digest, PINNED_TASK_DIGEST);
    assert.equal(en.exampleDigest, PINNED_EXAMPLE_DIGEST);
  });

  it("pins the canonical key order and digests in process", () => {
    assert.equal(canonicalTaskJson(trickyValue), PINNED_CANONICAL_VALUE);
    const spec = createExtractionTaskSpec(draft);
    assert.equal(spec.digest, PINNED_TASK_DIGEST);
    assert.equal(spec.examples?.[0].digest, PINNED_EXAMPLE_DIGEST);
  });

  it("orders keys the same way as the portable envelope", async () => {
    const provider = createMockExtractionProvider({
      proposals: [{ fieldPath: "meta", candidateValue: trickyValue, confidence: 0.9, extractor: "mock", provenance: { excerpt: "Meta: ok", locator: "x" } }],
      raw: { response: "{}", model: "mock" },
    });
    const result = await extract({ sourceRef: "s", content: "Meta: ok", contentType: "text", targetSchema, provider });
    assert.equal(result.proposals.length, 1);
    const serialized = serializePortableExtractionResult(result);
    assert.ok(serialized.includes(`"candidateValue":${canonicalTaskJson(trickyValue)}`), serialized);
  });
});

describe("legacy locale-dependent digests", () => {
  // The fixture was written by createExtractionTaskSpec before this change,
  // under LC_ALL=en_US.UTF-8, so its digests use localeCompare ordering.
  const runLegacy = (mutate: string) => `
import { readFileSync } from "node:fs";
const spec = JSON.parse(readFileSync(${JSON.stringify(legacyFixturePath)}, "utf8"));
${mutate}
const provider = { name: "p", async extract() { return { proposals: [], raw: { response: "", model: "m" } }; } };
const result = await traverse.extract({ sourceRef: "s", content: "Meta: ok", contentType: "text", targetSchema: spec.targetSchema, taskSpec: spec, provider });
console.log(JSON.stringify({ error: result.error ?? null, providerCalls: result.providerCalls, warnings: result.warnings ?? [] }));`;

  it("the fixture differs from its code-unit digests", async () => {
    const legacy = JSON.parse(await readFile(legacyFixturePath, "utf8")) as ExtractionTaskSpec;
    assert.notEqual(legacy.digest, PINNED_TASK_DIGEST);
    assert.notEqual(legacy.examples?.[0].digest, PINNED_EXAMPLE_DIGEST);
  });

  it("still validates under en_US and warns that the digest is legacy", async () => {
    const out = await inLocale("en_US.UTF-8", runLegacy(""));
    assert.equal(out.error, null);
    assert.equal(out.providerCalls, 1);
    assert.deepEqual(out.warnings, [
      "taskSpec uses the legacy locale-dependent digest (taskSpec.digest, taskSpec.examples[0].digest); regenerate it with createExtractionTaskSpec",
    ]);
  });

  it("rejects a digest that matches neither form", async () => {
    const out = await inLocale("en_US.UTF-8", runLegacy(`spec.digest = "sha256:" + "0".repeat(64);`));
    assert.equal(out.error, "invalid taskSpec: taskSpec.digest does not match its canonical payload");
    assert.equal(out.providerCalls, 0);
  });

  it("a current-form spec carries no legacy warning", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const result = await extract({ sourceRef: "s", content: "Meta: ok", contentType: "text", targetSchema, taskSpec: createExtractionTaskSpec(draft), provider });
    assert.equal(result.error, undefined);
    assert.equal(result.warnings, undefined);
  });
});
