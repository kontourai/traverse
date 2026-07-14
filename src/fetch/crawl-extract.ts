/**
 * `crawlAndExtract` — the multi-page analogue of `fetchAndExtract`, composing
 * `@kontourai/forage`'s frontier CRAWL with traverse's EXTRACT.
 *
 * WHY FORAGE, NOT traverse's own `crawlSource`: forage is the survey-neutral
 * crawler that owns the SSRF-pinned egress, sitemap/render discovery, and
 * deterministic replay (the code originally lifted out of this very module).
 * A new composition builds on forage so the crawl mechanics have ONE home; the
 * legacy `crawlSource`/`fetchSource` surface here stays for back-compat and is
 * consolidated onto forage separately (forage#4).
 *
 * PROVENANCE CONTINUITY: each crawled page carries forage's own citable
 * `page.sourceRef` — a durable pointer to the exact snapshot bytes in forage's
 * store. That ref is threaded straight into `extract()`, so every proposal
 * traces back to the bytes forage captured, the same "show the work" guarantee
 * `fetchAndExtract` gives for a single page (there the ref is traverse's
 * `traverse-snapshot:` form; here it is forage's, because forage owns the
 * snapshot store the crawl wrote to).
 *
 * NEVER THROWS beyond what its parts throw: forage's `crawl` is never-throws by
 * contract (a bad page degrades to a warning in the manifest), and `extract()`
 * returns a typed result rather than throwing. A page whose extraction yields a
 * typed error still appears in `pages` with that `extraction` result attached.
 *
 * FETCH/EXTRACT SPLIT PRESERVED: forage does every network fetch; this helper
 * only maps each resulting page into `extract()`. It issues no HTTP itself.
 */

import { crawl as forageCrawl } from "@kontourai/forage";
import type { CrawlManifest, CrawlPolicy, Page, Seed } from "@kontourai/forage";
import { extract } from "../extract.js";
import { resolveContentType } from "./fetch-source.js";
import type {
  ExtractionProvider,
  ExtractionResult,
  ImageTextExtractor,
  PdfTextExtractor,
  TargetFieldSchema,
} from "../types.js";

export interface CrawlAndExtractOptions {
  /** the fields to extract from every crawled page — same contract as `extract()`. */
  targetSchema: TargetFieldSchema[];
  /** the extraction provider (mock/Anthropic/any) — same contract as `extract()`. */
  provider: ExtractionProvider;
  /** forage crawl policy (maxPages/discovery/render/egress/replay store/…). */
  policy?: CrawlPolicy;
  /** optional per-field hints forwarded to `extract()`. */
  fieldHints?: Record<string, string>;
  /** per-chunk provider content budget forwarded to `extract()`. */
  maxContentChars?: number;
  /** structure-preserving prep mode forwarded to `extract()` (default markdown for html). */
  prep?: "text" | "markdown";
  /** target max characters per chunk forwarded to `extract()`. */
  chunkSize?: number;
  /** character-window overlap forwarded to `extract()`. */
  chunkOverlap?: number;
  /** cap on number of chunks forwarded to `extract()`. */
  maxChunks?: number;
  /** ceiling on provider.extract() calls across the WHOLE crawl (see below). */
  maxProviderCalls?: number;
  /** ceiling on accumulated raw.tokensUsed across the WHOLE crawl (see below). */
  maxTotalTokens?: number;
  /** injected PDF text extractor, forwarded to `extract()`. */
  pdfTextExtractor?: PdfTextExtractor;
  /** injected image OCR extractor, forwarded to `extract()`. */
  imageTextExtractor?: ImageTextExtractor;
  /**
   * Injected crawl seam (defaults to forage's `crawl`). Present so tests can
   * drive a deterministic manifest without a live crawl; production callers
   * leave it unset. Mirrors the injectable-seam discipline used elsewhere in
   * this module (see `fetchOptions` on `fetchAndExtract`).
   */
  crawlImpl?: (seed: Seed, policy?: CrawlPolicy) => Promise<CrawlManifest>;
}

export interface CrawlAndExtractPageResult {
  /** the crawled page, verbatim from forage's manifest. */
  page: Page;
  /** forage's citable pointer to the exact snapshot the extraction drew from. */
  sourceRef: string;
  /** the extraction outcome for this page (a typed error result is still attached). */
  extraction: ExtractionResult;
}

export interface CrawlAndExtractResult {
  /** the full forage crawl manifest (pages, truncated, warnings, sitemap stats). */
  manifest: CrawlManifest;
  /** per-page extraction results, in manifest page order. */
  pages: CrawlAndExtractPageResult[];
}

/**
 * Crawl a seed with forage and extract from every resulting page in one call.
 *
 * Budgets (`maxProviderCalls`/`maxTotalTokens`) are per-page as forwarded to
 * `extract()`: each page gets the full budget. Callers wanting a whole-crawl
 * ceiling should bound the frontier via `policy.maxPages`.
 */
export async function crawlAndExtract(
  seed: Seed,
  opts: CrawlAndExtractOptions,
): Promise<CrawlAndExtractResult> {
  const runCrawl = opts.crawlImpl ?? forageCrawl;
  const manifest = await runCrawl(seed, opts.policy);

  const pages: CrawlAndExtractPageResult[] = [];
  for (const page of manifest.pages) {
    const contentType = resolveContentType(undefined, page.snapshot.headers?.["content-type"] ?? null);
    const extraction = await extract({
      content: page.body,
      contentType,
      sourceRef: page.sourceRef,
      targetSchema: opts.targetSchema,
      provider: opts.provider,
      fieldHints: opts.fieldHints,
      maxContentChars: opts.maxContentChars,
      prep: opts.prep,
      chunkSize: opts.chunkSize,
      chunkOverlap: opts.chunkOverlap,
      maxChunks: opts.maxChunks,
      maxProviderCalls: opts.maxProviderCalls,
      maxTotalTokens: opts.maxTotalTokens,
      pdfTextExtractor: opts.pdfTextExtractor,
      imageTextExtractor: opts.imageTextExtractor,
    });
    pages.push({ page, sourceRef: page.sourceRef, extraction });
  }

  return { manifest, pages };
}
