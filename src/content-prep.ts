/**
 * Content preparation: turn raw input into extractor-ready text.
 *
 * This is a dependency-free implementation. It is a DOCUMENTED DEVIATION from a
 * cheerio-based HTML stripper — Slice 1 deliberately avoids a runtime dependency
 * so the package ships with an empty `dependencies` list. If a consumer's real
 * noise-removal turns out to need DOM-accurate stripping, a later slice may
 * revisit this module (flagged as a stop-short risk in the plan).
 *
 * `prepareContent` never throws: unsupported/deferred paths return a typed
 * `{ error }` instead.
 *
 * IMPORTANT for provenance: the string this module returns is the CONTENT-
 * PREPARED text — the exact text `extract()` hands to the provider, and the
 * exact text a proposal's `provenance.excerpt` is verified against (via
 * `indexOf`) and `provenance.locator`'s `"chars:<start>-<end>"` offsets are
 * anchored to (see src/types.ts, src/extract.ts). It is NOT the caller's raw
 * HTML/source document — tags are stripped, entities are decoded, and
 * whitespace is collapsed before this text ever reaches a provider.
 */

import TurndownService from "turndown";
import { parseHTML } from "linkedom";
import { inspectHtml } from "./embedded.js";
import type { ContentType, EmbeddedState, PdfTextExtractor } from "./types.js";

/** Prep mode: "text" (regex strip) or "markdown" (structure-preserving). */
export type PrepMode = "text" | "markdown";

const DEFAULT_MAX_CHARS = 32_000;

/**
 * Large cap used to prepare the FULL text for shell detection, independent of a
 * caller's `maxChars`. Mirrors the `SAFETY_CAP` in chunk.ts (kept as a local
 * const to avoid a content-prep <-> chunk import cycle). See the maxChars note
 * in {@link prepareContent}.
 */
const SHELL_INSPECT_CAP = 5_000_000;

/** Elements whose entire content is chrome/noise, removed with their children (text mode). */
const NOISE_ELEMENTS = ["script", "style", "noscript", "nav", "header", "footer"];

/**
 * Broader noise set pruned from the DOM before Markdown conversion / structural
 * chunking. Safe to drop from listing pages and keeps token density high. Kept
 * separate from {@link NOISE_ELEMENTS} so the text-mode regex path is unchanged.
 */
export const MARKDOWN_NOISE_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "iframe",
  "svg",
  "template",
  "head",
];

/** Typed content-prep error, shared with the chunker so the message is single-source. */
export const PDF_PREP_ERROR =
  "pdf content-prep not implemented in @kontourai/traverse@0.1.0 — deferred to a later regulated-document adoption slice";

/** Typed binary-input error, shared with the chunker so the message is single-source. */
export function binaryPrepError(contentType: ContentType): string {
  return `binary content is not supported for contentType "${contentType}"; provide a string`;
}

/** Typed error for "pdf" content-prep called with a string instead of bytes when an extractor IS supplied. */
export function pdfBytesRequiredError(): string {
  return "pdf content-prep requires Uint8Array (bytes), not a string — read the PDF as bytes (e.g. Buffer.from(fs.readFileSync(path)))";
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&#160;": " ",
  "&#xa0;": " ",
  // Common typographic entities — smart quotes, dashes, ellipsis.
  "&ndash;": "–",
  "&mdash;": "—",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&hellip;": "…",
};

const ENTITY_RE = new RegExp(
  Object.keys(ENTITY_MAP)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "gi",
);

/**
 * Strip HTML to meaningful text without any runtime dependency.
 * Removes script/style/noscript/nav/header/footer subtrees, strips remaining
 * tags, decodes common entities, collapses whitespace, and truncates.
 */
export function htmlToText(html: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  let text = html;

  // Remove noise elements including their content (non-greedy, dot-matches-newline).
  for (const tag of NOISE_ELEMENTS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    text = text.replace(re, " ");
    // Also drop self-closing / unclosed variants of the opening tag.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), " ");
  }

  // Turn block-ish boundaries into newlines so words don't run together.
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip all remaining tags.
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common entities (case-insensitive; ENTITY_RE is derived from ENTITY_MAP's keys).
  text = text.replace(ENTITY_RE, (m) => ENTITY_MAP[m.toLowerCase()] ?? m);

  // Collapse whitespace: trim each line, drop blank lines, collapse inline runs.
  text = text
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();

  return text.slice(0, maxChars);
}

/** A configured Turndown instance: ATX headings, dash bullets, chrome removed. */
export function createTurndownService(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    hr: "---",
    emDelimiter: "*",
  });
  // MARKDOWN_NOISE_ELEMENTS holds valid element names; the cast satisfies the
  // @types/turndown `Filter` union (keyed on HTMLElementTagNameMap, which omits
  // e.g. "svg") without narrowing our list to HTML-only tags.
  td.remove(MARKDOWN_NOISE_ELEMENTS as unknown as TurndownService.Filter);
  return td;
}

/** Parse HTML into a linkedom document with noise subtrees removed in place. */
export function parseAndPrune(html: string): ReturnType<typeof parseHTML>["document"] {
  const { document } = parseHTML(html);
  for (const tag of MARKDOWN_NOISE_ELEMENTS) {
    for (const el of document.querySelectorAll(tag)) el.remove();
  }
  return document;
}

/** Collapse Turndown output: drop trailing spaces, cap blank-line runs, trim, truncate. */
export function collapseMarkdown(md: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const collapsed = md
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return collapsed.slice(0, maxChars);
}

/**
 * Structure-preserving HTML -> Markdown. Prunes chrome/noise, then converts with
 * Turndown so links (as `[text](href)`), headings, and lists survive — unlike
 * {@link htmlToText}, whose regex strip discards href attributes and heading/list
 * structure. This is the default prep for `"html"` content.
 */
export function htmlToMarkdown(html: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const document = parseAndPrune(html);
  const td = createTurndownService();
  // linkedom only populates `body` for a well-formed document; for a bodyless
  // fragment (e.g. "<p>x</p>") it hoists the first element to documentElement and
  // leaves body empty. In that case hand the raw string to Turndown, whose own
  // parser handles fragments (and its remove() filter still prunes noise).
  const source = document.body && document.body.innerHTML.length > 0 ? document.body.innerHTML : html;
  return collapseMarkdown(td.turndown(source), maxChars);
}

/**
 * Prepare raw content of a given type into extractor-ready text.
 *
 * - `"html"`: string input. Default prep is `"markdown"` (structure-preserving,
 *   via {@link htmlToMarkdown}); pass `prep: "text"` for the legacy regex strip
 *   ({@link htmlToText}). The default flipped to `"markdown"` in 0.5.0 — see
 *   `docs/adr/0004-large-page-chunking.md`.
 * - `"text"`: string input, truncate-only passthrough (`prep` is ignored).
 * - `"pdf"`: DEFERRED — always returns a typed `error`, never decodes the bytes.
 *
 * Binary (`Uint8Array`) input is only meaningful for `"pdf"` today, which is
 * deferred; passing bytes for `"html"`/`"text"` returns a typed `error`.
 *
 * `maxChars` bounds the returned `text`. For `"html"`, the text is prepared in
 * full first (so JS-shell detection sees the true prepared length, not a
 * `maxChars`-shrunk one) and then sliced to `maxChars`; that full-prep stage is
 * itself capped at {@link SHELL_INSPECT_CAP} (5,000,000), so a `maxChars` larger
 * than that ceiling is effectively clamped to it. The 32,000 default and any
 * realistic value are unaffected.
 */
export function prepareContent(
  content: string | Uint8Array,
  contentType: ContentType,
  maxChars: number = DEFAULT_MAX_CHARS,
  prep?: PrepMode,
): { text?: string; error?: string; embedded?: EmbeddedState; warnings?: string[] } {
  if (contentType === "pdf") {
    return { error: PDF_PREP_ERROR };
  }

  if (typeof content !== "string") {
    return { error: binaryPrepError(contentType) };
  }

  const mode: PrepMode = prep ?? (contentType === "html" ? "markdown" : "text");

  if (contentType === "html") {
    // Prepare the FULL text once (bounded only by the large SHELL_INSPECT_CAP),
    // then slice the caller-visible `text` to `maxChars`. Shell detection must see
    // the full prepared length, NOT the caller's `maxChars`-truncated text:
    // otherwise a small `maxChars` (e.g. a lightweight preview) would shrink a
    // genuinely content-rich page below the shell floor and false-flag it as a JS
    // shell. Truncation happens after conversion, so preparing at the larger cap
    // costs the same conversion work and leaves the returned `text` identical.
    let full: string;
    if (mode === "text") {
      full = htmlToText(content, SHELL_INSPECT_CAP);
    } else {
      // Preserve the "never throws" contract: a DOM/Turndown failure on adversarial
      // HTML (e.g. pathological nesting overflowing the stack) degrades to the
      // regex text strip rather than propagating — mirroring prepareAndChunk.
      try {
        full = htmlToMarkdown(content, SHELL_INSPECT_CAP);
      } catch {
        full = htmlToText(content, SHELL_INSPECT_CAP);
      }
    }
    const text = full.slice(0, maxChars);
    // Harvest embedded state (JSON-LD / __NEXT_DATA__ / hydration) from the raw
    // HTML before scripts were stripped, and flag a JS-shell shape against the
    // FULL prepared text — both surface on the prep result. See src/embedded.ts.
    const { embedded, warnings } = inspectHtml(content, full);
    const result: { text: string; embedded?: EmbeddedState; warnings?: string[] } = { text };
    if (embedded) result.embedded = embedded;
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  // "text": truncate-only passthrough.
  return { text: content.slice(0, maxChars) };
}

/**
 * Validate a PdfTextExtractor-reported page-offset array against the
 * (possibly maxChars-truncated) prepared text length. "dropped, never
 * silently trusted" — mirrors the repo's normalization discipline (ADR 0001
 * §4): the WHOLE array is dropped (with one warning) unless every entry is a
 * finite number, the sequence is non-decreasing, and every entry falls
 * within `[0, textLength]`. `pageOffsets` is trust-not-verify content
 * (Traverse cannot independently confirm it against real PDF structure —
 * see docs/decisions/content-preparation.md); this only checks shape.
 */
function validatePageOffsets(
  offsets: number[] | undefined,
  textLength: number,
  warnings: string[],
): number[] | undefined {
  if (offsets === undefined) return undefined;
  if (!Array.isArray(offsets)) {
    warnings.push("dropped pdfPageOffsets: not an array");
    return undefined;
  }
  let prev = -1;
  for (const offset of offsets) {
    if (
      typeof offset !== "number" ||
      !Number.isFinite(offset) ||
      offset < 0 ||
      offset > textLength ||
      offset < prev
    ) {
      warnings.push("dropped pdfPageOffsets: malformed or out-of-range page offsets");
      return undefined;
    }
    prev = offset;
  }
  return offsets;
}

/**
 * Validate a PdfTextExtractor-reported `warnings` value against the same
 * "dropped, never silently trusted" discipline {@link validatePageOffsets}
 * applies to `pageOffsets` (ADR 0001 §4): `warnings` is trust-not-verify
 * content from a caller-supplied extractor, so a malformed shape (anything
 * other than `undefined` or an array of strings — e.g. a bare string, which
 * would otherwise silently spread into one-character "warnings" via
 * `[...str]`) is dropped wholesale rather than partially trusted. Returns an
 * empty array (with a warning appended describing the drop) for anything
 * that isn't `undefined` or `string[]`.
 */
function validateWarnings(rawWarnings: unknown): string[] {
  if (rawWarnings === undefined) return [];
  if (Array.isArray(rawWarnings) && rawWarnings.every((w) => typeof w === "string")) {
    return [...rawWarnings];
  }
  return ["dropped extractor-reported warnings: not an array of strings"];
}

/**
 * Run a caller-supplied {@link PdfTextExtractor} against PDF bytes and
 * produce prepared text, mirroring {@link htmlToMarkdown}'s degrade-via-
 * try/catch discipline (see the module docstring) — an extractor that
 * throws synchronously OR returns a rejected Promise is caught here and
 * surfaces as a typed `error`, never propagated (ADR 0001 §4 item 4,
 * never-throw). `text` is truncated to `maxChars` (mirroring every other
 * prep path's truncation); a `pageOffsets` array reported by the extractor
 * is shape-validated against the (post-truncation) text length via
 * {@link validatePageOffsets} and dropped (with a warning) rather than
 * trusted if malformed or out of range. `warnings` is shape-validated the
 * same way via {@link validateWarnings}. Called standalone (outside
 * `extract()`), `maxChars` defaults to `DEFAULT_MAX_CHARS` (32,000) —
 * `extract()` itself passes its own much larger internal cap
 * (`PDF_FULL_TEXT_CAP`, 5,000,000) when it calls this function, so a direct
 * caller who wants more than 32,000 characters must pass `maxChars`
 * explicitly.
 */
export async function preparePdfText(
  bytes: Uint8Array,
  extractor: PdfTextExtractor,
  maxChars: number = DEFAULT_MAX_CHARS,
): Promise<{ text: string; pageOffsets?: number[]; warnings: string[]; error?: string }> {
  try {
    const raw = await extractor.extract(bytes);
    if (typeof raw?.text !== "string") {
      return { text: "", warnings: [], error: "pdf text extraction failed: extractor returned no text" };
    }
    const text = raw.text.slice(0, maxChars);
    const warnings = validateWarnings(raw.warnings);
    const pageOffsets = validatePageOffsets(raw.pageOffsets, text.length, warnings);
    return { text, ...(pageOffsets ? { pageOffsets } : {}), warnings };
  } catch (err) {
    return {
      text: "",
      warnings: [],
      error: `pdf text extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Resolve a 0-based char offset (e.g. a proposal's verified `chars:` locator
 * start) to a 1-based page number, using a `pdfPageOffsets` sidecar
 * ({@link ExtractionResult.pdfPageOffsets} / {@link PdfExtractedText.pageOffsets}).
 * Returns `undefined` when `pageOffsets` is absent/empty or `charOffset` is
 * negative or precedes every page's start (which should not happen for a
 * well-formed `pageOffsets[0] === 0`, but is handled defensively).
 */
export function resolvePdfPage(pageOffsets: number[] | undefined, charOffset: number): number | undefined {
  if (!pageOffsets || pageOffsets.length === 0 || charOffset < 0) return undefined;
  let page = 0;
  for (let i = 0; i < pageOffsets.length; i++) {
    if (pageOffsets[i] <= charOffset) page = i + 1;
    else break;
  }
  return page > 0 ? page : undefined;
}
