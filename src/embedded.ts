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
 * Harvest a generic hydration blob (`window.__INITIAL_STATE__` /
 * `__PRELOADED_STATE__`) from any inline script. First non-empty match wins.
 */
function harvestInitialState(scriptTexts: string[], warnings: string[]): unknown | undefined {
  const assignRe = /(?:window\s*\.\s*)?__(?:INITIAL_STATE|PRELOADED_STATE)__\s*=\s*/;
  for (const text of scriptTexts) {
    const m = assignRe.exec(text);
    if (!m) continue;
    const jsonText = extractBalancedJson(text, m.index + m[0].length);
    if (!jsonText) continue;
    if (jsonText.length > MAX_RAW_BLOCK_CHARS) {
      warnings.push(
        `embedded-state-size-capped: skipped an oversized hydration blob (${jsonText.length} chars > ${MAX_RAW_BLOCK_CHARS})`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      warnings.push(`embedded-initialstate-parse-failed: ${msg(err)}`);
      continue;
    }
    if (serializedSize(parsed) > MAX_INITIAL_STATE_CHARS) {
      warnings.push(`embedded-state-size-capped: hydration blob exceeded ${MAX_INITIAL_STATE_CHARS} chars`);
      continue;
    }
    return parsed;
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

  const jsonLd: unknown[] = [];
  let jsonLdChars = 0;
  let nextData: unknown | undefined;
  const inlineScriptTexts: string[] = [];

  for (const el of scripts) {
    const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
    const id = (el.getAttribute("id") ?? "").trim();
    const raw = (el.textContent ?? "").trim();
    if (el.getAttribute("src") === null && raw) inlineScriptTexts.push(raw);
    if (!raw) continue;

    if (type === "application/ld+json") {
      if (jsonLd.length >= MAX_JSONLD_BLOCKS) {
        warnings.push(`embedded-state-size-capped: dropped JSON-LD blocks beyond ${MAX_JSONLD_BLOCKS}`);
        continue;
      }
      if (raw.length > MAX_RAW_BLOCK_CHARS) {
        warnings.push(
          `embedded-state-size-capped: skipped an oversized JSON-LD block (${raw.length} chars > ${MAX_RAW_BLOCK_CHARS})`,
        );
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        warnings.push(`embedded-jsonld-parse-failed: ${msg(err)}`);
        continue;
      }
      const size = serializedSize(parsed);
      if (jsonLdChars + size > MAX_JSONLD_TOTAL_CHARS) {
        warnings.push(`embedded-state-size-capped: JSON-LD total exceeded ${MAX_JSONLD_TOTAL_CHARS} chars`);
        continue;
      }
      jsonLdChars += size;
      jsonLd.push(parsed);
      continue;
    }

    if (id === "__NEXT_DATA__" && nextData === undefined) {
      if (raw.length > MAX_RAW_BLOCK_CHARS) {
        warnings.push(
          `embedded-state-size-capped: skipped an oversized __NEXT_DATA__ block (${raw.length} chars > ${MAX_RAW_BLOCK_CHARS})`,
        );
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        if (serializedSize(parsed) > MAX_NEXTDATA_CHARS) {
          warnings.push(`embedded-state-size-capped: __NEXT_DATA__ exceeded ${MAX_NEXTDATA_CHARS} chars`);
        } else {
          nextData = parsed;
        }
      } catch (err) {
        warnings.push(`embedded-nextdata-parse-failed: ${msg(err)}`);
      }
    }
  }

  const initialState = harvestInitialState(inlineScriptTexts, warnings);

  if (jsonLd.length === 0 && nextData === undefined && initialState === undefined) {
    return { warnings };
  }
  const embedded: EmbeddedState = { jsonLd };
  if (nextData !== undefined) embedded.nextData = nextData;
  if (initialState !== undefined) embedded.initialState = initialState;
  return { embedded, warnings };
}

/** Total characters occupied by `<script>...</script>` blocks in the raw HTML. */
function totalScriptChars(html: string): number {
  let total = 0;
  const re = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) total += m[0].length;
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
