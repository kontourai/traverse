/**
 * Large-page chunking: structure-preserving prep + structural / character-window
 * chunking with OFFSET-CORRECT provenance.
 *
 * Why hand-rolled (not a third-party text splitter): every chunk must be an
 * exact contiguous substring of a single `fullText`, and every chunk's `start`
 * offset must be its true position in that `fullText`. That is the property
 * `extract()` relies on to re-anchor each proposal's verified excerpt to the
 * `"chars:<start>-<end>"` locator against the FULL prepared text (see
 * src/extract.ts, src/types.ts). A normalizing splitter that trims/reflows text
 * would break that offset math, so we build `fullText` and the chunk offsets
 * together here and never mutate a chunk after the fact.
 *
 * Two strategies:
 *  - STRUCTURAL (html + markdown): parse the DOM (linkedom), prune chrome, detect
 *    the repeated-sibling "card" container (e.g. a run of `div.result` /
 *    `article.listing`), and cut chunk boundaries ON card boundaries so a card is
 *    never split across chunks. `fullText` is the Markdown of the kept chunks
 *    joined by a fixed separator, so each chunk's offset is exact by construction.
 *  - CHARACTER-WINDOW FALLBACK (no structure, or text/`prep:'text'`): slide a
 *    `chunkSize` window over `fullText` with `chunkOverlap`, so a value that would
 *    straddle a window boundary still appears whole in an adjacent window.
 *    Duplicates from the overlap are removed by `extract()`'s cross-chunk dedup.
 *
 * `prepareAndChunk` never throws: unsupported paths return `{ error }` (mirroring
 * `prepareContent`), and a markdown/structural failure degrades to text chunking
 * with a warning rather than propagating.
 */

import { parseHTML } from "linkedom";
import {
  MARKDOWN_NOISE_ELEMENTS,
  binaryPrepError,
  collapseMarkdown,
  createTurndownService,
  htmlToText,
  vttToText,
  PDF_PREP_ERROR,
  type PrepMode,
} from "./content-prep.js";
import { inspectHtml } from "./embedded.js";
import type { ContentType, EmbeddedState } from "./types.js";

export interface ChunkOptions {
  /** structure-preserving prep. Default "markdown" for html, "text" otherwise. */
  prep?: PrepMode;
  /** target max characters per chunk (default 12000). */
  chunkSize?: number;
  /** character-window overlap for the fallback chunker (default 200). */
  chunkOverlap?: number;
  /** cap on number of chunks; extras are dropped with a warning (default 40). */
  maxChunks?: number;
}

/** One chunk: an exact contiguous substring of `PreparedChunks.fullText`. */
export interface Chunk {
  text: string;
  /** 0-based offset of `text` within `fullText`. */
  start: number;
  /** `start + text.length`. */
  end: number;
}

export interface PreparedChunks {
  /** the FULL prepared text every chunk offset (and every locator) is anchored to. */
  fullText: string;
  chunks: Chunk[];
  /** true when repeated-card structure drove the chunk boundaries. */
  structural: boolean;
  /** number of detected cards (0 when not structural). */
  cardCount: number;
  /** chunks dropped by the `maxChunks` cap (0 when none). */
  truncatedChunks: number;
  warnings: string[];
  /** The preparation actually used, including markdown's fail-closed text fallback. */
  effectivePrepMode: "text" | "markdown" | "transcript";
  /** typed prep error (pdf / binary); when set, `chunks` is empty. */
  error?: string;
  /**
   * Machine-readable state harvested from the raw HTML before scripts were
   * pruned (JSON-LD, `__NEXT_DATA__`, hydration blobs) — present only for
   * `"html"` content that carried some. Harvested ONCE from the whole page, so
   * it is independent of chunk boundaries. See `src/embedded.ts`.
   */
  embedded?: EmbeddedState;
}

export const DEFAULT_CHUNK_SIZE = 12_000;
export const DEFAULT_CHUNK_OVERLAP = 200;
export const DEFAULT_MAX_CHUNKS = 40;

/** Minimum repeated-sibling count for a container to count as a card list. */
const MIN_CARDS = 3;
/** Separator between structural chunks in `fullText` (not part of any chunk). */
const CHUNK_SEPARATOR = "\n\n";
/** Hard cap on total prepared-text size, to bound memory on pathological inputs. */
const SAFETY_CAP = 5_000_000;

// ---------------------------------------------------------------------------
// Minimal structural view over linkedom nodes (cast once at the boundary so the
// rest of the module stays strictly typed without depending on linkedom's or
// lib.dom's exact node types).
// ---------------------------------------------------------------------------

interface El {
  tagName: string;
  classList: Iterable<string> & ArrayLike<string>;
  children: ArrayLike<El> & Iterable<El>;
  outerHTML: string;
  innerHTML: string;
  textContent: string | null;
  remove(): void;
  contains(other: El): boolean;
}
interface Doc {
  body: El | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
}

function resolvePrep(contentType: ContentType, prep?: PrepMode): PrepMode {
  if (prep) return prep;
  return contentType === "html" ? "markdown" : "text";
}

function emptyError(error: string, effectivePrepMode: PreparedChunks["effectivePrepMode"]): PreparedChunks {
  return { fullText: "", chunks: [], structural: false, cardCount: 0, truncatedChunks: 0, warnings: [], effectivePrepMode, error };
}

/** Non-structural result: character-window `fullText` (single-chunk when small). */
function windowResult(
  fullText: string,
  chunkSize: number,
  overlap: number,
  maxChunks: number,
  warnings: string[],
  effectivePrepMode: PreparedChunks["effectivePrepMode"],
): PreparedChunks {
  const { chunks, truncatedChunks } = windowChunks(fullText, chunkSize, overlap, maxChunks);
  return { fullText, chunks, structural: false, cardCount: 0, truncatedChunks, warnings, effectivePrepMode };
}

// ---------------------------------------------------------------------------
// Character-window chunking (fallback + no-structure path)
// ---------------------------------------------------------------------------

function windowChunks(
  fullText: string,
  chunkSize: number,
  overlap: number,
  maxChunks: number,
): { chunks: Chunk[]; truncatedChunks: number } {
  if (fullText.length === 0) return { chunks: [], truncatedChunks: 0 };
  if (fullText.length <= chunkSize) {
    return { chunks: [{ text: fullText, start: 0, end: fullText.length }], truncatedChunks: 0 };
  }
  const step = Math.max(1, chunkSize - overlap);
  const chunks: Chunk[] = [];
  for (let start = 0; start < fullText.length; start += step) {
    const end = Math.min(start + chunkSize, fullText.length);
    chunks.push({ text: fullText.slice(start, end), start, end });
    if (end === fullText.length) break;
  }
  return capChunks(chunks, maxChunks);
}

function capChunks(chunks: Chunk[], maxChunks: number): { chunks: Chunk[]; truncatedChunks: number } {
  if (chunks.length <= maxChunks) return { chunks, truncatedChunks: 0 };
  return { chunks: chunks.slice(0, maxChunks), truncatedChunks: chunks.length - maxChunks };
}

// ---------------------------------------------------------------------------
// Repeated-card detection
// ---------------------------------------------------------------------------

function signatureOf(el: El): string {
  const cls = [...el.classList].sort().join(".");
  return el.tagName.toLowerCase() + (cls ? "." + cls : "");
}

interface CardGroup {
  container: El;
  signature: string;
  cards: El[];
}

/**
 * Find the DOM element with the largest run of same-signature (tag + sorted
 * class list) direct-child elements — the repeated "cards" of a listing page.
 * Ties break toward the group with more total text. Returns undefined when no
 * element has at least MIN_CARDS matching children.
 */
function findRepeatedCards(doc: Doc): CardGroup | undefined {
  const body = doc.body;
  if (!body) return undefined;
  let best: { container: El; signature: string; count: number; textLen: number } | undefined;

  const stack: El[] = [body];
  while (stack.length > 0) {
    const el = stack.pop() as El;
    const groups = new Map<string, El[]>();
    for (const child of el.children) {
      const sig = signatureOf(child);
      const arr = groups.get(sig);
      if (arr) arr.push(child);
      else groups.set(sig, [child]);
      stack.push(child);
    }
    for (const [signature, members] of groups) {
      if (members.length < MIN_CARDS) continue;
      const textLen = members.reduce((n, m) => n + (m.textContent?.length ?? 0), 0);
      const better =
        !best ||
        members.length > best.count ||
        (members.length === best.count && textLen > best.textLen);
      if (better) best = { container: el, signature, count: members.length, textLen };
    }
  }

  if (!best) return undefined;
  const cards = [...best.container.children].filter((c) => signatureOf(c) === best.signature);
  return { container: best.container, signature: best.signature, cards };
}

// ---------------------------------------------------------------------------
// Structural chunk assembly
// ---------------------------------------------------------------------------

/** Join per-chunk Markdown into a single fullText, recording exact offsets. */
function assembleChunks(
  texts: string[],
  maxChunks: number,
): { chunks: Chunk[]; fullText: string; truncatedChunks: number } {
  const nonEmpty = texts.filter((t) => t.length > 0);
  const kept = nonEmpty.slice(0, maxChunks);
  const truncatedChunks = nonEmpty.length > maxChunks ? nonEmpty.length - maxChunks : 0;

  const chunks: Chunk[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  for (const text of kept) {
    chunks.push({ text, start: cursor, end: cursor + text.length });
    pieces.push(text);
    cursor += text.length + CHUNK_SEPARATOR.length;
  }
  return { chunks, fullText: pieces.join(CHUNK_SEPARATOR), truncatedChunks };
}

function buildStructuralChunks(
  group: CardGroup,
  doc: Doc,
  chunkSize: number,
  maxChunks: number,
): { fullText: string; chunks: Chunk[]; truncatedChunks: number; cardCount: number } {
  const td = createTurndownService();
  const children = [...group.container.children];

  // Convert each child to Markdown up front so batching measures ACTUAL Markdown
  // size (link/image cards blow past their textContent length once hrefs and
  // image URLs are rendered) and so each chunk reuses that exact Markdown — which
  // is what makes `fullText` = the chunks joined by the separator, exactly.
  const childTexts = children.map((child) => ({
    md: collapseMarkdown(td.turndown(child.outerHTML), SAFETY_CAP),
    isCard: signatureOf(child) === group.signature,
  }));

  // Batch children in document order, breaking a new batch only at a card
  // boundary so a card is never split. Non-card children (an intro heading, a
  // filter bar) stay attached to the current batch.
  const chunkTexts: string[] = [];
  let parts: string[] = [];
  let curLen = 0;
  const flush = () => {
    if (parts.length > 0) {
      chunkTexts.push(parts.join(CHUNK_SEPARATOR));
      parts = [];
      curLen = 0;
    }
  };
  for (const { md, isCard } of childTexts) {
    if (md.length === 0) continue;
    if (parts.length > 0 && isCard && curLen + md.length > chunkSize) flush();
    parts.push(md);
    curLen += md.length + CHUNK_SEPARATOR.length;
  }
  flush();

  // Prepend the document's leading <h1> (page title) to the first chunk when it
  // lives OUTSIDE the detected card container, so at least the page-level heading
  // is carried into extraction. Content that is neither a card-container child nor
  // this heading (already-pruned chrome, deep page chrome) is intentionally out
  // of scope for structural chunking — see docs/adr/0004.
  const heading = doc.querySelector("h1");
  if (heading && chunkTexts.length > 0 && !group.container.contains(heading)) {
    const preamble = collapseMarkdown(td.turndown(heading.outerHTML), chunkSize);
    if (preamble.length > 0) chunkTexts[0] = preamble + CHUNK_SEPARATOR + chunkTexts[0];
  }

  const { chunks, fullText, truncatedChunks } = assembleChunks(chunkTexts, maxChunks);
  return { fullText, chunks, truncatedChunks, cardCount: group.cards.length };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Attach the embedded-state sidecar and any prep-layer warnings (embedded
 * parse notes + JS-shell warning) to a prepared HTML result, in place. Harvest
 * reads the ORIGINAL `html` (scripts intact); shell detection compares it to the
 * already-built `result.fullText`. Runs once per page — never per chunk.
 */
function augmentHtml(result: PreparedChunks, html: string): void {
  const { embedded, warnings } = inspectHtml(html, result.fullText);
  if (embedded) result.embedded = embedded;
  result.warnings.push(...warnings);
}

/**
 * Prepare `content` into a single `fullText` plus offset-correct `chunks`.
 * Never throws; returns `{ error }` for deferred/unsupported inputs.
 */
export function prepareAndChunk(
  content: string | Uint8Array,
  contentType: ContentType,
  options: ChunkOptions = {},
): PreparedChunks {
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.min(Math.max(0, options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP), Math.max(0, chunkSize - 1));
  const maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_CHUNKS);
  const prep = resolvePrep(contentType, options.prep);
  const warnings: string[] = [];

  const requestedMode: PreparedChunks["effectivePrepMode"] = contentType === "transcript" ? "transcript" : prep;
  if (contentType === "pdf") return emptyError(PDF_PREP_ERROR, requestedMode);
  if (typeof content !== "string") return emptyError(binaryPrepError(contentType), requestedMode);

  // text/transcript passthrough or html with the prep:'text' escape hatch.
  // Embedded-state harvesting + shell detection still apply to html here (they
  // read the raw source, independent of prep mode). A "transcript" is cleaned
  // from WebVTT to plain text FIRST (vttToText) so chunk offsets — and every
  // proposal's chars:<start>-<end> locator — anchor to the cleaned transcript,
  // exactly the way html anchors to its Markdown.
  if (contentType !== "html" || prep === "text") {
    const fullText =
      contentType === "html"
        ? htmlToText(content, SAFETY_CAP)
        : contentType === "transcript"
          ? vttToText(content, SAFETY_CAP)
          : content.slice(0, SAFETY_CAP);
    const effectivePrepMode = contentType === "transcript" ? "transcript" : "text";
    const result = windowResult(fullText, chunkSize, overlap, maxChunks, warnings, effectivePrepMode);
    if (contentType === "html") augmentHtml(result, content);
    return result;
  }

  // html + markdown: try structural, degrade gracefully on any DOM/convert error
  try {
    const doc = parseHTML(content).document as unknown as Doc;
    for (const tag of MARKDOWN_NOISE_ELEMENTS) {
      for (const el of doc.querySelectorAll(tag)) el.remove();
    }

    const group = findRepeatedCards(doc);
    if (group && group.cards.length >= MIN_CARDS) {
      const built = buildStructuralChunks(group, doc, chunkSize, maxChunks);
      // Only report `structural` when it actually produced chunks; if the cards
      // converted to nothing, fall through to the whole-page path below.
      if (built.chunks.length > 0) {
        const result: PreparedChunks = {
          fullText: built.fullText,
          chunks: built.chunks,
          structural: true,
          cardCount: built.cardCount,
          truncatedChunks: built.truncatedChunks,
          warnings,
          effectivePrepMode: "markdown",
        };
        augmentHtml(result, content);
        return result;
      }
    }

    const td = createTurndownService();
    // linkedom leaves `body` empty for a bodyless fragment; fall back to the raw
    // string so Turndown's own parser handles it (see content-prep.htmlToMarkdown).
    const source = doc.body && doc.body.innerHTML.length > 0 ? doc.body.innerHTML : content;
    const fullText = collapseMarkdown(td.turndown(source), SAFETY_CAP);
    const result = windowResult(fullText, chunkSize, overlap, maxChunks, warnings, "markdown");
    augmentHtml(result, content);
    return result;
  } catch (err) {
    warnings.push(
      `markdown/structural prep failed (${err instanceof Error ? err.message : String(err)}); fell back to text chunking`,
    );
    const result = windowResult(htmlToText(content, SAFETY_CAP), chunkSize, overlap, maxChunks, warnings, "text");
    augmentHtml(result, content);
    return result;
  }
}
