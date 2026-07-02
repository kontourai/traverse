/**
 * Top-level extraction orchestration.
 *
 * Pipeline: content-prep -> provider.extract() -> strict proposal
 * normalization -> ExtractionResult. It NEVER throws for provider/parse/prep
 * failure — every stage error surfaces as `ExtractionResult.error` with an
 * empty `proposals` array.
 *
 * Normalization discipline (proposals-only, ADR 0001 §4):
 *  - a proposal MUST carry provenance (a non-empty `excerpt`); those lacking it
 *    are dropped with a warning,
 *  - `confidence` is clamped into 0..1 (a non-finite confidence drops the item),
 *  - `fieldPath` MUST exist in the caller's `targetSchema`; unknown fields are
 *    dropped with a warning,
 *  - `extractor` MUST be a non-empty string.
 */

import { prepareContent } from "./content-prep.js";
import type {
  ExtractInput,
  ExtractionProposal,
  ExtractionResult,
  RawProviderResponse,
} from "./types.js";

const DEFAULT_MAX_CONTENT_CHARS = 32_000;

const EMPTY_RAW: RawProviderResponse = { response: "", model: "" };

export async function extract(input: ExtractInput): Promise<ExtractionResult> {
  const extractedAt = new Date().toISOString();
  const maxChars = input.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;

  try {
    const prepared = prepareContent(input.content, input.contentType, maxChars);
    if (prepared.error !== undefined || prepared.text === undefined) {
      return {
        proposals: [],
        raw: EMPTY_RAW,
        extractedAt,
        error: prepared.error ?? "content preparation produced no text",
      };
    }

    const output = await input.provider.extract({
      content: prepared.text,
      contentType: input.contentType,
      targetSchema: input.targetSchema,
      fieldHints: input.fieldHints,
    });

    const { proposals, warnings } = normalizeProposals(output.proposals, input);

    const result: ExtractionResult = {
      proposals,
      raw: output.raw ?? EMPTY_RAW,
      extractedAt,
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  } catch (err) {
    return {
      proposals: [],
      raw: EMPTY_RAW,
      extractedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeProposals(
  raw: unknown,
  input: ExtractInput,
): { proposals: ExtractionProposal[]; warnings: string[] } {
  const warnings: string[] = [];
  const proposals: ExtractionProposal[] = [];

  if (!Array.isArray(raw)) {
    warnings.push("provider returned no proposals array");
    return { proposals, warnings };
  }

  const knownFieldPaths = new Set(input.targetSchema.map((f) => f.path));

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      warnings.push("dropped a proposal that was not an object");
      continue;
    }
    const candidate = item as Partial<ExtractionProposal>;

    const fieldPath = typeof candidate.fieldPath === "string" ? candidate.fieldPath.trim() : "";
    if (!fieldPath) {
      warnings.push("dropped a proposal with a missing fieldPath");
      continue;
    }

    if (!knownFieldPaths.has(fieldPath)) {
      warnings.push(`dropped proposal for unknown fieldPath "${fieldPath}" (not in targetSchema)`);
      continue;
    }

    const extractor = typeof candidate.extractor === "string" ? candidate.extractor.trim() : "";
    if (!extractor) {
      warnings.push(`dropped proposal for "${fieldPath}": missing extractor identity`);
      continue;
    }

    const provenance = candidate.provenance;
    const excerpt =
      provenance && typeof provenance.excerpt === "string" ? provenance.excerpt.trim() : "";
    if (!excerpt) {
      warnings.push(`dropped proposal for "${fieldPath}": missing provenance excerpt`);
      continue;
    }
    const locator =
      provenance && typeof provenance.locator === "string" && provenance.locator.trim().length > 0
        ? provenance.locator.trim()
        : `${input.contentType}:field:${fieldPath}`;

    const rawConfidence = candidate.confidence;
    if (typeof rawConfidence !== "number" || !Number.isFinite(rawConfidence)) {
      warnings.push(`dropped proposal for "${fieldPath}": non-numeric confidence`);
      continue;
    }
    let confidence = rawConfidence;
    if (confidence < 0 || confidence > 1) {
      confidence = Math.max(0, Math.min(1, confidence));
      warnings.push(`clamped out-of-range confidence for "${fieldPath}" to ${confidence}`);
    }

    proposals.push({
      fieldPath,
      candidateValue: candidate.candidateValue,
      confidence,
      provenance: { excerpt, locator },
      extractor,
    });
  }

  return { proposals, warnings };
}
