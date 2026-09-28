/**
 * Deterministic evidence annotations for one proposal: a schema check and a
 * value-in-excerpt check. Both are facts computed from the proposal's own
 * text; neither decides whether a value is correct, and nothing here drops a
 * proposal. Rules and the recommended consumer policy are in
 * docs/decisions/extraction-proposals.md ("Evidence annotations").
 */

import { valueMatches } from "./task.js";
import type {
  ExtractionEvidenceMatch,
  ExtractionSchemaMatch,
  ExtractionValueInExcerpt,
  TargetFieldSchema,
} from "./types.js";

/** Changes whenever a rule below changes what it reports for some input. */
export const EVIDENCE_MATCH_CHECKER_VERSION = "evidence-match-v1";

/**
 * Annotate a proposal. `start`/`end` are the excerpt's UTF-16 offsets in
 * `preparedText` (its `chars:` locator).
 */
export function evidenceMatchFor(
  value: unknown,
  field: TargetFieldSchema,
  excerpt: string,
  preparedText: string,
  start: number,
  end: number,
): ExtractionEvidenceMatch {
  return {
    checkerVersion: EVIDENCE_MATCH_CHECKER_VERSION,
    schema: schemaMatch(value, field),
    valueInExcerpt: valueInExcerpt(value, field, excerpt),
    tokenBoundary: onTokenBoundary(preparedText, start, end),
  };
}

// ---------------------------------------------------------------------------
// Schema check: exact, no heuristics.

export function schemaMatch(value: unknown, field: TargetFieldSchema): ExtractionSchemaMatch {
  if (valueMatches(value, field)) {
    return field.type === "date" && !isIsoDate(value as string) ? "format-invalid" : "ok";
  }
  return field.type === "enum" && typeof value === "string" ? "enum-mismatch" : "type-mismatch";
}

const ISO_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))?)?)?)?$/;

/**
 * An ISO-8601 calendar date in extended format at year, month or day
 * precision, optionally with a time of day and a `Z` or `±hh:mm` offset. Each
 * component is range-checked, so `2026-02-30` is not a date.
 */
function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [, , month, day, hour, minute, second, , offsetHour, offsetMinute] = m;
  if (month !== undefined && !isCalendarDate(Number(m[1]), Number(month), day === undefined ? 1 : Number(day))) return false;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return false;
  if (second !== undefined && Number(second) > 59) return false;
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return true;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

// ---------------------------------------------------------------------------
// Value-in-excerpt check: containment on token boundaries after a fixed,
// per-type normalization. A value or excerpt the normalizer cannot read is
// "not-evaluated", never "mismatch".

export function valueInExcerpt(value: unknown, field: TargetFieldSchema, excerpt: string): ExtractionValueInExcerpt {
  // Only an explicit value is meant to appear in the source; an inferred or
  // unclassified one may legitimately differ from its excerpt.
  if (field.inferenceType !== "explicit") return "not-applicable";
  switch (field.type) {
    case "array": case "object": return "not-applicable";
    case "string": case "enum": return typeof value === "string" ? textInExcerpt(value, excerpt) : "not-evaluated";
    case "number": return typeof value === "number" && Number.isFinite(value) ? numberInExcerpt(value, excerpt) : "not-evaluated";
    case "boolean": return typeof value === "boolean" ? booleanInExcerpt(value, excerpt) : "not-evaluated";
    case "date": return typeof value === "string" ? dateInExcerpt(value, excerpt) : "not-evaluated";
  }
}

/** Case-, whitespace- and punctuation-folded word tokens. */
function wordTokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** `"303.555.1234"` matches `"(303) 555-1234"`; `"open"` matches `"Status: Open"`. */
function textInExcerpt(value: string, excerpt: string): ExtractionValueInExcerpt {
  const needle = wordTokens(value);
  if (needle.length === 0) return "not-evaluated";
  return containsSequence(wordTokens(excerpt), needle) ? "match" : "mismatch";
}

/**
 * A decimal number, optionally signed and led by a currency symbol, with
 * comma thousands separators and a point decimal. It may not touch a letter
 * or digit on either side, so `3` is not read out of `2023`.
 */
const NUMBER_IN_TEXT = /(?<![\p{L}\p{N}.,])([-−])?(?:[$€£¥₹]\s?)?([-−])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\p{L}\p{N}]|[.,]\d)/gu;

function numberInExcerpt(value: number, excerpt: string): ExtractionValueInExcerpt {
  const found: number[] = [];
  for (const m of excerpt.normalize("NFKC").matchAll(NUMBER_IN_TEXT)) {
    const negative = m[1] !== undefined || m[2] !== undefined;
    const magnitude = Number(`${m[3].replace(/,/g, "")}${m[4] === undefined ? "" : `.${m[4]}`}`);
    found.push(negative ? -magnitude : magnitude);
  }
  // No written number (e.g. "forty-five"): nothing this normalizer can compare.
  if (found.length === 0) return "not-evaluated";
  return found.includes(value) ? "match" : "mismatch";
}

const TRUE_WORDS = new Set(["yes", "true"]);
const FALSE_WORDS = new Set(["no", "false"]);

function booleanInExcerpt(value: boolean, excerpt: string): ExtractionValueInExcerpt {
  const tokens = wordTokens(excerpt);
  const same = value ? TRUE_WORDS : FALSE_WORDS;
  const opposite = value ? FALSE_WORDS : TRUE_WORDS;
  if (tokens.some((token) => same.has(token))) return "match";
  return tokens.some((token) => opposite.has(token)) ? "mismatch" : "not-evaluated";
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAME = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
/**
 * The fixed set of written dates read from an excerpt: `2026-06-09`,
 * `June 9, 2026` (full or abbreviated English month, optional ordinal and
 * comma), and `9 June 2026`. Numeric forms such as `06/09/2026` are ambiguous
 * between day-first and month-first and are not read.
 */
const DATE_PATTERNS: Array<{ pattern: RegExp; parts: (m: RegExpMatchArray) => [number, number, number] }> = [
  { pattern: /(?<![\p{L}\p{N}])(\d{4})-(\d{2})-(\d{2})(?![\p{L}\p{N}])/gu, parts: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  { pattern: new RegExp(`(?<![\\p{L}\\p{N}])${MONTH_NAME}\\s+${DAY},?\\s+(\\d{4})(?![\\p{L}\\p{N}])`, "giu"), parts: (m) => [Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2])] },
  { pattern: new RegExp(`(?<![\\p{L}\\p{N}])${DAY}\\s+${MONTH_NAME},?\\s+(\\d{4})(?![\\p{L}\\p{N}])`, "giu"), parts: (m) => [Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])] },
];

function dateInExcerpt(value: string, excerpt: string): ExtractionValueInExcerpt {
  const own = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!own || !isCalendarDate(Number(own[1]), Number(own[2]), Number(own[3]))) return "not-evaluated";
  const target = `${own[1]}-${own[2]}-${own[3]}`;
  const found: string[] = [];
  const text = excerpt.normalize("NFKC");
  for (const { pattern, parts } of DATE_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const [year, month, day] = parts(m);
      if (isCalendarDate(year, month, day)) found.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
  if (found.length === 0) return "not-evaluated";
  return found.includes(target) ? "match" : "mismatch";
}

// ---------------------------------------------------------------------------
// Token boundary.

const WORD_CHAR = /^[\p{L}\p{M}\p{N}_]$/u;

function isWord(codePoint: number | undefined): boolean {
  return codePoint !== undefined && WORD_CHAR.test(String.fromCodePoint(codePoint));
}

function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2);
  }
  return low;
}

/** True when neither end of `[start, end)` splits a word of `text`. */
function onTokenBoundary(text: string, start: number, end: number): boolean {
  const splitsAt = (index: number) =>
    isWord(codePointBefore(text, index)) && isWord(index < text.length ? text.codePointAt(index) : undefined);
  return !splitsAt(start) && !splitsAt(end);
}
