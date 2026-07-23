import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export class AuthorizationBudgetExceededError extends Error {
  constructor(message, totals) {
    super(message);
    this.name = "AuthorizationBudgetExceededError";
    this.totals = totals;
  }
}

export class AuthorizationBudgetLedger {
  constructor({ filePath, authorizationDigest, limits, reservation, now = () => new Date().toISOString() }) {
    if (!path.isAbsolute(filePath)) throw new TypeError("ledger filePath must be absolute");
    assertIdentifier("authorizationDigest", authorizationDigest);
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.authorizationDigest = authorizationDigest;
    this.limits = Object.freeze({
      maxProviderCalls: positiveInteger("maxProviderCalls", limits.maxProviderCalls),
      maxTotalTokens: positiveInteger("maxTotalTokens", limits.maxTotalTokens),
      maxSpendUsd: nonnegativeNumber("maxSpendUsd", limits.maxSpendUsd),
    });
    this.reservation = Object.freeze({
      inputTokens: nonnegativeInteger("reservation.inputTokens", reservation.inputTokens),
      outputTokens: nonnegativeInteger("reservation.outputTokens", reservation.outputTokens),
      spendUsd: nonnegativeNumber("reservation.spendUsd", reservation.spendUsd),
    });
    this.now = now;
  }

  async reserve({ runId, attemptId }) {
    assertIdentifier("runId", runId);
    assertIdentifier("attemptId", attemptId);
    return this.#withLock(async () => {
      const events = await this.#events();
      const totals = summarizeAuthorization(events, this.authorizationDigest);
      const projected = {
        providerCalls: totals.providerCalls + 1,
        totalTokens: totals.totalTokens + this.reservation.inputTokens + this.reservation.outputTokens,
        spendUsd: totals.spendUsd + this.reservation.spendUsd,
      };
      const exceeded = [];
      if (projected.providerCalls > this.limits.maxProviderCalls) exceeded.push("provider calls");
      if (projected.totalTokens > this.limits.maxTotalTokens) exceeded.push("tokens");
      if (projected.spendUsd > this.limits.maxSpendUsd) exceeded.push("spend");
      if (exceeded.length) {
        throw new AuthorizationBudgetExceededError(
          `authorization-wide ${exceeded.join(", ")} ceiling reached`,
          totals,
        );
      }
      const reservationId = randomUUID();
      await this.#append({
        schemaVersion: "1.0",
        event: "started",
        authorizationDigest: this.authorizationDigest,
        reservationId,
        runId,
        attemptId,
        recordedAt: this.now(),
        reserved: this.reservation,
      });
      return Object.freeze({ reservationId, totals: Object.freeze(projected) });
    });
  }

  async settle(reservationId, { status, inputTokens = 0, outputTokens = 0, spendUsd = 0 }) {
    assertIdentifier("reservationId", reservationId);
    if (!["completed", "failed", "aborted", "locally-rejected"].includes(status)) {
      throw new TypeError("status must be completed, failed, aborted, or locally-rejected");
    }
    const usage = {
      inputTokens: nonnegativeInteger("inputTokens", inputTokens),
      outputTokens: nonnegativeInteger("outputTokens", outputTokens),
      spendUsd: nonnegativeNumber("spendUsd", spendUsd),
    };
    return this.#withLock(async () => {
      const events = await this.#events();
      const matching = events.filter((event) =>
        event.authorizationDigest === this.authorizationDigest
        && event.reservationId === reservationId);
      if (matching.length !== 1 || matching[0].event !== "started") {
        throw new Error("reservation is missing or already settled");
      }
      await this.#append({
        schemaVersion: "1.0",
        event: status,
        authorizationDigest: this.authorizationDigest,
        reservationId,
        recordedAt: this.now(),
        usage,
      });
      return this.totals();
    });
  }

  async totals() {
    return summarizeAuthorization(await this.#events(), this.authorizationDigest);
  }

  async #events() {
    let bytes;
    try {
      bytes = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return bytes.split("\n").filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid authorization ledger record at line ${index + 1}`, { cause: error });
      }
    });
  }

  async #append(event) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await open(this.filePath, "a", 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #withLock(action) {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await mkdir(this.lockPath);
        const owner = await open(path.join(this.lockPath, "owner.json"), "wx", 0o600);
        try {
          await owner.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
          await owner.sync();
        } finally {
          await owner.close();
        }
        acquired = true;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (attempt > 10 && await this.#lockOwnerIsDead()) {
          await rm(this.lockPath, { recursive: true, force: true });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!acquired) throw new Error("authorization ledger lock timed out");
    try {
      return await action();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async #lockOwnerIsDead() {
    try {
      const owner = JSON.parse(await readFile(path.join(this.lockPath, "owner.json"), "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    } catch {
      return false;
    }
  }
}

export function summarizeAuthorization(events, authorizationDigest) {
  const reservations = new Map();
  for (const event of events) {
    if (event.authorizationDigest !== authorizationDigest) continue;
    const existing = reservations.get(event.reservationId);
    if (!existing) {
      if (event.event !== "started") throw new Error("authorization ledger settlement precedes reservation");
      reservations.set(event.reservationId, { started: event, settled: undefined });
    } else {
      if (event.event === "started" || existing.settled) throw new Error("authorization ledger contains duplicate reservation state");
      existing.settled = event;
    }
  }
  const totals = {
    providerCalls: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    spendUsd: 0,
    started: 0,
    completed: 0,
    failed: 0,
    aborted: 0,
    locallyRejected: 0,
  };
  for (const { started, settled } of reservations.values()) {
    if (!settled) {
      totals.started += 1;
      totals.providerCalls += 1;
      totals.inputTokens += started.reserved.inputTokens;
      totals.outputTokens += started.reserved.outputTokens;
      totals.spendUsd += started.reserved.spendUsd;
      continue;
    }
    if (settled.event === "locally-rejected") {
      totals.locallyRejected += 1;
      continue;
    }
    totals[settled.event] += 1;
    totals.providerCalls += 1;
    if (settled.event === "completed") {
      totals.inputTokens += settled.usage.inputTokens;
      totals.outputTokens += settled.usage.outputTokens;
      totals.spendUsd += settled.usage.spendUsd;
    } else {
      totals.inputTokens += Math.max(started.reserved.inputTokens, settled.usage.inputTokens);
      totals.outputTokens += Math.max(started.reserved.outputTokens, settled.usage.outputTokens);
      totals.spendUsd += Math.max(started.reserved.spendUsd, settled.usage.spendUsd);
    }
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  return Object.freeze(totals);
}

function assertIdentifier(name, value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${name} must be a bounded, non-secret identifier`);
  }
}

function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative integer`);
  return value;
}

function nonnegativeNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative finite number`);
  }
  return value;
}
