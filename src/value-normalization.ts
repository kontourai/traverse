/**
 * Deterministic rewrites of a provider's candidate value into its field's
 * declared type, applied by `extract()` before occurrence resolution, dedup
 * and `evidenceMatch`. Only two rewrites exist, each lossless and each
 * recorded on the proposal as `valueNormalization` and in a warning:
 *
 *  - `string-to-number`: a `number` field answered with a plain decimal string
 *    (`"2.1"` -> `2.1`);
 *  - `date-to-iso`: a `date` field answered with a written English date
 *    (`"21 March 2013"`, `"March 21, 2013"` -> `"2013-03-21"`).
 *
 * Anything else is left exactly as the provider wrote it, so
 * `evidenceMatch.schema` reports `type-mismatch` or `format-invalid`.
 */

import type { ExtractionValueNormalization, TargetFieldSchema } from "./types.js";

/** No sign-only, exponent, grouping, leading zero or unit: `"1,234"`, `"007"`, `"2.1 kg"` and `"1e3"` are left alone. */
const PLAIN_DECIMAL = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAME = "([a-z]+)\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
/** The whole value must be one written date. Numeric forms (`03/04/2013`) are day/month ambiguous and are not read. */
const MONTH_FIRST = new RegExp(`^${MONTH_NAME}\\s+${DAY},?\\s+(\\d{4})$`, "i");
const DAY_FIRST = new RegExp(`^${DAY}\\s+${MONTH_NAME},?\\s+(\\d{4})$`, "i");

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (!(month >= 1 && month <= 12) || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function plainDecimalToNumber(text: string): number | undefined {
  const m = PLAIN_DECIMAL.exec(text.trim());
  if (!m) return undefined;
  const fraction = (m[3] ?? "").replace(/0+$/, "");
  const canonical = `${m[1]}${m[2]}${fraction ? `.${fraction}` : ""}`;
  const value = Number(canonical);
  // Round-trip: rejects anything a double cannot hold exactly as written
  // (`"12345678901234567890"`, `"0.1000000000000000055"`) and `"-0"`.
  return Number.isFinite(value) && String(value) === canonical ? value : undefined;
}

function writtenDateToIso(text: string): string | undefined {
  const value = text.normalize("NFKC").trim();
  let year: number, month: number | undefined, day: number;
  const monthFirst = MONTH_FIRST.exec(value);
  const dayFirst = monthFirst ? null : DAY_FIRST.exec(value);
  if (monthFirst) [month, day, year] = [MONTHS[monthFirst[1].toLowerCase()], Number(monthFirst[2]), Number(monthFirst[3])];
  else if (dayFirst) [day, month, year] = [Number(dayFirst[1]), MONTHS[dayFirst[2].toLowerCase()], Number(dayFirst[3])];
  else return undefined;
  if (month === undefined || !isCalendarDate(year, month, day)) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The value to carry for `field`, and the rewrite that produced it when one
 * applied. A pure function of its arguments, so a reader holding the recorded
 * `from` can recompute the value.
 */
export function normalizeCandidateValue(
  value: unknown,
  field: Pick<TargetFieldSchema, "type">,
): { value: unknown; normalization?: ExtractionValueNormalization } {
  if (typeof value !== "string") return { value };
  if (field.type === "number") {
    const number = plainDecimalToNumber(value);
    if (number !== undefined) return { value: number, normalization: { kind: "string-to-number", from: value } };
  }
  if (field.type === "date") {
    const iso = writtenDateToIso(value);
    if (iso !== undefined) return { value: iso, normalization: { kind: "date-to-iso", from: value } };
  }
  return { value };
}
