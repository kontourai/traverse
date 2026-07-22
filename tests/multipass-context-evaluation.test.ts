import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

type RecordValue = Record<string, any>;

function run(...args: string[]): RecordValue[] {
  const result = spawnSync(process.execPath, ["evals/grounded-extraction/multipass-context.mjs", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").map((line) => JSON.parse(line));
}

function deterministicView(records: RecordValue[]): RecordValue[] {
  return records.map((record) => JSON.parse(JSON.stringify(record, (key, value) =>
    key === "runId" ? undefined : value,
  )));
}

test("threshold and configuration identity are durably emitted before execution", () => {
  const first = run();
  const second = run();
  assert.deepEqual(deterministicView(second), deterministicView(first));
  assert.equal(first[0].kind, "grounded-extraction-multipass-context-thresholds");
  assert.match(first[0].thresholdConfigurationDigest, /^[a-f0-9]{64}$/);
  assert.equal(first[0].productValueEvidenceRequirement, "predeclared-real-provider-comparison");
  const firstAttempt = first.findIndex((record) => record.kind === "grounded-extraction-multipass-context-attempt-started");
  const firstProviderCall = first.findIndex((record) => record.kind === "grounded-extraction-multipass-context-provider-call-started");
  const firstCompletion = first.findIndex((record) => record.kind === "grounded-extraction-multipass-context-attempt-completed");
  assert.equal(firstAttempt, 1, "threshold/config record is emitted before the first logical attempt");
  assert.ok(firstProviderCall > firstAttempt, "provider call occurs after attempt identity is emitted");
  assert.ok(firstCompletion > firstProviderCall, "attempt completion occurs after its physical provider call");
  assert.ok(first.slice(1).every((record) => record.thresholdConfigurationDigest === first[0].thresholdConfigurationDigest));
});

test("attempts and exact-only merge retain replay-correlatable identity", () => {
  const records = run();
  const cases = records.filter((record) => record.kind === "grounded-extraction-multipass-context-case");
  assert.equal(cases.length, 3);
  for (const record of cases) {
    assert.equal(record.attempts.length, 2);
    assert.equal(record.attempts[0].logicalAttempt, 1);
    assert.equal(record.attempts[0].pass, "first-pass");
    assert.equal(record.attempts[0].contextProposalCount, 0);
    assert.equal(record.attempts[1].logicalAttempt, 2);
    assert.equal(record.attempts[1].pass, "later-pass");
    assert.ok(record.attempts[1].contextProposalCount > 0);
    for (const attempt of record.attempts) {
      assert.match(attempt.runId, /^traverse-extraction-run:/);
      assert.match(attempt.taskDigest, /^[a-f0-9]{64}$/);
      assert.match(attempt.configurationDigest, /^[a-f0-9]{64}$/);
      assert.equal(attempt.provider, "grounded-benchmark-hermetic-multipass");
      assert.equal(attempt.model, "hermetic-multipass-context-v1");
      assert.equal(attempt.providerCalls, 1);
      assert.equal(attempt.tokens, 7);
      assert.equal(attempt.latencyMs, 0);
      assert.ok(Array.isArray(attempt.typedFailures));
      assert.match(attempt.proposalSetDigest, /^[a-f0-9]{64}$/);
      assert.ok(attempt.proposalIdentities.every((identity: RecordValue) => /^[a-f0-9]{64}$/.test(identity.proposalDigest)));
    }
    assert.equal(record.budget.consumedLogicalAttempts, 2);
    assert.equal(record.budget.consumedProviderCalls, 2);
    assert.equal(record.budget.consumedTokens, 14);
    assert.equal(record.budget.tokenOvershoot, 0);
    assert.equal(record.metrics.firstPass.exactSpanRecall, 0.5);
    assert.equal(record.metrics.laterPass.exactSpanRecall, 0.5);
    assert.equal(record.metrics.merged.exactSpanPrecision, 1);
    assert.equal(record.metrics.merged.exactSpanRecall, 1);
    assert.equal(record.metrics.merged.falseGroundingRate, 0);
    assert.equal(record.merge.algorithm, "ordered-exact-proposal-key-v1");
    assert.equal(record.merge.consensusOrFuzzyAgreement, "never-used-for-provenance");
    assert.match(record.merge.proposalSetDigest, /^[a-f0-9]{64}$/);
  }
  const summary = records.at(-1)!;
  assert.equal(summary.mechanicsGate, "PASS");
  assert.equal(summary.productValueGate, "NOT_VERIFIED");
  assert.equal(summary.decision, "REJECT");
  assert.equal(summary.liveProviderEvidence, "NOT_VERIFIED");
});

test("shared token budget stops before a later logical attempt when fully consumed", () => {
  const records = run("--max-tokens", "7");
  const cases = records.filter((record) => record.kind === "grounded-extraction-multipass-context-case");
  for (const record of cases) {
    assert.equal(record.attempts.length, 1);
    assert.equal(record.budget.consumedLogicalAttempts, 1);
    assert.equal(record.budget.consumedProviderCalls, 1);
    assert.equal(record.budget.consumedTokens, 7);
    assert.equal(record.budget.tokenOvershoot, 0);
    assert.equal(record.budget.laterPassSkipped, true);
    assert.equal(record.metrics.merged.exactSpanRecall, 0.5);
  }
});

test("shared token budget passes the remaining ceiling and reports completed-call overshoot", () => {
  const records = run("--max-tokens", "8");
  const cases = records.filter((record) => record.kind === "grounded-extraction-multipass-context-case");
  for (const record of cases) {
    assert.equal(record.attempts.length, 2);
    assert.equal(record.attempts[1].configuration.limits.maxTotalTokens, 1);
    assert.equal(record.attempts[1].configuration.limits.maxProviderCalls, 1);
    assert.equal(record.budget.consumedLogicalAttempts, 2);
    assert.equal(record.budget.consumedProviderCalls, 2);
    assert.equal(record.budget.consumedTokens, 14);
    assert.equal(record.budget.tokenOvershoot, 6);
    assert.equal(record.budget.laterPassSkipped, false);
  }
  assert.equal(records.at(-1)!.observedSyntheticFixtureMetrics.tokenOvershoot, 18);
});
