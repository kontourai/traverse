/**
 * Top-level extraction orchestration.
 *
 * Pipeline: content-prep -> provider.extract() -> strict proposal
 * normalization -> ExtractionResult. It NEVER throws for provider/parse/prep
 * failure — every stage error surfaces as `ExtractionResult.error` with an
 * empty `proposals` array.
 *
 * Normalization discipline (proposals-only, ADR 0001 §4). A proposal survives
 * normalization only if ALL of the following hold — anything else is dropped
 * (or, for confidence, clamped) with a warning, never silently:
 *  - `fieldPath` MUST be a non-empty string present in the caller's
 *    `targetSchema`; missing or unknown fields are dropped with a warning.
 *    EXCEPTION: an indexed path against a declared array field (e.g.
 *    `"schedules[0].startDate"` when the schema declares
 *    `"schedules[].startDate"`) is ACCEPTED, not dropped — `[n]` segments are
 *    stripped to `[]` (consistently at every level, e.g.
 *    `"a[2].b[0].c"` -> `"a[].b[].c"`) and checked against `targetSchema`
 *    again; a match rewrites `fieldPath` to the declared form and records the
 *    stripped index/indices on `pathIndices` (silently — no warning; this is
 *    a supported input shape, not a defect). A fieldPath whose normalized
 *    form STILL doesn't match `targetSchema` is dropped with a warning, same
 *    as any other unknown fieldPath. See
 *    `docs/adr/0003-indexed-path-normalization.md` for why this is
 *    accept-and-normalize rather than reject,
 *  - `extractor` MUST be a non-empty string; a blank one drops the item,
 *  - the proposal MUST carry provenance with a non-empty `excerpt`; a missing
 *    excerpt drops the item,
 *  - that `excerpt` MUST OCCUR VERBATIM in the prepared content handed to the
 *    provider (checked via `String.prototype.indexOf` against the exact text
 *    `provider.extract()` was called with — never the caller's raw
 *    HTML/source). A miss drops the item with the warning "excerpt not found
 *    in prepared content"; this is what turns the provenance contract from a
 *    prompted convention into an ENFORCED one. A hit sets/overwrites
 *    `provenance.locator` to the defined `"chars:<start>-<end>"` scheme —
 *    0-based UTF-16 code-unit offsets of the matched excerpt within the
 *    prepared text — regardless of any locator a provider/adapter supplied
 *    (only `extract()` holds the prepared text needed to verify one, so it is
 *    the sole owner of the final `locator` value),
 *  - `confidence` MUST be a finite number; a non-finite (or missing)
 *    confidence drops the item. An in-range value passes through; an
 *    out-of-range value is CLAMPED into `0..1` (never dropped) with a warning.
 *
 * `warnings` on the final `ExtractionResult` merges BOTH of the above
 * normalization notes AND any `warnings` the provider itself returned (e.g.
 * the Anthropic adapter's malformed-tool-item / maxTokens-truncation notes) —
 * nothing either stage notices is silent.
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

    const providerWarnings = output.warnings ?? [];
    const { proposals, warnings: normalizationWarnings } = normalizeProposals(
      output.proposals,
      input,
      prepared.text,
    );
    const warnings = [...providerWarnings, ...normalizationWarnings];

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
  preparedContent: string,
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

    let effectiveFieldPath = fieldPath;
    let pathIndices: number[] | undefined;
    if (!knownFieldPaths.has(fieldPath)) {
      // Not a direct match — try normalizing indexed segments ("[0]" -> "[]",
      // consistently at every level) against a declared array path before
      // giving up. This recovers proposals like "schedules[0].startDate"
      // against a schema that only declares "schedules[].startDate" — see
      // docs/adr/0003-indexed-path-normalization.md.
      const { normalized, indices } = normalizeIndexedFieldPath(fieldPath);
      if (indices.length > 0 && knownFieldPaths.has(normalized)) {
        effectiveFieldPath = normalized;
        pathIndices = indices;
      } else {
        warnings.push(`dropped proposal for unknown fieldPath "${fieldPath}" (not in targetSchema)`);
        continue;
      }
    }

    const extractor = typeof candidate.extractor === "string" ? candidate.extractor.trim() : "";
    if (!extractor) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": missing extractor identity`);
      continue;
    }

    const provenance = candidate.provenance;
    const excerpt =
      provenance && typeof provenance.excerpt === "string" ? provenance.excerpt.trim() : "";
    if (!excerpt) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": missing provenance excerpt`);
      continue;
    }

    // Provenance contract enforcement: the excerpt must actually occur, verbatim,
    // in the SAME prepared text the provider was given — never merely asserted.
    // A miss is dropped (never accepted on trust); a hit derives the locator from
    // the verified offset, overwriting anything the provider/adapter supplied.
    const excerptIndex = preparedContent.indexOf(excerpt);
    if (excerptIndex === -1) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": excerpt not found in prepared content`);
      continue;
    }
    const locator = `chars:${excerptIndex}-${excerptIndex + excerpt.length}`;

    const rawConfidence = candidate.confidence;
    if (typeof rawConfidence !== "number" || !Number.isFinite(rawConfidence)) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": non-numeric confidence`);
      continue;
    }
    let confidence = rawConfidence;
    if (confidence < 0 || confidence > 1) {
      confidence = Math.max(0, Math.min(1, confidence));
      warnings.push(`clamped out-of-range confidence for "${effectiveFieldPath}" to ${confidence}`);
    }

    const proposal: ExtractionProposal = {
      fieldPath: effectiveFieldPath,
      candidateValue: candidate.candidateValue,
      confidence,
      provenance: { excerpt, locator },
      extractor,
    };
    if (pathIndices !== undefined) proposal.pathIndices = pathIndices;
    proposals.push(proposal);
  }

  return { proposals, warnings };
}

/**
 * Strips `[n]` (integer) segments from a caller/provider-supplied fieldPath
 * down to `[]`, consistently at every level — `"a[2].b[0].c"` normalizes to
 * `"a[].b[].c"` with `indices: [2, 0]` (left-to-right, outermost-first source
 * order). Used ONLY as a fallback when the raw fieldPath does not already
 * match a declared `targetSchema` path — see the EXCEPTION note in the
 * module docstring above and `docs/adr/0003-indexed-path-normalization.md`.
 *
 * `indices` is empty when `path` has no `[n]` segments, in which case
 * `normalized === path` and the caller should treat this as "nothing to
 * normalize" rather than a match.
 */
function normalizeIndexedFieldPath(path: string): { normalized: string; indices: number[] } {
  const indices: number[] = [];
  const normalized = path.replace(/\[(\d+)\]/g, (_match, digits: string) => {
    indices.push(Number(digits));
    return "[]";
  });
  return { normalized, indices };
}
