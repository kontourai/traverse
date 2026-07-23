import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthorizationBudgetExceededError,
  AuthorizationBudgetLedger,
} from "../evals/grounded-extraction/authorization-budget-ledger.mjs";

function fixture(filePath, overrides = {}) {
  return new AuthorizationBudgetLedger({
    filePath,
    authorizationDigest: "a".repeat(64),
    limits: { maxProviderCalls: 2, maxTotalTokens: 30, maxSpendUsd: 1 },
    reservation: { inputTokens: 10, outputTokens: 5, spendUsd: 0.25 },
    ...overrides,
  });
}

test("an unsettled reservation survives restart and consumes authorization budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "traverse-ledger-"));
  const ledgerPath = path.join(root, "authorization.jsonl");
  try {
    await fixture(ledgerPath).reserve({ runId: "run-1", attemptId: "attempt-1" });
    await fixture(ledgerPath).reserve({ runId: "run-2", attemptId: "attempt-2" });
    await assert.rejects(
      fixture(ledgerPath).reserve({ runId: "run-3", attemptId: "attempt-3" }),
      (error) => error instanceof AuthorizationBudgetExceededError
        && error.totals.providerCalls === 2
        && error.totals.started === 2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent reservations cannot exceed the shared ceiling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "traverse-ledger-"));
  const ledgerPath = path.join(root, "authorization.jsonl");
  try {
    const ledger = fixture(ledgerPath);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        ledger.reserve({ runId: "concurrent-run", attemptId: `attempt-${index}` })),
    );
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 2);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 6);
    assert.equal((await ledger.totals()).providerCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement distinguishes completion and local rejection without retaining secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "traverse-ledger-"));
  const ledgerPath = path.join(root, "authorization.jsonl");
  try {
    const ledger = fixture(ledgerPath);
    const completed = await ledger.reserve({ runId: "run-safe", attemptId: "attempt-completed" });
    await ledger.settle(completed.reservationId, {
      status: "completed",
      inputTokens: 3,
      outputTokens: 4,
      spendUsd: 0.02,
    });
    const rejected = await ledger.reserve({ runId: "run-safe", attemptId: "attempt-local" });
    await ledger.settle(rejected.reservationId, { status: "locally-rejected" });
    assert.deepEqual(await ledger.totals(), {
      providerCalls: 1,
      totalTokens: 7,
      inputTokens: 3,
      outputTokens: 4,
      spendUsd: 0.02,
      started: 0,
      completed: 1,
      failed: 0,
      aborted: 0,
      locallyRejected: 1,
    });
    const bytes = await readFile(ledgerPath, "utf8");
    assert.doesNotMatch(bytes, /prompt|credential|api[_-]?key/i);
    await assert.rejects(
      ledger.reserve({ runId: "secret value with spaces", attemptId: "attempt" }),
      /non-secret identifier/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lock left by a dead process does not permanently block authorization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "traverse-ledger-"));
  const ledgerPath = path.join(root, "authorization.jsonl");
  try {
    await mkdir(`${ledgerPath}.lock`);
    await writeFile(
      path.join(`${ledgerPath}.lock`, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647 }),
    );
    const reservation = await fixture(ledgerPath).reserve({
      runId: "recovered-run",
      attemptId: "recovered-attempt",
    });
    assert.ok(reservation.reservationId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
