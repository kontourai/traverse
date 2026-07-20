import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runBenchmark(): string {
  const result = spawnSync(process.execPath, ["evals/grounded-extraction/run.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("grounded extraction benchmark is deterministic and exposes the first-occurrence limitation", () => {
  const first = runBenchmark();
  const second = runBenchmark();
  assert.equal(second, first);
  const records = first.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 9);
  const cases = records.filter((record) => record.kind === "grounded-extraction-case");
  const summary = records.find((record) => record.kind === "grounded-extraction-summary");
  assert.equal(cases.length, 8);
  assert.ok(summary);
  for (const record of cases) {
    assert.match(record.corpusRevision, /^[a-f0-9]{64}$/);
    assert.match(record.taskDigest, /^[a-f0-9]{64}$/);
    assert.match(record.implementationRevision, /^@kontourai\/traverse@/);
    for (const metric of ["exactSpanPrecision", "exactSpanRecall", "valueAccuracy", "typeValidity", "groundedDropRate", "falseGroundingRate", "schemaCoverage", "calls", "tokens", "latencyMs", "typedFailures"]) {
      assert.ok(Object.hasOwn(record.metrics, metric), `${record.caseId} missing ${metric}`);
    }
    for (const failure of record.metrics.typedFailures) {
      assert.match(failure.kind, /^(error|warning)$/);
      assert.match(failure.code, /^[a-z0-9-]+$/);
      assert.equal(typeof failure.message, "string");
    }
  }
  const repeated = cases.find((record) => record.caseId === "repeated-identical-value-distinct-locators");
  assert.equal(repeated.expectedLimitation, "first-occurrence-resolver");
  assert.ok(repeated.metrics.exactSpanRecall < 1);
  assert.equal(cases.find((record) => record.caseId === "shared-span-multiple-fields").metrics.exactSpanRecall, 1);
  assert.ok(cases.find((record) => record.caseId === "unknown-and-ungrounded-provider-output").metrics.groundedDropRate > 0);
  assert.ok(cases.find((record) => record.caseId === "chunk-boundary-scan").metrics.calls > 1);
  assert.equal(cases.find((record) => record.caseId === "ocr-location-grounding").metrics.falseGroundingRate, 0);
});

test("optional live lane labels non-hermetic provider, model, usage, latency, and revisions", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "traverse-grounded-live-"));
  try {
    const providerFile = path.join(temporary, "provider.mjs");
    fs.writeFileSync(providerFile, `export default { name: "live-fixture-provider", async extract() { return { proposals: [], raw: { response: "fixture", model: "live-fixture-model", tokensUsed: 3 } }; } };\n`);
    const result = spawnSync(process.execPath, ["evals/grounded-extraction/run.mjs", "--provider-module", providerFile, "--model", "live-fixture-model"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const cases = records.filter((record) => record.kind === "grounded-extraction-case");
    assert.equal(cases.length, 8);
    for (const record of cases) {
      assert.equal(record.mode, "live");
      assert.equal(record.provider, "live-fixture-provider");
      assert.equal(record.model, "live-fixture-model");
      assert.equal(record.metrics.tokens, 3 * record.metrics.calls);
      assert.ok(record.metrics.latencyMs >= 0);
      assert.match(record.corpusRevision, /^[a-f0-9]{64}$/);
      assert.match(record.taskDigest, /^[a-f0-9]{64}$/);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
