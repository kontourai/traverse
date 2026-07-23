#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createClaudeCodeRuntime } from "@kontourai/relay/claude-code";
import { extract, prepareContent } from "../../dist/src/index.js";
import { createRelayExtractionProvider } from "../../dist/src/relay.js";

const configUrl = new URL("./live-multipass-context.v1.json", import.meta.url);
const corpusUrl = new URL("./corpus.v1.json", import.meta.url);
const configBytes = fs.readFileSync(configUrl);
const corpusBytes = fs.readFileSync(corpusUrl);
const config = JSON.parse(configBytes);
const corpus = JSON.parse(corpusBytes);

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const stable = (value) => JSON.stringify(canonical(value));
const digest = (value) => createHash("sha256").update(Buffer.isBuffer(value) ? value : stable(value)).digest("hex");
const emit = (value) => fs.writeSync(process.stdout.fd, `${JSON.stringify(value)}\n`);
const key = (proposal) => stable({
  fieldPath: proposal.fieldPath,
  pathIndices: proposal.pathIndices ?? [],
  candidateValue: proposal.candidateValue,
  locator: proposal.provenance.locator,
});

function nthIndex(text, excerpt, occurrence) {
  let start = 0;
  for (let index = 0; index < occurrence; index += 1) {
    start = text.indexOf(excerpt, start);
    if (start < 0) throw new Error(`gold excerpt missing: ${excerpt}`);
    if (index + 1 < occurrence) start += excerpt.length;
  }
  return start;
}

function expected(entry, text) {
  return entry.gold.map((gold) => {
    const start = nthIndex(text, gold.excerpt, gold.occurrence);
    return {
      fieldPath: gold.fieldPath,
      pathIndices: gold.pathIndices ?? [],
      candidateValue: gold.candidateValue,
      provenance: { excerpt: gold.excerpt, locator: `chars:${start}-${start + gold.excerpt.length}` },
    };
  });
}

function metrics(proposals, entry, text) {
  const actual = new Set(proposals.map(key));
  const gold = new Set(expected(entry, text).map(key));
  const matches = [...actual].filter((value) => gold.has(value)).length;
  const grounded = proposals.filter((proposal) => {
    const match = /^chars:(\d+)-(\d+)$/.exec(proposal.provenance.locator);
    return match && text.slice(Number(match[1]), Number(match[2])) === proposal.provenance.excerpt;
  }).length;
  return {
    exactSpanPrecision: actual.size === 0 ? 0 : matches / actual.size,
    exactSpanRecall: gold.size === 0 ? 1 : matches / gold.size,
    falseGroundingRate: proposals.length === 0 ? 0 : 1 - grounded / proposals.length,
  };
}

function mergeExact(results) {
  const seen = new Set();
  return results.flatMap((result) => result.proposals).filter((proposal) => {
    const identity = key(proposal);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

const selected = corpus.cases.filter((entry) => entry.multipassContext).slice(0, config.limits.cases);
if (selected.length !== config.limits.cases) throw new Error("frozen corpus does not contain the configured case count");

const configurationDigest = digest(configBytes);
const corpusRevision = digest(corpusBytes);
emit({
  schemaVersion: "1.0",
  kind: "grounded-extraction-live-multipass-thresholds",
  configurationDigest,
  corpusRevision,
  config,
});

let providerCalls = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalLatencyMs = 0;
const cases = [];

for (const entry of selected) {
  const preparedText = prepareContent(entry.content, entry.contentType, 5_000_000).text;
  if (typeof preparedText !== "string") throw new Error(`could not prepare ${entry.id}`);
  const results = [];
  const attempts = [];
  for (const pass of ["first-pass", "later-pass"]) {
    if (providerCalls >= config.limits.maxProviderCalls) throw new Error("provider call ceiling reached");
    const observations = [];
    const baseRuntime = createClaudeCodeRuntime({
      model: config.model,
      cwd: process.cwd(),
    });
    const runtime = {
      id: baseRuntime.id,
      capabilities: () => baseRuntime.capabilities(),
      async invoke(request, options) {
        const result = await baseRuntime.invoke(request, options);
        observations.push(result);
        return result;
      },
    };
    const previous = results.flatMap((result) => result.proposals);
    const taskSpec = pass === "later-pass"
      ? {
          guidance: [
            "This is a second, neighboring-context pass.",
            "The prior pass returned the proposals below.",
            "Re-read the source and return only additional grounded proposals that the prior pass missed.",
            "Do not repeat a prior proposal and do not treat agreement as provenance.",
            JSON.stringify(previous.map((proposal) => ({
              fieldPath: proposal.fieldPath,
              candidateValue: proposal.candidateValue,
              excerpt: proposal.provenance.excerpt,
              locator: proposal.provenance.locator,
            }))),
          ].join("\n"),
        }
      : undefined;
    const startedAt = Date.now();
    const result = await extract({
      content: entry.content,
      contentType: entry.contentType,
      sourceRef: `fixture://${corpus.fixtureRevision}/${entry.id}/${pass}`,
      targetSchema: entry.schema,
      provider: createRelayExtractionProvider({
        runtime,
        maxTokens: config.limits.maxOutputTokensPerCall,
      }),
      maxProviderCalls: 1,
      ...(taskSpec ? { taskSpec } : {}),
    });
    const elapsedMs = Date.now() - startedAt;
    providerCalls += result.providerCalls;
    const observation = observations[0];
    const inputTokens = observation?.usage.inputTokens ?? 0;
    const outputTokens = observation?.usage.outputTokens ?? 0;
    const latencyMs = observation?.latencyMs ?? elapsedMs;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalLatencyMs += latencyMs;
    if (inputTokens > config.limits.maxEstimatedInputTokensPerCall) throw new Error("input token estimate exceeded");
    if (latencyMs > config.limits.maxLatencyMsPerCall) throw new Error("latency ceiling exceeded");
    results.push(result);
    attempts.push({
      pass,
      runId: result.runId,
      providerCalls: result.providerCalls,
      inputTokens,
      outputTokens,
      latencyMs,
      proposals: result.proposals,
      warnings: result.warnings,
      error: result.error,
    });
    emit({
      schemaVersion: "1.0",
      kind: "grounded-extraction-live-multipass-attempt",
      configurationDigest,
      corpusRevision,
      caseId: entry.id,
      ...attempts.at(-1),
    });
  }
  const merged = mergeExact(results);
  const firstMetrics = metrics(results[0].proposals, entry, preparedText);
  const mergedMetrics = metrics(merged, entry, preparedText);
  cases.push({
    caseId: entry.id,
    firstPass: firstMetrics,
    merged: mergedMetrics,
    recallGain: mergedMetrics.exactSpanRecall - firstMetrics.exactSpanRecall,
    attempts,
    mergedProposals: merged,
  });
}

const aggregate = {
  firstPassRecall: cases.reduce((sum, entry) => sum + entry.firstPass.exactSpanRecall, 0) / cases.length,
  mergedExactSpanPrecision: cases.reduce((sum, entry) => sum + entry.merged.exactSpanPrecision, 0) / cases.length,
  mergedExactSpanRecall: cases.reduce((sum, entry) => sum + entry.merged.exactSpanRecall, 0) / cases.length,
  mergedFalseGroundingRate: cases.reduce((sum, entry) => sum + entry.merged.falseGroundingRate, 0) / cases.length,
};
aggregate.mergedRecallGainOverFirstPass = aggregate.mergedExactSpanRecall - aggregate.firstPassRecall;
const rateEquivalentSpendUsd =
  (totalInputTokens * config.rateEquivalent.inputUsdPerMillionTokens
    + totalOutputTokens * config.rateEquivalent.outputUsdPerMillionTokens) / 1_000_000;
const safetyPass =
  providerCalls <= config.limits.maxProviderCalls
  && rateEquivalentSpendUsd <= config.thresholds.maximumRateEquivalentSpendUsd
  && rateEquivalentSpendUsd <= config.thresholds.maximumAuthorizedSpendUsd;
const qualityPass =
  aggregate.mergedExactSpanPrecision >= config.thresholds.mergedExactSpanPrecision
  && aggregate.mergedFalseGroundingRate <= config.thresholds.mergedFalseGroundingRate
  && aggregate.mergedRecallGainOverFirstPass >= config.thresholds.minimumMergedRecallGainOverFirstPass;
const decision = safetyPass && qualityPass ? "promote" : "reject";

emit({
  schemaVersion: "1.0",
  kind: "grounded-extraction-live-multipass-result",
  configurationDigest,
  corpusRevision,
  provider: config.provider,
  model: config.model,
  providerCalls,
  totalInputTokens,
  totalOutputTokens,
  totalLatencyMs,
  incrementalBilledSpendUsd: 0,
  rateEquivalentSpendUsd,
  aggregate,
  cases,
  decision,
  safetyPass,
  qualityPass,
});
