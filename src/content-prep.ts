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
import type { ContentType } from "./types.js";

/** Prep mode: "text" (regex strip) or "markdown" (structure-preserving). */
export type PrepMode = "text" | "markdown";

const DEFAULT_MAX_CHARS = 32_000;

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
 */
export function prepareContent(
  content: string | Uint8Array,
  contentType: ContentType,
  maxChars: number = DEFAULT_MAX_CHARS,
  prep?: PrepMode,
): { text?: string; error?: string } {
  if (contentType === "pdf") {
    return { error: PDF_PREP_ERROR };
  }

  if (typeof content !== "string") {
    return { error: binaryPrepError(contentType) };
  }

  const mode: PrepMode = prep ?? (contentType === "html" ? "markdown" : "text");

  if (contentType === "html") {
    return { text: mode === "text" ? htmlToText(content, maxChars) : htmlToMarkdown(content, maxChars) };
  }

  // "text": truncate-only passthrough.
  return { text: content.slice(0, maxChars) };
}
