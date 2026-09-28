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
 *    never split across chunks. Page text outside the container (a title, an
 *    intro, a detail page's own paragraphs) is kept too, after a second chrome
 *    pass (ARIA navigation landmarks, link-dense blocks): short text rides with
 *    the first/last card batch, longer text is chunked on its own and dispatched
 *    after every card chunk. `fullText` is the Markdown of the kept segments
 *    joined by a fixed separator, so each chunk's offset is exact by
 *    construction; chunks are ordered cards first, not by offset.
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
  binaryPrepError,
  collapseMarkdown,
  createTurndownService,
  htmlToText,
  insideContentScope,
  pruneMarkdownNoise,
  prunedTextWarning,
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
  /**
   * The chunks dropped by the `maxChunks` cap whose text is still part of
   * `fullText`, in order, so their ranges can be reported as not read. A
   * structural segment none of whose chunks survived the cap is left out of
   * `fullText` entirely and has no entry here.
   */
  cappedChunks?: Chunk[];
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
  replaceWith(node: El): void;
  getAttribute(name: string): string | null;
  parentElement: El | null;
}
interface Doc {
  body: El | null;
  createElement(tagName: string): El;
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
  const { chunks, truncatedChunks, cappedChunks } = windowChunks(fullText, chunkSize, overlap, maxChunks);
  return {
    fullText, chunks, structural: false, cardCount: 0, truncatedChunks, warnings, effectivePrepMode,
    ...(cappedChunks.length > 0 ? { cappedChunks } : {}),
  };
}

// ---------------------------------------------------------------------------
// Character-window chunking (fallback + no-structure path)
// ---------------------------------------------------------------------------

function windowChunks(
  fullText: string,
  chunkSize: number,
  overlap: number,
  maxChunks: number,
): { chunks: Chunk[]; truncatedChunks: number; cappedChunks: Chunk[] } {
  if (fullText.length === 0) return { chunks: [], truncatedChunks: 0, cappedChunks: [] };
  if (fullText.length <= chunkSize) {
    return { chunks: [{ text: fullText, start: 0, end: fullText.length }], truncatedChunks: 0, cappedChunks: [] };
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

function capChunks(chunks: Chunk[], maxChunks: number): { chunks: Chunk[]; truncatedChunks: number; cappedChunks: Chunk[] } {
  if (chunks.length <= maxChunks) return { chunks, truncatedChunks: 0, cappedChunks: [] };
  return { chunks: chunks.slice(0, maxChunks), truncatedChunks: chunks.length - maxChunks, cappedChunks: chunks.slice(maxChunks) };
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

/**
 * One piece of structural `fullText`, in document order. A card batch is sent
 * as a single chunk. Page text outside the card container that is too long to
 * ride along with a card batch becomes its own `outside` segment, split by the
 * character window when it is longer than one chunk.
 */
interface Segment {
  text: string;
  outside: boolean;
}

/**
 * Join segments into a single fullText (document order) and emit chunks with
 * exact offsets. Card chunks are emitted, and therefore dispatched, before any
 * outside-text chunk, so neither `maxChunks` here nor `maxProviderCalls` /
 * `maxTotalTokens` in extract() can spend the budget on page text first.
 */
function assembleSegments(
  segments: Segment[],
  chunkSize: number,
  overlap: number,
  maxChunks: number,
): { chunks: Chunk[]; fullText: string; truncatedChunks: number; cappedChunks: Chunk[]; warnings: string[] } {
  const parts = segments
    .filter((segment) => segment.text.length > 0)
    .map((segment) => ({
      segment,
      local: segment.outside
        ? windowChunks(segment.text, chunkSize, overlap, Number.MAX_SAFE_INTEGER).chunks
        : [{ text: segment.text, start: 0, end: segment.text.length }],
      kept: 0,
      offset: 0,
    }));
  const priority = [...parts.filter((part) => !part.segment.outside), ...parts.filter((part) => part.segment.outside)];
  let budget = maxChunks;
  for (const part of priority) {
    part.kept = Math.min(part.local.length, budget);
    budget -= part.kept;
  }

  // A segment none of whose chunks survive the cap is left out of fullText,
  // as structural mode has always done for chunks beyond maxChunks.
  const pieces: string[] = [];
  let cursor = 0;
  for (const part of parts) {
    if (part.kept === 0) continue;
    part.offset = cursor;
    pieces.push(part.segment.text);
    cursor += part.segment.text.length + CHUNK_SEPARATOR.length;
  }

  const chunks: Chunk[] = [];
  for (const part of priority) {
    for (const chunk of part.local.slice(0, part.kept)) {
      chunks.push({ text: chunk.text, start: part.offset + chunk.start, end: part.offset + chunk.end });
    }
  }

  // Capped chunks of a segment that is still in fullText keep a real range.
  const cappedChunks: Chunk[] = [];
  for (const part of parts) {
    if (part.kept === 0) continue;
    for (const chunk of part.local.slice(part.kept)) {
      cappedChunks.push({ text: chunk.text, start: part.offset + chunk.start, end: part.offset + chunk.end });
    }
  }

  const warnings: string[] = [];
  let droppedChunks = 0;
  let droppedChars = 0;
  for (const part of parts) {
    if (!part.segment.outside || part.kept === part.local.length) continue;
    droppedChunks += part.local.length - part.kept;
    droppedChars += part.segment.text.length - (part.kept === 0 ? 0 : part.local[part.kept - 1].end);
  }
  if (droppedChunks > 0) {
    warnings.push(
      `structural prep: ${droppedChunks} chunk${droppedChunks === 1 ? "" : "s"} of page text outside the card container ` +
        `(${droppedChars} chars) left out beyond maxChunks; card chunks were kept first`,
    );
  }
  const total = parts.reduce((n, part) => n + part.local.length, 0);
  return { chunks, fullText: pieces.join(CHUNK_SEPARATOR), truncatedChunks: total - chunks.length, cappedChunks, warnings };
}

/** Alphanumeric so Turndown never escapes it; lengthened until the page lacks it. */
function containerMarker(html: string): string {
  let marker = "traversecardcontainerboundary";
  while (html.includes(marker)) marker += "x";
  return marker;
}

/**
 * Outside text up to this share of `chunkSize` rides along with the first
 * (leading) or last (trailing) card batch without counting toward its budget,
 * as the page title always has. Longer outside text becomes its own segment,
 * dispatched after every card chunk, so it cannot crowd cards out of a prompt.
 */
const OUTSIDE_PREAMBLE_SHARE = 0.25;
/** A block outside the container with at least this many links... */
const LINK_DENSE_MIN_LINKS = 3;
/** ...whose link text is at least this share of its text is navigation. */
const LINK_DENSE_MIN_SHARE = 0.5;
/** ARIA landmarks equivalent to the pruned nav/header/footer elements. */
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo"]);

/**
 * A block that lost chrome descendants and keeps less text than this is the
 * chrome's leftover labels (a mega-menu's column headings), not content.
 */
const CHROME_REMNANT_MAX_CHARS = 32;

/** Links that carry a contact value rather than navigate. */
const CONTACT_HREF = /^\s*(?:tel|mailto|sms):/i;

/**
 * Remove chrome that the element-name pruning misses from the page text
 * outside the container: ARIA navigation landmarks and link-dense blocks
 * (div-based navbars, mega-menus, pagination and link farms), plus the short
 * label remnants those leave behind. Innermost blocks are judged first, so a
 * wrapper that mixes a menu with real text keeps the text once the menu is gone.
 *
 * A landmark role inside `article`/`main` is scoped to that content and kept,
 * and contact links (`tel:`, `mailto:`, `sms:`) are values, not navigation, so
 * they never make a block link-dense. Returns the text of every block it
 * removed, so the caller can say what was pruned; nothing is dropped silently.
 */
function pruneOutsideChrome(body: El, marker: string): string[] {
  const pruned: string[] = [];
  const lostChrome = new Set<El>();
  const remove = (el: El) => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) lostChrome.add(parent);
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) pruned.push(text);
    el.remove();
  };
  const compact = (el: El) => (el.textContent ?? "").replace(/\s+/g, "");
  const elements = [...(body as unknown as Doc).querySelectorAll("*")].reverse();
  for (const el of elements) {
    if (!body.contains(el) || (el.textContent ?? "").includes(marker)) continue;
    const role = el.getAttribute("role")?.toLowerCase();
    if (role && CHROME_ROLES.has(role) && !insideContentScope(el as unknown as Parameters<typeof insideContentScope>[0])) {
      remove(el);
      continue;
    }
    const text = compact(el);
    if (lostChrome.has(el) && text.length < CHROME_REMNANT_MAX_CHARS) {
      remove(el);
      continue;
    }
    if (text.length === 0) continue;
    const links = [...(el as unknown as Doc).querySelectorAll("a")]
      .filter((a) => !CONTACT_HREF.test(a.getAttribute("href") ?? ""));
    if (links.length < LINK_DENSE_MIN_LINKS) continue;
    const linkText = links.reduce((n, a) => n + compact(a).length, 0);
    if (linkText / text.length >= LINK_DENSE_MIN_SHARE) remove(el);
  }
  return pruned;
}

/** The warning naming the navigation-like text pruned outside the card container. */
function prunedWarning(pruned: string[]): string | undefined {
  return prunedTextWarning("structural prep", "navigation-like block", pruned, " outside the card container");
}

/**
 * The pruned page Markdown before and after the card container, converted the
 * way the whole-page path converts it. The live document is left unchanged
 * (the whole-page fallback may still read it). Returns undefined when the split
 * cannot be made exactly (the caller then prepares the whole page instead).
 */
function outsideContainer(
  group: CardGroup,
  doc: Doc,
  html: string,
  td: ReturnType<typeof createTurndownService>,
): { leading: string; trailing: string; pruned: string[] } | undefined {
  if (!doc.body || group.container === doc.body) return { leading: "", trailing: "", pruned: [] };
  const marker = containerMarker(html);
  const placeholder = doc.createElement("p");
  placeholder.textContent = marker;
  group.container.replaceWith(placeholder);
  const bodyHtml = doc.body.innerHTML;
  placeholder.replaceWith(group.container);

  const copy = parseHTML(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`).document as unknown as Doc;
  if (!copy.body) return undefined;
  const pruned = pruneOutsideChrome(copy.body, marker);
  const md = collapseMarkdown(td.turndown(copy.body.innerHTML), SAFETY_CAP);
  const at = md.indexOf(marker);
  if (at < 0 || md.indexOf(marker, at + 1) >= 0) return undefined;
  return { leading: md.slice(0, at).trim(), trailing: md.slice(at + marker.length).trim(), pruned };
}

function buildStructuralChunks(
  group: CardGroup,
  doc: Doc,
  html: string,
  chunkSize: number,
  overlap: number,
  maxChunks: number,
): { fullText: string; chunks: Chunk[]; truncatedChunks: number; cappedChunks: Chunk[]; cardCount: number; warnings: string[] } | undefined {
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
  const batches: string[] = [];
  let parts: string[] = [];
  let curLen = 0;
  const flush = () => {
    if (parts.length > 0) {
      batches.push(parts.join(CHUNK_SEPARATOR));
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
  if (batches.length === 0) return undefined;

  // Everything the pruned page holds outside the container: the page title, an
  // intro, or a detail page's own text around a short repeated list. Short
  // text rides along with the first/last card batch (card boundaries stay as
  // they are); longer text gets its own segment, dispatched after the cards.
  const outside = outsideContainer(group, doc, html, td);
  if (!outside) return undefined;
  const preambleLimit = Math.floor(chunkSize * OUTSIDE_PREAMBLE_SHARE);
  const segments: Segment[] = batches.map((text) => ({ text, outside: false }));
  const { leading, trailing } = outside;
  if (leading.length > 0 && leading.length <= preambleLimit) {
    segments[0].text = leading + CHUNK_SEPARATOR + segments[0].text;
  } else if (leading.length > 0) {
    segments.unshift({ text: leading, outside: true });
  }
  if (trailing.length > 0 && trailing.length <= preambleLimit) {
    const last = segments[segments.length - 1];
    last.text = last.text + CHUNK_SEPARATOR + trailing;
  } else if (trailing.length > 0) {
    segments.push({ text: trailing, outside: true });
  }

  const assembled = assembleSegments(segments, chunkSize, overlap, maxChunks);
  const pruneNote = prunedWarning(outside.pruned);
  return {
    ...assembled,
    warnings: pruneNote === undefined ? assembled.warnings : [pruneNote, ...assembled.warnings],
    cardCount: group.cards.length,
  };
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
    const noiseNote = prunedTextWarning("markdown prep", "page-chrome element", pruneMarkdownNoise(doc));
    if (noiseNote !== undefined) warnings.push(noiseNote);

    const group = findRepeatedCards(doc);
    if (group && group.cards.length >= MIN_CARDS) {
      const built = buildStructuralChunks(group, doc, content, chunkSize, overlap, maxChunks);
      // Only report `structural` when it actually produced chunks; if the cards
      // converted to nothing, fall through to the whole-page path below.
      if (built && built.chunks.length > 0) {
        warnings.push(...built.warnings);
        const result: PreparedChunks = {
          fullText: built.fullText,
          chunks: built.chunks,
          structural: true,
          cardCount: built.cardCount,
          truncatedChunks: built.truncatedChunks,
          ...(built.cappedChunks.length > 0 ? { cappedChunks: built.cappedChunks } : {}),
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
