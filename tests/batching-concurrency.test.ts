import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract } from "../src/extract.js";
import type { ExtractionProvider, ProviderExtractionInput, ProviderExtractionOutput } from "../src/types.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

const content = "A000000000B000000000C000000000D000000000E000000000F000000000";
const chunkSize = 10;

function output(input: ProviderExtractionInput, tokensUsed?: number): ProviderExtractionOutput {
  const excerpt = input.content.slice(0, 1);
  return {
    proposals: [{
      fieldPath: "title",
      candidateValue: excerpt,
      confidence: 0.9,
      provenance: { excerpt, locator: "provisional" },
      extractor: "bounded-mock",
    }],
    raw: { response: input.content, model: "bounded-mock", ...(tokensUsed === undefined ? {} : { tokensUsed }) },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function batchProvider(opts: { maxConcurrency?: number; maxBatchSize?: number; tokensUsed?: number; onStart?: () => void } = {}) {
  let active = 0;
  let peak = 0;
  const batchSizes: number[] = [];
  const enter = async <T>(work: () => Promise<T>): Promise<T> => {
    active++;
    peak = Math.max(peak, active);
    opts.onStart?.();
    try { return await work(); }
    finally { active--; }
  };
  const provider: ExtractionProvider = {
    name: "bounded-mock",
    capabilities: {
      supported: ["structured-output", "exact-excerpts"],
      ...(opts.maxConcurrency === undefined ? {} : { maxConcurrency: opts.maxConcurrency }),
      ...(opts.maxBatchSize === undefined ? {} : { maxBatchSize: opts.maxBatchSize }),
    },
    async extract(input) {
      return enter(async () => {
        await wait(input.content.charCodeAt(0) % 5);
        return output(input, opts.tokensUsed);
      });
    },
    async extractBatch(inputs) {
      return enter(async () => {
        batchSizes.push(inputs.length);
        await wait(5);
        return inputs.map((input) => ({
          status: "fulfilled" as const,
          value: output(input, opts.tokensUsed),
        }));
      });
    },
  };
  return { provider, get peak() { return peak; }, batchSizes };
}

async function run(provider: ExtractionProvider, extra: Partial<Parameters<typeof extract>[0]> = {}) {
  return extract({
    content,
    contentType: "text",
    sourceRef: "fixture",
    targetSchema: genericTargetSchema,
    provider,
    chunkSize,
    chunkOverlap: 0,
    ...extra,
  });
}

describe("extract() bounded batching and concurrency", () => {
  it("keeps legacy providers sequential by default", async () => {
    let active = 0;
    let peak = 0;
    const provider: ExtractionProvider = {
      name: "legacy",
      async extract(input) {
        active++;
        peak = Math.max(peak, active);
        await wait(2);
        active--;
        return output(input);
      },
    };
    const result = await run(provider);
    assert.equal(peak, 1);
    assert.equal(result.providerCalls, 6);
    assert.equal(result.partial, undefined);
  });

  it("caps physical batches by caller and provider limits", async () => {
    const observed = batchProvider({ maxConcurrency: 2, maxBatchSize: 2 });
    const result = await run(observed.provider, { concurrency: 4, batchSize: 4 });
    assert.equal(observed.peak, 2);
    assert.ok(observed.batchSizes.every((size) => size <= 2));
    assert.equal(result.providerCalls, 3, "six chunks grouped into three physical calls");
  });

  it("retains successful siblings and classifies one physical-batch item failure", async () => {
    const provider: ExtractionProvider = {
      name: "partial-batch",
      capabilities: {
        supported: ["structured-output", "exact-excerpts"],
        maxBatchSize: 2,
      },
      async extract(input) { return output(input); },
      async extractBatch(inputs) {
        return inputs.map((input, index) => index === 0
          ? { status: "fulfilled" as const, value: output(input) }
          : {
            status: "rejected" as const,
            reason: Object.assign(new Error("one item was rate limited"), {
              code: "RATE_LIMITED",
              retryable: true,
            }),
          });
      },
    };
    const result = await run(provider, { batchSize: 2 });
    assert.equal(result.providerCalls, 3);
    assert.equal(result.proposals.length, 3);
    assert.equal(result.providerFailures?.length, 3);
    assert.ok(result.providerFailures?.every((failure) =>
      failure.kind === "rate-limit" && failure.retryable));
  });

  it("folds proposals and locators in original chunk order across worker and batch counts", async () => {
    const sequential = batchProvider();
    const parallel = batchProvider({ maxConcurrency: 3, maxBatchSize: 2 });
    const one = await run(sequential.provider);
    const many = await run(parallel.provider, { concurrency: 3, batchSize: 2 });
    assert.deepEqual(
      many.proposals.map((proposal) => [proposal.candidateValue, proposal.provenance.locator]),
      one.proposals.map((proposal) => [proposal.candidateValue, proposal.provenance.locator]),
    );
  });

  it("reserves physical call budget before dispatching a concurrent wave", async () => {
    const observed = batchProvider({ maxConcurrency: 3, maxBatchSize: 2 });
    const result = await run(observed.provider, { concurrency: 3, batchSize: 2, maxProviderCalls: 2 });
    assert.equal(result.providerCalls, 2);
    assert.deepEqual(result.partial, { reason: "max-provider-calls", completedChunks: 4, remainingChunks: 2 });
    assert.equal(observed.batchSizes.length, 2);
  });

  it("bounds and reports token overshoot to the completed concurrent wave", async () => {
    const observed = batchProvider({ tokensUsed: 10 });
    const result = await run(observed.provider, { concurrency: 2, maxTotalTokens: 5 });
    assert.equal(result.providerCalls, 2);
    assert.equal(result.totalTokensUsed, 20);
    assert.deepEqual(result.partial, {
      reason: "max-total-tokens", completedChunks: 2, remainingChunks: 4, tokenOvershoot: 15,
    });
  });

  it("reports token overshoot when the call ceiling wins the simultaneous stop", async () => {
    const observed = batchProvider({ tokensUsed: 10 });
    const result = await run(observed.provider, { concurrency: 2, maxProviderCalls: 2, maxTotalTokens: 5 });
    assert.equal(result.providerCalls, 2);
    assert.equal(result.totalTokensUsed, 20);
    assert.deepEqual(result.partial, {
      reason: "max-provider-calls", completedChunks: 2, remainingChunks: 4, tokenOvershoot: 15,
    });
  });

  it("stops dispatching new waves on cancellation and returns typed progress", async () => {
    const controller = new AbortController();
    let starts = 0;
    const observed = batchProvider({ onStart: () => { if (++starts === 2) controller.abort(); } });
    const result = await run(observed.provider, { concurrency: 2, signal: controller.signal });
    assert.equal(result.providerCalls, 2, "the already-reserved first wave completes");
    assert.deepEqual(result.partial, { reason: "cancelled", completedChunks: 2, remainingChunks: 4 });
  });
});
