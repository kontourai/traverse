#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { extract, prepareContent } from "../../dist/src/index.js";

const root = path.resolve(import.meta.dirname, "../..");
const corpusFile = path.join(import.meta.dirname, "corpus.v1.json");
const corpusBytes = fs.readFileSync(corpusFile);
const corpus = JSON.parse(corpusBytes);
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
const corpusRevision = createHash("sha256").update(corpusBytes).digest("hex");
const args = process.argv.slice(2);
const moduleIndex = args.indexOf("--provider-module");
const modelIndex = args.indexOf("--model");
const liveModule = moduleIndex >= 0 ? args[moduleIndex + 1] : undefined;
const configuredModel = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
if ((moduleIndex >= 0 && !liveModule) || (modelIndex >= 0 && !configuredModel)) throw new Error("--provider-module and --model require values");
if ((liveModule && !configuredModel) || (!liveModule && configuredModel)) throw new Error("live mode requires both --provider-module and --model");

const mode = liveModule ? "live" : "hermetic";
let liveProvider;
if (liveModule) {
  const imported = await import(pathToFileURL(path.resolve(root, liveModule)).href);
  liveProvider = imported.default ?? imported.provider;
  if (!liveProvider || typeof liveProvider.extract !== "function") throw new Error("provider module must export default or provider with extract()");
}

function nthIndex(text, excerpt, occurrence) {
  let from = 0;
  let found = -1;
  for (let index = 0; index < occurrence; index += 1) {
    found = text.indexOf(excerpt, from);
    if (found < 0) throw new Error(`gold excerpt not found at occurrence ${occurrence}: ${excerpt}`);
    from = found + excerpt.length;
  }
  return found;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

function stableValue(value) {
  return JSON.stringify(canonicalValue(value));
}

function proposalKey(proposal) {
  return `${proposal.fieldPath}\0${stableValue(proposal.candidateValue)}\0${proposal.provenance.locator}`;
}

function valueKey(proposal) {
  return `${proposal.fieldPath}\0${stableValue(proposal.candidateValue)}`;
}

function failureCode(message) {
  if (/unknown fieldPath/.test(message)) return "unknown-field";
  if (/excerpt not found/.test(message)) return "ungrounded-excerpt";
  if (/duplicate proposal/.test(message)) return "duplicate-proposal";
  if (/chunked into/.test(message)) return "chunked-input";
  return "provider-or-runtime-warning";
}

function expectedProposals(entry, preparedText) {
  return entry.gold.map((gold) => {
    const start = nthIndex(preparedText, gold.excerpt, gold.occurrence);
    return { ...gold, provenance: { excerpt: gold.excerpt, locator: `chars:${start}-${start + gold.excerpt.length}` } };
  });
}

function fixedProvider(entry) {
  let calls = 0;
  return {
    name: "grounded-benchmark-hermetic",
    get calls() { return calls; },
    async extract(input) {
      calls += 1;
      const source = entry.scanTerms
        ? entry.scanTerms.filter((term) => input.content.includes(term)).map((term) => ({ fieldPath: entry.schema[0].path, candidateValue: term, confidence: 0.93, excerpt: term }))
        : entry.providerProposals ?? [];
      return {
        proposals: source.map((proposal) => ({
          fieldPath: proposal.fieldPath,
          candidateValue: proposal.candidateValue,
          confidence: proposal.confidence,
          provenance: { excerpt: proposal.excerpt, locator: "provider-supplied-untrusted" },
          extractor: "grounded-benchmark-hermetic",
        })),
        raw: { response: "fixture", model: "hermetic-v1", tokensUsed: 7 },
      };
    },
  };
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

function isExactlyGrounded(proposal, preparedText) {
  const match = /^chars:(\d+)-(\d+)$/.exec(proposal.provenance.locator);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return preparedText.slice(start, end) === proposal.provenance.excerpt;
}

const records = [];
for (const entry of corpus.cases) {
  const preparedText = entry.binaryText ?? prepareContent(entry.content, entry.contentType, 5_000_000).text;
  if (typeof preparedText !== "string") throw new Error(`could not prepare fixture ${entry.id}`);
  const provider = liveProvider ?? fixedProvider(entry);
  const input = {
    content: entry.binaryText ? new TextEncoder().encode(`fixture:${entry.id}`) : entry.content,
    contentType: entry.contentType,
    sourceRef: `fixture://${corpus.fixtureRevision}/${entry.id}`,
    targetSchema: entry.schema,
    provider,
    ...(entry.chunkSize ? { chunkSize: entry.chunkSize, chunkOverlap: entry.chunkOverlap } : {}),
    ...(entry.contentType === "pdf" ? { pdfTextExtractor: { extract: async () => ({ text: entry.binaryText, pageOffsets: [0, entry.binaryText.indexOf("\f") + 1] }) } } : {}),
    ...(["png", "jpeg"].includes(entry.contentType) ? { imageTextExtractor: { extract: async () => ({ text: entry.binaryText }) } } : {}),
  };
  const started = performance.now();
  const result = await extract(input);
  const measuredLatency = performance.now() - started;
  const expected = expectedProposals(entry, preparedText);
  const actualKeys = new Set(result.proposals.map(proposalKey));
  const expectedKeys = new Set(expected.map(proposalKey));
  const truePositives = [...actualKeys].filter((key) => expectedKeys.has(key)).length;
  const precision = actualKeys.size === 0 ? (expectedKeys.size === 0 ? 1 : 0) : truePositives / actualKeys.size;
  const recall = expectedKeys.size === 0 ? 1 : truePositives / expectedKeys.size;
  const actualValues = new Set(result.proposals.map(valueKey));
  const expectedValues = new Set(expected.map(valueKey));
  const valueMatches = [...expectedValues].filter((key) => actualValues.has(key)).length;
  const schemaByPath = new Map(entry.schema.map((schema) => [schema.path, schema]));
  const validTypes = result.proposals.filter((proposal) => typeValid(proposal.candidateValue, schemaByPath.get(proposal.fieldPath))).length;
  const coveredPaths = new Set(result.proposals.map((proposal) => proposal.fieldPath));
  const goldPaths = new Set(entry.gold.map((proposal) => proposal.fieldPath));
  const falseGrounding = result.proposals.filter((proposal) => !isExactlyGrounded(proposal, preparedText)).length;
  const taskDigest = createHash("sha256").update(JSON.stringify({ contentType: entry.contentType, schema: entry.schema, gold: entry.gold })).digest("hex");
  records.push({
    schemaVersion: "1.0",
    kind: "grounded-extraction-case",
    mode,
    caseId: entry.id,
    fixtureRevision: corpus.fixtureRevision,
    corpusRevision,
    implementationRevision: `@kontourai/traverse@${packageVersion}`,
    taskDigest,
    provider: liveProvider?.name ?? "grounded-benchmark-hermetic",
    model: result.raw.model || configuredModel || "unknown",
    configuration: { contentType: entry.contentType, prep: entry.prep ?? (entry.contentType === "html" ? "markdown" : "text"), chunkSize: entry.chunkSize ?? "default", chunkOverlap: entry.chunkOverlap ?? "default" },
    metrics: {
      exactSpanPrecision: precision,
      exactSpanRecall: recall,
      valueAccuracy: expectedValues.size === 0 ? 1 : valueMatches / expectedValues.size,
      typeValidity: result.proposals.length === 0 ? 1 : validTypes / result.proposals.length,
      groundedDropRate: (entry.providerProposals?.length ?? entry.scanTerms?.length ?? 0) === 0 ? 0 : Math.max(0, ((entry.providerProposals?.length ?? entry.scanTerms.length) - result.proposals.length) / (entry.providerProposals?.length ?? entry.scanTerms.length)),
      falseGroundingRate: result.proposals.length === 0 ? 0 : falseGrounding / result.proposals.length,
      schemaCoverage: goldPaths.size === 0 ? 1 : [...goldPaths].filter((field) => coveredPaths.has(field)).length / goldPaths.size,
      calls: result.providerCalls,
      tokens: result.totalTokensUsed,
      latencyMs: mode === "hermetic" ? 0 : Number(measuredLatency.toFixed(3)),
      typedFailures: [...(result.error ? [{ kind: "error", code: "extraction-error", message: result.error }] : []), ...(result.warnings ?? []).map((message) => ({ kind: "warning", code: failureCode(message), message }))],
    },
    expectedLimitation: entry.expectedLimitation ?? null,
  });
}

const aggregate = {
  schemaVersion: "1.0",
  kind: "grounded-extraction-summary",
  mode,
  fixtureRevision: corpus.fixtureRevision,
  corpusRevision,
  implementationRevision: `@kontourai/traverse@${packageVersion}`,
  cases: records.length,
  metrics: {
    exactSpanPrecision: records.reduce((sum, record) => sum + record.metrics.exactSpanPrecision, 0) / records.length,
    exactSpanRecall: records.reduce((sum, record) => sum + record.metrics.exactSpanRecall, 0) / records.length,
    calls: records.reduce((sum, record) => sum + record.metrics.calls, 0),
    tokens: records.reduce((sum, record) => sum + record.metrics.tokens, 0),
    latencyMs: records.reduce((sum, record) => sum + record.metrics.latencyMs, 0),
    typedFailures: records.reduce((sum, record) => sum + record.metrics.typedFailures.length, 0),
  },
};

for (const record of [...records, aggregate]) process.stdout.write(`${JSON.stringify(record)}\n`);
