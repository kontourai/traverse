/**
 * Embedded-state harvesting + JS-shell detection for the HTML prep layer.
 *
 * Two prep-layer capabilities for JS-heavy sources, both fetch-agnostic:
 *
 * 1. EMBEDDED STATE (structured sidecar). Many pages ship machine-readable state
 *    the visible DOM does not: `<script type="application/ld+json">` (schema.org
 *    Event/Course/Product), Next.js `<script id="__NEXT_DATA__">`, and generic
 *    hydration blobs (`window.__INITIAL_STATE__` / `__PRELOADED_STATE__`). Prep
 *    STRIPS every `<script>` before it builds the prepared text, so this state is
 *    otherwise lost. {@link harvestEmbeddedState} recovers it as a parsed,
 *    size-capped {@link EmbeddedState} sidecar on the prep/extract result.
 *
 *    Why a SIDECAR and not provenance-bearing proposals: Traverse's provenance
 *    invariant (docs/adr/0001, 0004) requires every proposal's `excerpt` to occur
 *    verbatim in the FULL prepared text, with `locator = "chars:<start>-<end>"`
 *    anchored to it. Embedded state comes from stripped script blocks that are NOT
 *    in the prepared text, so a proposal built from it could not pass that check
 *    without either polluting the prepared text or forking the locator scheme into
 *    raw-HTML offsets. The sidecar keeps the invariant intact and leaves domain
 *    mapping (JSON-LD -> caller fields) to the caller, who owns all field
 *    vocabulary. See docs/adr/0005-embedded-state-sidecar.md.
 *
 * 2. JS-SHELL DETECTION (machine-actionable warning). {@link detectJsShell}
 *    flags pages whose prepared text is suspiciously small relative to the raw
 *    HTML AND that look script-dominated or have an empty client-render mount
 *    (`<div id="root"></div>` / `#__next` / `#app`). The warning carries a STABLE
 *    code plus the ratio numbers so a downstream pipeline can auto-retry with a
 *    browser render. False-positive discipline: a content-rich page never trips
 *    the heuristic because the ABSOLUTE prepared-text floor gates it even when the
 *    script ratio is high (a real 2.7MB listing prepares to ~23k chars, a 0.85%
 *    ratio, yet is content-rich — it must NOT be flagged).
 *
 * Interplay: harvesting runs BEFORE shell classification. A shell page carrying
 * rich embedded state is extractable WITHOUT a render, so the warning is
 * downgraded to a distinct annotated code in that case.
 *
 * Neither function throws: parse/DOM failures degrade to a warning.
 */

import { parseHTML } from "linkedom";
import type { EmbeddedState } from "./types.js";

// --- Size caps (bound memory on pathological inputs; over-cap => warn + skip) ---

/** Max number of JSON-LD script blocks harvested from one page. */
export const MAX_JSONLD_BLOCKS = 25;
/** Max raw characters of a single script block we will attempt to parse. */
export const MAX_RAW_BLOCK_CHARS = 256_000;
/** Cumulative serialized-size budget across all kept JSON-LD blocks. */
export const MAX_JSONLD_TOTAL_CHARS = 256_000;
/** Serialized-size cap for the `__NEXT_DATA__` payload. */
export const MAX_NEXTDATA_CHARS = 512_000;
/** Serialized-size cap for the `__INITIAL_STATE__` / `__PRELOADED_STATE__` payload. */
export const MAX_INITIAL_STATE_CHARS = 512_000;

// --- Shell-detection thresholds (tuned against realistic fixtures) ---

/**
 * Absolute prepared-text floor (chars). The PRIMARY false-positive guard: a page
 * with at least this much prepared text is never a shell, no matter how many
 * scripts it carries. A genuine pre-render shell has near-zero prepared text.
 */
export const SHELL_PREPARED_TEXT_FLOOR = 600;
/** Prepared text must be below this fraction of the raw HTML to look shell-like. */
export const SHELL_TEXT_RATIO_MAX = 0.08;
/** `<script>` bytes at/above this fraction of the raw HTML count as script-dominated. */
export const SHELL_SCRIPT_RATIO_MIN = 0.45;

/** Stable code: page looks like a JS shell and has no usable embedded state. */
export const SHELL_WARNING_CODE = "js-shell-suspected";
/**
 * Stable code: page looks like a JS shell BUT rich embedded state was harvested,
 * so it is extractable without a browser render (downgraded — do not auto-render).
 */
export const SHELL_WARNING_CODE_EMBEDDED = "js-shell-suspected-embedded-state-available";

/** True only for the canonical pure-shell warning, never its embedded-state variant. */
export function isPureJsShellWarning(warning: string): boolean {
  return warning.startsWith(`${SHELL_WARNING_CODE}:`);
}

/** Client-render mount element ids whose emptiness is a shell signal. */
const MOUNT_IDS = ["root", "__next", "app"];

// --- Internals ---

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Serialized size in chars; Infinity if the value cannot be stringified. */
function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

interface AttrEl {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

/**
 * Extract one balanced JSON object/array from `source` starting at `fromIndex`
 * (skipping leading whitespace). String-aware so a `{`/`}` inside a JSON string
 * does not throw off the depth count. Returns undefined if no `{`/`[` opens.
 */
function extractBalancedJson(source: string, fromIndex: number): string | undefined {
  let i = fromIndex;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  const open = source[i];
  if (open !== "{" && open !== "[") return undefined;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < source.length; j++) {
    const ch = source[j]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  return undefined;
}

/**
 * Parse one raw JSON blob under a raw-length cap and a serialized-size cap.
 * NEVER throws: an oversized-raw, malformed, or oversized-serialized blob is
 * dropped with a warning and `{ value: undefined }` is returned. Shared by every
 * embedded-state kind so the cap/parse scaffolding stays single-source.
 */
function parseCapped(
  raw: string,
  opts: { failCode: string; capLabel: string; maxSerializedChars: number; warnings: string[] },
): { value?: unknown } {
  if (raw.length > MAX_RAW_BLOCK_CHARS) {
    opts.warnings.push(
      `embedded-state-size-capped: skipped an oversized ${opts.capLabel} (${raw.length} chars > ${MAX_RAW_BLOCK_CHARS})`,
    );
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    opts.warnings.push(`${opts.failCode}: ${msg(err)}`);
    return {};
  }
  if (serializedSize(value) > opts.maxSerializedChars) {
    opts.warnings.push(`embedded-state-size-capped: ${opts.capLabel} exceeded ${opts.maxSerializedChars} chars`);
    return {};
  }
  return { value };
}

/**
 * Harvest every `<script type="application/ld+json">` block, in document order,
 * under a per-block raw cap, a block-count cap, and a cumulative serialized cap.
 */
function harvestJsonLd(scripts: AttrEl[], warnings: string[]): unknown[] {
  const jsonLd: unknown[] = [];
  let totalChars = 0;
  for (const el of scripts) {
    if ((el.getAttribute("type") ?? "").trim().toLowerCase() !== "application/ld+json") continue;
    const raw = (el.textContent ?? "").trim();
    if (!raw) continue;
    if (jsonLd.length >= MAX_JSONLD_BLOCKS) {
      warnings.push(`embedded-state-size-capped: dropped JSON-LD blocks beyond ${MAX_JSONLD_BLOCKS}`);
      break;
    }
    const { value } = parseCapped(raw, {
      failCode: "embedded-jsonld-parse-failed",
      capLabel: "JSON-LD block",
      maxSerializedChars: MAX_JSONLD_TOTAL_CHARS,
      warnings,
    });
    if (value === undefined) continue;
    const size = serializedSize(value);
    if (totalChars + size > MAX_JSONLD_TOTAL_CHARS) {
      // `continue`, not `break`: best-effort inclusion — a later, smaller block may
      // still fit under the cumulative budget even though this one does not.
      warnings.push(`embedded-state-size-capped: JSON-LD total exceeded ${MAX_JSONLD_TOTAL_CHARS} chars`);
      continue;
    }
    totalChars += size;
    jsonLd.push(value);
  }
  return jsonLd;
}

/** Harvest the Next.js `<script id="__NEXT_DATA__">` payload, if any. */
function harvestNextData(scripts: AttrEl[], warnings: string[]): unknown | undefined {
  for (const el of scripts) {
    if ((el.getAttribute("id") ?? "").trim() !== "__NEXT_DATA__") continue;
    const raw = (el.textContent ?? "").trim();
    if (!raw) continue;
    // There is only one __NEXT_DATA__ per page; a malformed/oversized one is
    // already warned by parseCapped — don't keep scanning for another.
    return parseCapped(raw, {
      failCode: "embedded-nextdata-parse-failed",
      capLabel: "__NEXT_DATA__ block",
      maxSerializedChars: MAX_NEXTDATA_CHARS,
      warnings,
    }).value;
  }
  return undefined;
}

/**
 * Harvest a generic hydration blob (`window.__INITIAL_STATE__` /
 * `__PRELOADED_STATE__`) from any inline script. First usable match wins.
 */
function harvestInitialState(scriptTexts: string[], warnings: string[]): unknown | undefined {
  const assignRe = /(?:window\s*\.\s*)?__(?:INITIAL_STATE|PRELOADED_STATE)__\s*=\s*/;
  for (const text of scriptTexts) {
    const m = assignRe.exec(text);
    if (!m) continue;
    const jsonText = extractBalancedJson(text, m.index + m[0].length);
    if (!jsonText) continue;
    const { value } = parseCapped(jsonText, {
      failCode: "embedded-initialstate-parse-failed",
      capLabel: "hydration blob",
      maxSerializedChars: MAX_INITIAL_STATE_CHARS,
      warnings,
    });
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Harvest embedded machine-readable state from raw HTML. NEVER throws — parse or
 * DOM failures degrade to a `warnings` note. Returns `{ embedded }` only when at
 * least one of JSON-LD / `__NEXT_DATA__` / hydration state was recovered.
 */
export function harvestEmbeddedState(html: string): { embedded?: EmbeddedState; warnings: string[] } {
  const warnings: string[] = [];
  let scripts: AttrEl[];
  try {
    const { document } = parseHTML(html);
    scripts = [...document.querySelectorAll("script")] as unknown as AttrEl[];
  } catch (err) {
    warnings.push(`embedded-state-parse-failed: ${msg(err)}`);
    return { warnings };
  }

  const jsonLd = harvestJsonLd(scripts, warnings);
  const nextData = harvestNextData(scripts, warnings);
  const inlineScriptTexts = scripts
    .filter((el) => el.getAttribute("src") === null)
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => t.length > 0);
  const initialState = harvestInitialState(inlineScriptTexts, warnings);

  if (jsonLd.length === 0 && nextData === undefined && initialState === undefined) {
    return { warnings };
  }
  const embedded: EmbeddedState = { jsonLd };
  if (nextData !== undefined) embedded.nextData = nextData;
  if (initialState !== undefined) embedded.initialState = initialState;
  return { embedded, warnings };
}

const SCRIPT_OPEN = "<script";
const SCRIPT_CLOSE = "</script>";

/**
 * Total characters occupied by `<script>...</script>` blocks in the raw HTML.
 *
 * Deliberately a LINEAR `indexOf` scan, not a `/<script\b[^>]*>[\s\S]*?<\/script>/`
 * regex: that lazy dot-all scan backtracks quadratically when the document has
 * many `<script` occurrences with no matching `</script>` (adversarial or merely
 * script-heavy pages), which is a DoS vector because this runs on the raw,
 * untruncated HTML of every HTML page through `prepareContent`/`extract`. Every
 * `indexOf` here advances a monotonically increasing cursor, so the whole scan is
 * O(n) regardless of how pathological the input is.
 */
function totalScriptChars(html: string): number {
  const lower = html.toLowerCase();
  let total = 0;
  let i = 0;
  while (i < lower.length) {
    const open = lower.indexOf(SCRIPT_OPEN, i);
    if (open === -1) break;
    // Guard against `<scriptfoo>` / `<script2>` / `<script_x>`: the char after
    // "<script" must end the tag name (a `\b` word boundary — not a letter,
    // digit, or underscore).
    const after = lower[open + SCRIPT_OPEN.length];
    if (
      after !== undefined &&
      ((after >= "a" && after <= "z") || (after >= "0" && after <= "9") || after === "_")
    ) {
      i = open + SCRIPT_OPEN.length;
      continue;
    }
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd === -1) {
      // Unterminated opening tag: count the rest and stop.
      total += html.length - open;
      break;
    }
    const close = lower.indexOf(SCRIPT_CLOSE, tagEnd);
    if (close === -1) {
      // No closing tag: count from here to the end and stop (an SPA shell shape).
      total += html.length - open;
      break;
    }
    const end = close + SCRIPT_CLOSE.length;
    total += end - open;
    i = end;
  }
  return total;
}

/** True when a known client-render mount element is present but empty. */
function hasEmptyRootMount(html: string): boolean {
  const ids = MOUNT_IDS.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`<div\\b[^>]*\\bid=["'](?:${ids})["'][^>]*>\\s*</div>`, "i");
  return re.test(html);
}

/** Signals behind a shell verdict — exposed for callers/tests to reason about. */
export interface ShellSignals {
  rawHtmlChars: number;
  preparedTextChars: number;
  /** preparedTextChars / rawHtmlChars (1 when the HTML is empty). */
  textRatio: number;
  /** script bytes / rawHtmlChars. */
  scriptRatio: number;
  emptyRootMount: boolean;
  suspected: boolean;
}

/**
 * Classify whether prepared HTML looks like an un-rendered JS shell. Returns the
 * decision signals plus, when suspected, a machine-actionable `warning` string
 * that STARTS with a stable code ({@link SHELL_WARNING_CODE} or, when usable
 * embedded state is present, {@link SHELL_WARNING_CODE_EMBEDDED}) and carries the
 * ratio numbers so a downstream pipeline can act on it programmatically.
 */
export function detectJsShell(
  html: string,
  preparedText: string,
  hasUsableEmbeddedState: boolean,
): { warning?: string; signals: ShellSignals } {
  const rawHtmlChars = html.length;
  const preparedTextChars = preparedText.length;
  const scriptChars = totalScriptChars(html);
  const textRatio = rawHtmlChars > 0 ? preparedTextChars / rawHtmlChars : 1;
  const scriptRatio = rawHtmlChars > 0 ? scriptChars / rawHtmlChars : 0;
  const emptyRootMount = hasEmptyRootMount(html);

  const smallText = preparedTextChars < SHELL_PREPARED_TEXT_FLOOR && textRatio < SHELL_TEXT_RATIO_MAX;
  const structuralShellSignal = scriptRatio >= SHELL_SCRIPT_RATIO_MIN || emptyRootMount;
  const suspected = smallText && structuralShellSignal;

  const signals: ShellSignals = {
    rawHtmlChars,
    preparedTextChars,
    textRatio,
    scriptRatio,
    emptyRootMount,
    suspected,
  };
  if (!suspected) return { signals };

  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const detail =
    `prepared text ${preparedTextChars} chars is ${pct(textRatio)} of ${rawHtmlChars}-char HTML; ` +
    `scripts ${pct(scriptRatio)} of HTML${emptyRootMount ? "; client-render mount element is empty" : ""}`;

  const warning = hasUsableEmbeddedState
    ? `${SHELL_WARNING_CODE_EMBEDDED}: ${detail}; embedded state was harvested, so this page is extractable WITHOUT a browser render`
    : `${SHELL_WARNING_CODE}: ${detail}; page likely requires JavaScript rendering upstream before extraction`;

  return { warning, signals };
}

/**
 * One call for the prep layer: harvest embedded state from raw `html`, then run
 * shell detection against the already-computed `preparedText`. Returns the
 * sidecar plus every warning (harvest notes + shell warning) to merge into the
 * prep result. Never throws.
 */
export function inspectHtml(
  html: string,
  preparedText: string,
): { embedded?: EmbeddedState; warnings: string[] } {
  const { embedded, warnings } = harvestEmbeddedState(html);
  const { warning } = detectJsShell(html, preparedText, embedded !== undefined);
  if (warning) warnings.push(warning);
  return { embedded, warnings };
}
