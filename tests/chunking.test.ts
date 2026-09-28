import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { prepareAndChunk } from "../src/chunk.js";
import { extract } from "../src/extract.js";
import { prepareContent } from "../src/content-prep.js";
import type { ExtractionProvider, ProviderExtractionOutput } from "../src/types.js";
import { createRegexScanProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

const cardsHtml = readFileSync(
  new URL("../../tests/fixtures/repeated-cards-page.html", import.meta.url),
  "utf8",
);

// A provider that proposes a fixed "title" whenever `marker` occurs in the chunk.
function markerProvider(marker: string): ExtractionProvider {
  return {
    name: "marker-mock",
    async extract(input): Promise<ProviderExtractionOutput> {
      const proposals = [];
      if (input.content.includes(marker)) {
        proposals.push({
          fieldPath: "title",
          candidateValue: marker,
          confidence: 0.8,
          provenance: { excerpt: marker, locator: "provisional" },
          extractor: "marker-mock",
        });
      }
      return { proposals, raw: { response: "{}", model: "mock" } };
    },
  };
}

describe("prepareAndChunk (structural)", () => {
  it("chunks a repeated-card page larger than one chunk on card boundaries, with exact offsets", () => {
    const r = prepareAndChunk(cardsHtml, "html", { chunkSize: 400 });
    assert.equal(r.structural, true);
    assert.equal(r.cardCount, 12);
    assert.ok(r.chunks.length > 1, "splits into more than one chunk");
    assert.equal(r.truncatedChunks, 0);
    // every chunk is an exact contiguous substring of fullText...
    assert.ok(r.chunks.every((c) => r.fullText.slice(c.start, c.end) === c.text));
    // ...and offsets are contiguous across the fixed separator (no gaps/overlap).
    for (let i = 1; i < r.chunks.length; i++) {
      assert.equal(r.chunks[i].start, r.chunks[i - 1].end + 2);
    }
    // all 12 cards survive chunking (none lost across a boundary)
    for (let i = 1; i <= 12; i++) {
      const title = `Program ${String(i).padStart(2, "0")} Alpha`;
      assert.ok(r.fullText.includes(title), `${title} present`);
    }
  });

  it("caps chunk count at maxChunks and reports the truncation", () => {
    const r = prepareAndChunk(cardsHtml, "html", { chunkSize: 400, maxChunks: 2 });
    assert.equal(r.chunks.length, 2);
    assert.ok(r.truncatedChunks > 0);
  });
});

describe("markdown prep", () => {
  it("preserves link hrefs (default markdown for html)", () => {
    const { text } = prepareContent(cardsHtml, "html");
    assert.match(text ?? "", /\]\(https:\/\/example\.test\/apply\/01\)/);
  });

  it("prep:'text' escape hatch strips hrefs (legacy behavior) and finds no structure", () => {
    const { text } = prepareContent(cardsHtml, "html", 32_000, "text");
    assert.doesNotMatch(text ?? "", /example\.test\/apply/);
    const r = prepareAndChunk(cardsHtml, "html", { prep: "text", chunkSize: 400 });
    assert.equal(r.structural, false);
  });
});

describe("prepareAndChunk (character-window fallback)", () => {
  it("windows unstructured text with overlap", () => {
    const r = prepareAndChunk("X".repeat(1000), "text", { chunkSize: 100, chunkOverlap: 20 });
    assert.equal(r.structural, false);
    assert.ok(r.chunks.length > 1);
    assert.equal(r.chunks[0].start, 0);
    assert.equal(r.chunks[0].end, 100);
    // step = chunkSize - overlap = 80
    assert.equal(r.chunks[1].start, 80);
    assert.ok(r.chunks.every((c) => r.fullText.slice(c.start, c.end) === c.text));
  });
});

describe("extract() chunked path", () => {
  it("adjusts locators to the full prepared text (non-zero offset from a later chunk)", async () => {
    const chunkSize = 400;
    const prepared = prepareAndChunk(cardsHtml, "html", { chunkSize });
    const provider = createRegexScanProvider();
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize,
    });

    assert.equal(result.error, undefined);
    // all 12 distinct cards proposed (nothing dropped at chunk boundaries)
    const titles = new Set(result.proposals.map((p) => p.candidateValue));
    assert.equal(titles.size, 12);

    // a card in a later chunk carries a correct, non-zero locator into fullText
    const p12 = result.proposals.find((p) => p.candidateValue === "Program 12 Alpha");
    assert.ok(p12, "Program 12 was proposed");
    const idx = prepared.fullText.indexOf("Program 12 Alpha");
    assert.ok(idx > 0, "later card sits at a non-zero offset");
    assert.equal(p12!.provenance.locator, `chars:${idx}-${idx + "Program 12 Alpha".length}`);

    // structural chunk-count warning is surfaced
    assert.ok(
      result.warnings?.some((w) =>
        /chunked into \d+ chunks by repeated-card structure \(12 cards detected\)/.test(w),
      ),
    );
  });

  it("dedupes an identical proposal produced from two overlapping windows", async () => {
    // "MARKER" at offset 85 sits fully inside the overlap [80,100] of windows
    // [0,100] and [80,180], so both chunks see it.
    const content = "A".repeat(85) + "MARKER" + "B".repeat(200);
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider: markerProvider("MARKER"),
      chunkSize: 100,
      chunkOverlap: 20,
    });
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].provenance.locator, "chars:85-91");
    assert.ok(result.warnings?.some((w) => /dropped 1 duplicate proposal \(same field \+ value \+ source span\)/.test(w)));
  });

  it("keeps two distinct records that share a value but come from different spans", async () => {
    // Two cards with the SAME title text at DIFFERENT offsets must both survive:
    // dedup keys on the verified source span, not the value alone.
    const content = "Alpha Program here. Then later, Alpha Program again.";
    const first = content.indexOf("Alpha Program");
    const second = content.indexOf("Alpha Program", first + 1);
    assert.ok(second > first, "value genuinely repeats at two spans");

    const provider: ExtractionProvider = {
      name: "two-span-mock",
      async extract(input): Promise<ProviderExtractionOutput> {
        // propose the same value grounded at each occurrence's excerpt
        return {
          proposals: [
            {
              fieldPath: "title",
              candidateValue: "Alpha Program",
              confidence: 0.7,
              provenance: { excerpt: "Alpha Program here", locator: "provisional" },
              extractor: "two-span-mock",
            },
            {
              fieldPath: "title",
              candidateValue: "Alpha Program",
              confidence: 0.7,
              provenance: { excerpt: "Alpha Program again", locator: "provisional" },
              extractor: "two-span-mock",
            },
          ],
          raw: { response: "{}", model: "mock" },
        };
      },
    };

    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 2, "both distinct-span records survive");
    assert.ok(!result.warnings?.some((w) => /duplicate/.test(w)));
  });

  it("overlap rescues a value straddling a hard window boundary (not lost, not duplicated)", async () => {
    // "MARKER" at 96..102 straddles boundary 100: with no overlap it would split
    // across [0,100] and [100,200] and be lost; overlap 20 makes window [80,180]
    // contain it whole, exactly once.
    const content = "A".repeat(96) + "MARKER" + "B".repeat(120);
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider: markerProvider("MARKER"),
      chunkSize: 100,
      chunkOverlap: 20,
    });
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].provenance.locator, "chars:96-102");
    assert.ok(!result.warnings?.some((w) => /duplicate/.test(w)));
  });

  it("a proposal that throws during normalization does not discard earlier chunks' results", async () => {
    // The provider "succeeds" on every chunk, but on the 2nd chunk it returns a
    // proposal whose fieldPath getter throws. Earlier collected proposals must
    // survive (partial-results guarantee), and extract() must not throw or error.
    let call = 0;
    const provider: ExtractionProvider = {
      name: "throwing-getter-mock",
      async extract(input): Promise<ProviderExtractionOutput> {
        call++;
        if (call === 2) {
          const booby = {
            get fieldPath(): string {
              throw new Error("boom in getter");
            },
            candidateValue: "x",
            confidence: 0.9,
            provenance: { excerpt: "x", locator: "provisional" },
            extractor: "throwing-getter-mock",
          };
          return { proposals: [booby as never], raw: { response: "{}", model: "mock" } };
        }
        const proposals = [];
        const re = /Program \d+ Alpha/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(input.content)) !== null) {
          proposals.push({
            fieldPath: "title",
            candidateValue: m[0],
            confidence: 0.9,
            provenance: { excerpt: m[0], locator: "provisional" },
            extractor: "throwing-getter-mock",
          });
        }
        return { proposals, raw: { response: "{}", model: "mock" } };
      },
    };

    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: 400,
    });
    assert.equal(result.error, undefined);
    assert.ok(result.proposals.length > 0, "earlier chunks' proposals survived");
    assert.ok(result.warnings?.some((w) => /chunk 2\/\d+ normalization failed: boom in getter/.test(w)));
  });

  it("a provider error on one chunk does not kill the others (partial results + warning)", async () => {
    const provider = createRegexScanProvider({ throwOnCall: 2 });
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: 400,
    });
    // not fatal: the surviving chunks still produced proposals
    assert.equal(result.error, undefined);
    assert.ok(result.proposals.length > 0, "surviving chunks produced proposals");
    assert.ok(result.proposals.length < 12, "the failed chunk's cards are missing");
    assert.ok(
      result.warnings?.some((w) => /chunk 2\/\d+ provider call failed: boom on call 2/.test(w)),
    );
  });
});

describe("prepareAndChunk (structural) keeps content outside the card container", () => {
  // A detail page whose own text sits beside a short repeated list: the list is
  // detected as cards, but the fee paragraph is neither a card nor chrome.
  const detailHtml = `<!DOCTYPE html><html><body>
<h1>Riverside Clinic</h1>
<main>
  <section><p>Annual enrollment fee: $4,250 per participant.</p><p>Contact: registrar@example.org</p></section>
  <section><ul><li>Parking available</li><li>Wheelchair accessible</li><li>Open weekends</li><li>Snacks provided</li></ul></section>
  <section><p>Office hours: weekdays 9 to 5.</p></section>
</main></body></html>`;
  const feeSentence = "Annual enrollment fee: $4,250 per participant.";

  it("keeps a detail page's non-card text in fullText, in document order", () => {
    const r = prepareAndChunk(detailHtml, "html");
    assert.equal(r.structural, true);
    assert.equal(r.cardCount, 4);
    const at = (text: string) => r.fullText.indexOf(text);
    assert.ok(at(feeSentence) >= 0, r.fullText);
    assert.ok(at("Office hours: weekdays 9 to 5.") >= 0, r.fullText);
    assert.ok(at("# Riverside Clinic") < at(feeSentence));
    assert.ok(at(feeSentence) < at("Parking available"));
    assert.ok(at("Snacks provided") < at("Office hours"));
    assert.ok(r.chunks.every((c) => r.fullText.slice(c.start, c.end) === c.text));
    assert.deepEqual(r.warnings, []);
  });

  it("lets a proposal grounded in non-card text survive extract()", async () => {
    const result = await extract({
      content: detailHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider: markerProvider(feeSentence),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.proposals.length, 1, JSON.stringify(result.warnings));
    const prepared = prepareAndChunk(detailHtml, "html");
    const start = prepared.fullText.indexOf(feeSentence);
    assert.equal(result.proposals[0].provenance.locator, `chars:${start}-${start + feeSentence.length}`);
  });

  it("windows outside text longer than one chunk, with every chunk re-slicing fullText", () => {
    // Two long paragraphs: too few to be detected as cards themselves.
    const sentences = (p: number) => Array.from({ length: 15 }, (_, i) => `Intro paragraph ${p * 15 + i} about the program.`).join(" ");
    const intro = `<p class="lead">${sentences(0)}</p><p>${sentences(1)}</p>`;
    const html = `<html><body><main><section>${intro}</section><div class="list">${
      [1, 2, 3, 4].map((i) => `<div class="card">Card ${i}</div>`).join("")
    }</div></main></body></html>`;
    const r = prepareAndChunk(html, "html", { chunkSize: 200, chunkOverlap: 20 });
    assert.equal(r.structural, true);
    for (let i = 0; i < 30; i++) assert.ok(r.fullText.includes(`Intro paragraph ${i} about`), `paragraph ${i}`);
    assert.ok(r.chunks.every((c) => r.fullText.slice(c.start, c.end) === c.text));
    assert.ok(r.chunks.every((c) => c.text.length <= 200));
    // Card chunks follow the windowed intro, and no card is split.
    assert.ok(r.chunks.some((c) => c.text.includes("Card 1") && c.text.includes("Card 4")));
  });

  it("leaves a cards-only page's chunk boundaries unchanged", () => {
    const card = (i: number) =>
      `<article class="card"><h2>Item ${i}</h2><p>Price: $${i}0 per session. A description of item ${i} with some words.</p></article>`;
    const html = `<!DOCTYPE html><html><body><nav><a href="/">Home</a></nav><main><section class="results">${
      [1, 2, 3, 4, 5, 6, 7, 8].map(card).join("")
    }</section></main><footer>f</footer></body></html>`;
    // Boundaries recorded from the release before non-card content was kept.
    const expected: Record<number, Array<[number, number]>> = {
      100: [[0, 75], [77, 152], [154, 229], [231, 306], [308, 383], [385, 460], [462, 537], [539, 614]],
      200: [[0, 152], [154, 306], [308, 460], [462, 614]],
      400: [[0, 383], [385, 614]],
    };
    for (const [size, bounds] of Object.entries(expected)) {
      const r = prepareAndChunk(html, "html", { chunkSize: Number(size) });
      assert.equal(r.structural, true);
      assert.deepEqual(r.chunks.map((c) => [c.start, c.end]), bounds, `chunkSize ${size}`);
    }
  });
});

describe("structural page text outside the container cannot starve the cards", () => {
  const card = (i: number) =>
    `<div class="listing"><h3>Camp ${String(i).padStart(2, "0")} Bravo</h3><p>Weekly fee: $${i}00. Ages 8 to 12, outdoor program with lunch included.</p><a href="https://example.test/camp/${i}">Details</a></div>`;
  const cards = Array.from({ length: 20 }, (_, i) => card(i + 1)).join("");
  // A div-based mega-menu: no nav/header element for the tag pruning to catch.
  const megaMenu = `<div class="navbar"><div class="mega">${
    Array.from({ length: 12 }, (_, g) => `<div class="col"><span>Group ${g}</span><ul>${
      Array.from({ length: 10 }, (_, k) => `<li><a href="https://example.test/c/${g}/${k}">Category ${g}-${k} programs</a></li>`).join("")
    }</ul></div>`).join("")
  }</div></div>`;
  const cookieBanner = `<div class="consent"><p>${"We use cookies to measure visits and remember your settings. ".repeat(40)}</p><button>Accept</button></div>`;
  const page = (outside: string) =>
    `<!DOCTYPE html><html><body>${outside}<main><h1>Summer Camps</h1><section class="results">${cards}</section></main></body></html>`;
  const titles = Array.from({ length: 20 }, (_, i) => `Camp ${String(i + 1).padStart(2, "0")} Bravo`);

  function recordingProvider(): ExtractionProvider & { seen: string[] } {
    const seen: string[] = [];
    return {
      name: "recording-mock",
      seen,
      async extract(input): Promise<ProviderExtractionOutput> {
        seen.push(input.content);
        return { proposals: [], raw: { response: "{}", model: "mock" } };
      },
    };
  }
  const reached = (seen: string[]) => titles.filter((title) => seen.some((content) => content.includes(title)));

  it("prunes a div mega-menu and sends every card under a tight maxChunks", async () => {
    const provider = recordingProvider();
    const result = await extract({
      content: page(megaMenu), contentType: "html", sourceRef: "ref", targetSchema: genericTargetSchema,
      provider, chunkSize: 2000, maxChunks: 3,
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(reached(provider.seen), titles);
    assert.ok(provider.seen.every((content) => !content.includes("Category 3-4 programs")), "mega-menu links pruned");
    assert.ok(provider.seen[0].startsWith("# Summer Camps"), "page title still rides with the first card batch");
  });

  it("sends card chunks before long outside text, and names outside text left out by maxChunks", async () => {
    const provider = recordingProvider();
    const html = page(cookieBanner);
    const cardOnly = prepareAndChunk(page(""), "html", { chunkSize: 2000 });
    const result = await extract({
      content: html, contentType: "html", sourceRef: "ref", targetSchema: genericTargetSchema,
      provider, chunkSize: 2000, maxChunks: cardOnly.chunks.length,
    });
    assert.deepEqual(reached(provider.seen), titles);
    assert.ok(provider.seen.every((content) => !content.includes("We use cookies")), "banner chunks were the ones left out");
    assert.ok(
      result.warnings?.some((w) => /^structural prep: \d+ chunks? of page text outside the card container \(\d+ chars\) left out beyond maxChunks/.test(w)),
      JSON.stringify(result.warnings),
    );

    const full = prepareAndChunk(html, "html", { chunkSize: 2000 });
    const firstOutside = full.chunks.findIndex((c) => c.text.includes("We use cookies"));
    assert.ok(firstOutside >= cardOnly.chunks.length, "outside chunks are ordered after every card chunk");
    assert.ok(full.chunks.every((c) => full.fullText.slice(c.start, c.end) === c.text));

    const capped = recordingProvider();
    await extract({
      content: html, contentType: "html", sourceRef: "ref", targetSchema: genericTargetSchema,
      provider: capped, chunkSize: 2000, maxProviderCalls: cardOnly.chunks.length,
    });
    assert.deepEqual(reached(capped.seen), titles);
  });
});
