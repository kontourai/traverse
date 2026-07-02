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
 */

import type { ContentType } from "./types.js";

const DEFAULT_MAX_CHARS = 32_000;

/** Elements whose entire content is chrome/noise, removed with their children. */
const NOISE_ELEMENTS = ["script", "style", "noscript", "nav", "header", "footer"];

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

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

  // Decode common entities.
  text = text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? m);

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

/**
 * Prepare raw content of a given type into extractor-ready text.
 *
 * - `"html"`: string input, stripped via {@link htmlToText}.
 * - `"text"`: string input, truncate-only passthrough.
 * - `"pdf"`: DEFERRED — always returns a typed `error`, never decodes the bytes.
 *
 * Binary (`Uint8Array`) input is only meaningful for `"pdf"` today, which is
 * deferred; passing bytes for `"html"`/`"text"` returns a typed `error`.
 */
export function prepareContent(
  content: string | Uint8Array,
  contentType: ContentType,
  maxChars: number = DEFAULT_MAX_CHARS,
): { text?: string; error?: string } {
  if (contentType === "pdf") {
    return {
      error:
        "pdf content-prep not implemented in @kontourai/traverse@0.1.0 — deferred to a later regulated-document adoption slice",
    };
  }

  if (typeof content !== "string") {
    return {
      error: `binary content is not supported for contentType "${contentType}"; provide a string`,
    };
  }

  if (contentType === "html") {
    return { text: htmlToText(content, maxChars) };
  }

  // "text": truncate-only passthrough.
  return { text: content.slice(0, maxChars) };
}
