#!/usr/bin/env node
/**
 * Deterministic, credential-free evaluation of two-pass extraction mechanics.
 * Synthetic complementary proposals cannot establish provider quality or
 * product value; they exercise only grounding, merge, identity, and budgets.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { extract, prepareContent } from "../../dist/src/index.js";

const corpusFile = new URL("./corpus.v1.json", import.meta.url);
const corpusBytes = fs.readFileSync(corpusFile);
const corpus = JSON.parse(corpusBytes);
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} requires a positive integer`);
  return Number(raw);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function stableValue(value) {
  return JSON.stringify(canonicalValue(value));
}

function digest(value) {
  return createHash("sha256").update(stableValue(value)).digest("hex");
}

function emit(record) {
  fs.writeSync(process.stdout.fd, `${JSON.stringify(record)}\n`);
}

const configuration = {
  version: "multipass-context-configuration-v2",
  maxLogicalAttemptsPerCase: option("--max-attempts", 2),
  maxProviderCallsPerCase: option("--max-provider-calls", 2),
  maxTokensPerCase: option("--max-tokens", 14),
  fixtureTokensPerProviderCall: 7,
  mergeAlgorithm: "ordered-exact-proposal-key-v1",
};
const productValueThresholds = {
  version: "multipass-context-product-thresholds-v2",
  mergedExactSpanPrecision: 1,
  mergedExactSpanRecall: 1,
  mergedFalseGroundingRate: 0,
  minimumMergedRecallGainOverFirstPass: 0.15,
};
const mechanicsCriteria = {
  version: "multipass-context-mechanics-criteria-v1",
  exactOnlyMerge: true,
  deterministicMergeDigests: true,
  boundedStopIssuing: true,
  auditableAttemptIdentity: true,
};
const thresholdConfigurationDigest = digest({ configuration, productValueThresholds, mechanicsCriteria });
const corpusRevision = createHash("sha256").update(corpusBytes).digest("hex");

// This is deliberately the first durable JSONL record, before runCase() or any
// provider call. Subsequent lifecycle records make the ordering testable.
emit({
  schemaVersion: "1.0",
  kind: "grounded-extraction-multipass-context-thresholds",
  configuration,
  productValueThresholds,
  mechanicsCriteria,
  thresholdConfigurationDigest,
  productValueEvidenceRequirement: "predeclared-real-provider-comparison",
});

function proposalKey(proposal) {
  return [
    proposal.fieldPath,
    stableValue(proposal.pathIndices ?? []),
    stableValue(proposal.candidateValue),
    proposal.provenance.locator,
  ].join("\0");
}

function proposalIdentity(proposal) {
  const mergeKey = proposalKey(proposal);
  return {
    mergeKeyDigest: digest(mergeKey),
    proposalDigest: digest({
      fieldPath: proposal.fieldPath,
      pathIndices: proposal.pathIndices ?? [],
      candidateValue: proposal.candidateValue,
      confidence: proposal.confidence,
      extractor: proposal.extractor,
      provenance: proposal.provenance,
    }),
  };
}

function nthIndex(text, excerpt, occurrence) {
  let start = 0;
  for (let index = 0; index < occurrence; index += 1) {
    start = text.indexOf(excerpt, start);
    if (start < 0) throw new Error(`gold excerpt not found at occurrence ${occurrence}: ${excerpt}`);
    if (index + 1 < occurrence) start += excerpt.length;
  }
  return start;
}

function expected(entry, preparedText) {
  return entry.gold.map((gold) => {
    const start = nthIndex(preparedText, gold.excerpt, gold.occurrence);
    return { ...gold, provenance: { excerpt: gold.excerpt, locator: `chars:${start}-${start + gold.excerpt.length}` } };
  });
}

function typeValid(value, schema) {
  if (!schema) return false;
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "array") return Array.isArray(value);
  if (schema.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (schema.type === "enum") return typeof value === "string" && (!schema.enumValues || schema.enumValues.includes(value));
  return typeof value === "string";
}

function exactlyGrounded(proposal, preparedText) {
  const match = /^chars:(\d+)-(\d+)$/.exec(proposal.provenance.locator);
  return Boolean(match && preparedText.slice(Number(match[1]), Number(match[2])) === proposal.provenance.excerpt);
}

function metrics(proposals, entry, preparedText) {
  const expectedProposals = expected(entry, preparedText);
  const actualKeys = new Set(proposals.map(proposalKey));
  const expectedKeys = new Set(expectedProposals.map(proposalKey));
  const matches = [...actualKeys].filter((key) => expectedKeys.has(key)).length;
  const schemaByPath = new Map(entry.schema.map((schema) => [schema.path, schema]));
  return {
    exactSpanPrecision: actualKeys.size === 0 ? 0 : matches / actualKeys.size,
    exactSpanRecall: expectedKeys.size === 0 ? 1 : matches / expectedKeys.size,
    typeValidity: proposals.length === 0 ? 1 : proposals.filter((proposal) => typeValid(proposal.candidateValue, schemaByPath.get(proposal.fieldPath))).length / proposals.length,
    falseGroundingRate: proposals.length === 0 ? 0 : proposals.filter((proposal) => !exactlyGrounded(proposal, preparedText)).length / proposals.length,
  };
}

function typedFailure(message, kind = "warning") {
  let code = "provider-or-runtime-warning";
  if (/unknown fieldPath/.test(message)) code = "unknown-field";
  else if (/excerpt not found/.test(message)) code = "ungrounded-excerpt";
  else if (/maxProviderCalls/.test(message)) code = "max-provider-calls";
  else if (/maxTotalTokens/.test(message)) code = "max-total-tokens";
  return { kind, code, message };
}

/**
 * Ordered exact-key union. It retains an already grounded proposal unchanged;
 * agreement, confidence, fuzzy similarity, and candidate context do not create
 * a proposal or locator.
 */
function mergeProposals(passResults) {
  const seen = new Set();
  const merged = [];
  for (const result of passResults) {
    for (const proposal of result.proposals) {
      const key = proposalKey(proposal);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(proposal);
      }
    }
  }
  return merged;
}

function fixtureProvider(proposals, pass, contextProposals, lifecycle) {
  return {
    name: "grounded-benchmark-hermetic-multipass",
    contextProposalCount: contextProposals.length,
    async extract() {
      lifecycle.providerCall += 1;
      emit({
        schemaVersion: "1.0",
        kind: "grounded-extraction-multipass-context-provider-call-started",
        caseId: lifecycle.caseId,
        attemptId: lifecycle.attemptId,
        logicalAttempt: lifecycle.logicalAttempt,
        physicalProviderCall: lifecycle.providerCall,
        thresholdConfigurationDigest,
      });
      return {
        proposals: proposals.map((proposal) => ({
          fieldPath: proposal.fieldPath,
          candidateValue: proposal.candidateValue,
          confidence: proposal.confidence,
          provenance: { excerpt: proposal.excerpt, locator: "provider-supplied-untrusted" },
          extractor: `grounded-benchmark-hermetic-${pass}`,
          ...(proposal.occurrenceHint === undefined ? {} : { occurrenceHint: proposal.occurrenceHint }),
        })),
        raw: { response: "fixture", model: "hermetic-multipass-context-v1", tokensUsed: configuration.fixtureTokensPerProviderCall },
      };
    },
  };
}

async function runCase(entry) {
  const preparedText = prepareContent(entry.content, entry.contentType, 5_000_000).text;
  if (typeof preparedText !== "string") throw new Error(`could not prepare fixture ${entry.id}`);
  const taskDigest = digest({ contentType: entry.contentType, schema: entry.schema, gold: entry.gold });
  const attempts = [];
  const results = [];
  let providerCalls = 0;
  let totalTokens = 0;
  const passes = [
    ["first-pass", entry.multipassContext.firstPassProposals],
    ["later-pass", entry.multipassContext.laterPassProposals],
  ];
  for (const [pass, proposals] of passes) {
    if (
      attempts.length >= configuration.maxLogicalAttemptsPerCase
      || providerCalls >= configuration.maxProviderCallsPerCase
      || totalTokens >= configuration.maxTokensPerCase
    ) break;
    const logicalAttempt = attempts.length + 1;
    const attemptId = `${entry.id}:attempt:${logicalAttempt}`;
    const limits = {
      maxProviderCalls: configuration.maxProviderCallsPerCase - providerCalls,
      maxTotalTokens: configuration.maxTokensPerCase - totalTokens,
    };
    const attemptConfiguration = {
      contentType: entry.contentType,
      pass,
      limits,
      contextProposalCount: results.flatMap((result) => result.proposals).length,
      provider: "grounded-benchmark-hermetic-multipass",
      model: "hermetic-multipass-context-v1",
    };
    const attemptConfigurationDigest = digest(attemptConfiguration);
    emit({
      schemaVersion: "1.0",
      kind: "grounded-extraction-multipass-context-attempt-started",
      caseId: entry.id,
      attemptId,
      logicalAttempt,
      pass,
      taskDigest,
      attemptConfiguration,
      attemptConfigurationDigest,
      thresholdConfigurationDigest,
    });
    const lifecycle = { caseId: entry.id, attemptId, logicalAttempt, providerCall: 0 };
    const contextProposals = results.flatMap((result) => result.proposals);
    const provider = fixtureProvider(proposals, pass, contextProposals, lifecycle);
    const sourceRef = `fixture://${corpus.fixtureRevision}/${entry.id}/${pass}`;
    const result = await extract({
      content: entry.content,
      contentType: entry.contentType,
      sourceRef,
      targetSchema: entry.schema,
      provider,
      maxProviderCalls: limits.maxProviderCalls,
      maxTotalTokens: limits.maxTotalTokens,
    });
    providerCalls += result.providerCalls;
    totalTokens += result.totalTokensUsed;
    results.push(result);
    const typedFailures = [
      ...(result.error ? [typedFailure(result.error, "error")] : []),
      ...(result.warnings ?? []).map((warning) => typedFailure(warning)),
    ];
    const proposalIdentities = result.proposals.map(proposalIdentity);
    const attempt = {
      attemptId,
      logicalAttempt,
      pass,
      runId: result.runId,
      sourceRef: result.sourceRef,
      taskDigest,
      provider: result.provider,
      model: result.raw.model,
      contextProposalCount: provider.contextProposalCount,
      configuration: attemptConfiguration,
      configurationDigest: attemptConfigurationDigest,
      providerCalls: result.providerCalls,
      tokens: result.totalTokensUsed,
      latencyMs: 0,
      typedFailures,
      proposalIdentities,
      proposalSetDigest: digest(proposalIdentities),
    };
    attempts.push(attempt);
    emit({
      schemaVersion: "1.0",
      kind: "grounded-extraction-multipass-context-attempt-completed",
      caseId: entry.id,
      thresholdConfigurationDigest,
      attempt,
    });
  }
  const first = results[0] ?? { proposals: [] };
  const later = results[1] ?? { proposals: [] };
  const merged = mergeProposals(results);
  const mergeIdentities = merged.map(proposalIdentity);
  const tokenOvershoot = Math.max(0, totalTokens - configuration.maxTokensPerCase);
  const record = {
    schemaVersion: "1.0",
    kind: "grounded-extraction-multipass-context-case",
    caseId: entry.id,
    fixtureRevision: corpus.fixtureRevision,
    corpusRevision,
    taskDigest,
    thresholdConfigurationDigest,
    attempts,
    budget: {
      maxLogicalAttempts: configuration.maxLogicalAttemptsPerCase,
      maxProviderCalls: configuration.maxProviderCallsPerCase,
      maxTokens: configuration.maxTokensPerCase,
      consumedLogicalAttempts: attempts.length,
      consumedProviderCalls: providerCalls,
      consumedTokens: totalTokens,
      tokenOvershoot,
      laterPassSkipped: attempts.length < passes.length,
    },
    metrics: {
      firstPass: metrics(first.proposals, entry, preparedText),
      laterPass: metrics(later.proposals, entry, preparedText),
      merged: metrics(merged, entry, preparedText),
    },
    merge: {
      algorithm: configuration.mergeAlgorithm,
      provenance: "retained-from-independently-grounded-pass-output",
      consensusOrFuzzyAgreement: "never-used-for-provenance",
      proposalIdentities: mergeIdentities,
      proposalSetDigest: digest(mergeIdentities),
    },
  };
  emit(record);
  return record;
}

const cases = corpus.cases.filter((entry) => entry.multipassContext);
const records = [];
for (const entry of cases) records.push(await runCase(entry));
const mean = (selector) => records.reduce((sum, record) => sum + selector(record), 0) / records.length;
const mergedPrecision = mean((record) => record.metrics.merged.exactSpanPrecision);
const mergedRecall = mean((record) => record.metrics.merged.exactSpanRecall);
const mergedFalseGrounding = mean((record) => record.metrics.merged.falseGroundingRate);
const recallGain = mergedRecall - mean((record) => record.metrics.firstPass.exactSpanRecall);
const mechanicsPasses = records.every((record) =>
  record.metrics.merged.falseGroundingRate === 0
  && record.merge.proposalIdentities.every((identity) => /^[a-f0-9]{64}$/.test(identity.mergeKeyDigest))
  && record.budget.consumedLogicalAttempts <= record.budget.maxLogicalAttempts
  && record.budget.consumedProviderCalls <= record.budget.maxProviderCalls
);

emit({
  schemaVersion: "1.0",
  kind: "grounded-extraction-multipass-context-summary",
  fixtureRevision: corpus.fixtureRevision,
  corpusRevision,
  thresholdConfigurationDigest,
  cases: records.length,
  observedSyntheticFixtureMetrics: {
    mergedExactSpanPrecision: mergedPrecision,
    mergedExactSpanRecall: mergedRecall,
    mergedFalseGroundingRate: mergedFalseGrounding,
    mergedRecallGainOverFirstPass: recallGain,
    logicalAttempts: records.reduce((sum, record) => sum + record.budget.consumedLogicalAttempts, 0),
    providerCalls: records.reduce((sum, record) => sum + record.budget.consumedProviderCalls, 0),
    tokens: records.reduce((sum, record) => sum + record.budget.consumedTokens, 0),
    tokenOvershoot: records.reduce((sum, record) => sum + record.budget.tokenOvershoot, 0),
  },
  mechanicsGate: mechanicsPasses ? "PASS" : "FAIL",
  productValueGate: "NOT_VERIFIED",
  decision: "REJECT",
  decisionScope: "no-product-or-runtime-promotion-from-synthetic-fixture-quality",
  evidenceScope: "hermetic-mechanics-fixture-only",
  liveProviderEvidence: "NOT_VERIFIED",
});
