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
export const EVIDENCE_MATCH_CHECKER_VERSION = "evidence-match-v3";

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
  // An enum that declares no values has nothing to be outside of; it is
  // checked as a string.
  if (field.type === "enum" && !field.enumValues?.length) return typeof value === "string" ? "ok" : "type-mismatch";
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
// per-type normalization. "match" means the value was found in the excerpt,
// not that the excerpt supports it. Anything uncertain (a form the normalizer
// cannot read, a difference only in punctuation or sign, a negation before the
// value) is "not-evaluated": never "match", and never "mismatch".

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

/** NFKC, lower case, a Unicode minus as `-`, `n't` as the word `not`, and `No.` before a digit as `number`. */
function prepare(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\u2212/g, "-")
    .replace(/n['\u2019]t(?![\p{L}\p{N}])/gu, " not")
    // "No. 5" / "No 5" abbreviates "number"; it is not the word no.
    .replace(/(?<![\p{L}\p{N}])no\.?\s*(?=\d)/gu, " number ");
}

/** Case-, whitespace- and punctuation-folded word tokens. */
function wordTokens(text: string): string[] {
  return prepare(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/**
 * Words joined by single spaces, keeping the punctuation that can change
 * meaning: `+ - # %` attached to a word or digit, and `. ,` between two of
 * them (`1.5`, `1,5`). Other punctuation and whitespace fold to a space, so
 * `"Status: Open."` reads `status open`.
 */
function meaningfulText(text: string): string {
  const t = prepare(text);
  const alnum = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{M}\p{N}]/u.test(ch);
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (alnum(ch)) out += ch;
    else if ("+-#%".includes(ch) && (alnum(t[i - 1]) || alnum(t[i + 1]) || "+-#%".includes(t[i - 1] ?? "") || "+-#%".includes(t[i + 1] ?? ""))) out += ch;
    else if (".,".includes(ch) && alnum(t[i - 1]) && alnum(t[i + 1])) out += ch;
    else out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Whether `needle` occurs in `haystack` bounded by the ends or a space on each side. */
function containsBounded(haystack: string, needle: string): boolean {
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    const before = i === 0 || haystack[i - 1] === " ";
    const after = i + needle.length === haystack.length || haystack[i + needle.length] === " ";
    if (before && after) return true;
  }
  return false;
}

/** Start indices of `needle` as a contiguous run of `haystack`. */
function occurrences(haystack: string[], needle: string[]): number[] {
  const found: number[] = [];
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    found.push(i);
  }
  return found;
}

const NEGATION_CUES = new Set(["not", "no", "never", "without", "cannot", "nor"]);
/** How many tokens before a value are searched for a negation cue. */
const NEGATION_WINDOW = 3;

function negatedAt(tokens: string[], index: number): boolean {
  for (let k = Math.max(0, index - NEGATION_WINDOW); k < index; k++) if (NEGATION_CUES.has(tokens[k])) return true;
  return false;
}

/**
 * A phone-style value compares by its digit groups alone (`"303.555.1234"`
 * matches `"(303) 555-1234"`): only digits and the separators `( ) . - /` and
 * spaces, at least seven digits in at least three groups, and no leading
 * sign. Two groups could be a decimal (`1234567.89`) and one group a plain
 * number, where a separator or sign changes the value.
 */
function isDigitGroupIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[\d\s().\-/]+$/.test(trimmed) || trimmed.startsWith("-")) return false;
  const groups = trimmed.match(/\d+/g) ?? [];
  return groups.length >= 3 && groups.join("").length >= 7;
}

/** `"open"` matches `"Status: Open"`; `"A+"` against `"Grade: A-"` is not-evaluated. */
function textInExcerpt(value: string, excerpt: string): ExtractionValueInExcerpt {
  const words = wordTokens(value);
  if (words.length === 0) return "not-evaluated";
  const excerptWords = wordTokens(excerpt);
  const wordHits = occurrences(excerptWords, words);
  if (wordHits.length === 0) return "mismatch";
  if (wordHits.some((index) => negatedAt(excerptWords, index))) return "not-evaluated";
  if (containsBounded(meaningfulText(excerpt), meaningfulText(value)) || isDigitGroupIdentifier(value)) return "match";
  // The words are there but punctuation or sign differs (`-5` vs `5`, `C++` vs `C#`).
  return "not-evaluated";
}

/**
 * A decimal number, optionally signed and led by a currency symbol, with
 * comma thousands separators and a point decimal. It may not touch a letter
 * or digit on either side, so `3` is not read out of `2023`.
 */
const NUMBER_IN_TEXT = /(?<![\p{L}\p{N}.,])(-)?(?:[$€£¥₹]\s?)?(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\p{L}\p{N}]|[.,]\d)/gu;
/**
 * Dates, times and fractions written with digits, masked before numbers are
 * read (`6` is not read out of `2026-06-09`, nor `1` or `2` out of `1/2`).
 */
const DIGIT_DATE_OR_TIME = /\d+(?:[-/]\d+)+|\d+(?::\d+)+/g;
/** A scale word after a number (`$4.2 million`). */
const SCALE_AFTER = /^\s*(?:thousand|million|billion|trillion|bn|mn)(?![\p{L}\p{N}])/iu;

function numberInExcerpt(value: number, excerpt: string): ExtractionValueInExcerpt {
  let text = excerpt.normalize("NFKC").replace(/−/g, "-");
  let uncertain = false;
  text = text.replace(DIGIT_DATE_OR_TIME, (run) => { uncertain = true; return " ".repeat(run.length); });
  const clean: number[] = [];
  for (const m of text.matchAll(NUMBER_IN_TEXT)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const after = text.slice(end);
    // Readable but written at another scale or sign convention: `45%`,
    // accounting `(5)`, `$4.2 million`. Neither a match nor a mismatch.
    if (after.startsWith("%") || (text[start - 1] === "(" && after.startsWith(")")) || SCALE_AFTER.test(after)) {
      uncertain = true;
      continue;
    }
    // A negation cue in the three words before the number (`not 5`).
    // Tokenized through the number so "No. 5" reads as "number 5".
    const upTo = wordTokens(text.slice(0, end));
    const own = wordTokens(m[0]).length;
    if (negatedAt(upTo, upTo.length - own)) {
      uncertain = true;
      continue;
    }
    const negative = m[1] !== undefined || m[2] !== undefined;
    const magnitude = Number(`${m[3].replace(/,/g, "")}${m[4] === undefined ? "" : `.${m[4]}`}`);
    clean.push(negative ? -magnitude : magnitude);
  }
  if (clean.includes(value)) return "match";
  // No plainly written number (e.g. "forty-five"), or only uncertain ones.
  if (uncertain || clean.length === 0) return "not-evaluated";
  return "mismatch";
}

const TRUE_WORDS = new Set(["yes", "true"]);
const FALSE_WORDS = new Set(["no", "false"]);

/**
 * `match` only when the excerpt has the value's word, un-negated, and no word
 * of the other polarity; `mismatch` only when it has the other polarity's word,
 * un-negated, and none of the value's. Anything else (`"Yes, no refunds"`,
 * `"This is not true"`) is not-evaluated.
 */
function booleanInExcerpt(value: boolean, excerpt: string): ExtractionValueInExcerpt {
  const tokens = wordTokens(excerpt);
  const same = value ? TRUE_WORDS : FALSE_WORDS;
  const opposite = value ? FALSE_WORDS : TRUE_WORDS;
  const sameAt = tokens.flatMap((token, index) => (same.has(token) ? [index] : []));
  const oppositeAt = tokens.flatMap((token, index) => (opposite.has(token) ? [index] : []));
  const negated = (indices: number[]) => indices.some((index) => negatedAt(tokens, index));
  if (sameAt.length > 0 && oppositeAt.length === 0 && !negated(sameAt)) return "match";
  if (oppositeAt.length > 0 && sameAt.length === 0 && !negated(oppositeAt)) return "mismatch";
  return "not-evaluated";
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
