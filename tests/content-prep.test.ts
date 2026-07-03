import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { htmlToText, prepareContent, preparePdfText, resolvePdfPage } from "../src/content-prep.js";
import type { PdfExtractedText, PdfTextExtractor } from "../src/types.js";

const fixtureUrl = new URL("../../tests/fixtures/generic-activity-page.html", import.meta.url);
const fixtureHtml = readFileSync(fixtureUrl, "utf8");

describe("htmlToText", () => {
  it("strips script/style/nav/header/footer noise but keeps body content", () => {
    const text = htmlToText(fixtureHtml);

    // Content survives.
    assert.match(text, /Beginner Bouldering Session/);
    assert.match(text, /\$24 per person/);
    assert.match(text, /Tuesday and Thursday/);

    // Noise is gone.
    assert.doesNotMatch(text, /window\.analytics/);
    assert.doesNotMatch(text, /footer widget loaded/);
    assert.doesNotMatch(text, /font-family/);
    assert.doesNotMatch(text, /All rights reserved/);
    assert.doesNotMatch(text, /Climb higher, every week/);

    // No residual tags.
    assert.doesNotMatch(text, /</);
    assert.doesNotMatch(text, />/);
  });

  it("decodes common entities", () => {
    const text = htmlToText("<p>Shoes &amp; chalk 6:00pm&ndash;7:30pm &lt;ok&gt;</p>");
    assert.match(text, /Shoes & chalk/);
    assert.match(text, /6:00pm–7:30pm/);
    assert.match(text, /<ok>/);
  });

  it("decodes typographic entities (dashes, smart quotes, ellipsis) and nbsp variants", () => {
    const text = htmlToText(
      "<p>Coach&rsquo;s note&mdash;&ldquo;bring&nbsp;chalk&rdquo;&hellip; details&#160;below&#xA0;here&#39;s more.</p>",
    );
    assert.match(text, /Coach’s note/);
    assert.match(text, /—/); // &mdash;
    assert.match(text, /“bring/); // &ldquo;
    assert.match(text, /chalk”/); // &nbsp; between "bring" and "chalk", &rdquo; after
    assert.match(text, /details below here/); // &#160; and &#xA0; both decode to a space
    assert.match(text, /…/); // &hellip;
    assert.match(text, /here's more/); // &#39;
    // No raw entity markers survive.
    assert.doesNotMatch(text, /&\w+;/);
    assert.doesNotMatch(text, /&#/);
  });

  it("truncates to maxChars", () => {
    const text = htmlToText("<p>" + "a".repeat(500) + "</p>", 100);
    assert.equal(text.length, 100);
  });
});

describe("prepareContent", () => {
  it("prepares html as markdown by default (structure-preserving), preserving headings", () => {
    const { text, error } = prepareContent(fixtureHtml, "html");
    assert.equal(error, undefined);
    assert.match(text ?? "", /Beginner Bouldering Session/);
    // Default flipped to markdown in 0.5.0: the <h1> survives as an ATX heading
    // rather than being flattened to a bare line.
    assert.match(text ?? "", /^# Beginner Bouldering Session/m);
  });

  it("honors prep:'text' as the legacy regex-strip escape hatch (no markdown syntax)", () => {
    const { text, error } = prepareContent(fixtureHtml, "html", 32_000, "text");
    assert.equal(error, undefined);
    assert.match(text ?? "", /Beginner Bouldering Session/);
    assert.doesNotMatch(text ?? "", /^#/m);
  });

  it("passes text through, truncating only", () => {
    const { text, error } = prepareContent("plain text body " + "x".repeat(50), "text", 20);
    assert.equal(error, undefined);
    assert.equal(text?.length, 20);
    assert.equal(text, "plain text body xxxx");
  });

  it("defers pdf with a typed error and never throws", () => {
    const result = prepareContent(new Uint8Array([1, 2, 3]), "pdf");
    assert.equal(result.text, undefined);
    assert.match(result.error ?? "", /not implemented/);
  });

  it("rejects binary input for non-pdf types with an error, not a throw", () => {
    const result = prepareContent(new Uint8Array([1, 2, 3]), "html");
    assert.equal(result.text, undefined);
    assert.match(result.error ?? "", /binary content is not supported/);
  });

  it("never throws on pathological HTML: degrades the markdown default to text", () => {
    // Deeply nested markup can overflow the DOM/Turndown recursion; prepareContent
    // must degrade to the regex text strip rather than propagating the throw.
    const deep = "<div>".repeat(40_000) + "needle" + "</div>".repeat(40_000);
    let result: ReturnType<typeof prepareContent> | undefined;
    assert.doesNotThrow(() => {
      result = prepareContent(deep, "html");
    });
    assert.equal(result?.error, undefined);
    assert.match(result?.text ?? "", /needle/);
  });
});

// preparePdfText / resolvePdfPage — unit coverage using a simple inline mock
// PdfTextExtractor (NOT the tests/fixtures/naive-pdf-text-extractor.ts fixture
// double, which is reserved for the real-fixture end-to-end tests in
// tests/pdf-content-prep.test.ts). Supports AC3, AC5.
describe("preparePdfText", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  function extractorReturning(result: PdfExtractedText): PdfTextExtractor {
    return { extract: () => result };
  }

  it("happy path: returns the extractor's text, pageOffsets, and warnings unchanged", async () => {
    const extractor = extractorReturning({
      text: "Section One\nSection Two\n",
      pageOffsets: [0, 12],
      warnings: ["extractor note"],
    });
    const result = await preparePdfText(bytes, extractor);
    assert.equal(result.error, undefined);
    assert.equal(result.text, "Section One\nSection Two\n");
    assert.deepEqual(result.pageOffsets, [0, 12]);
    assert.deepEqual(result.warnings, ["extractor note"]);
  });

  it("maxChars truncates text and keeps pageOffsets that still fit within the truncated length", async () => {
    const extractor = extractorReturning({ text: "abcdefghij", pageOffsets: [0, 5] });
    const result = await preparePdfText(bytes, extractor, 8);
    assert.equal(result.text, "abcdefgh");
    assert.equal(result.text.length, 8);
    assert.deepEqual(result.pageOffsets, [0, 5]);
    assert.deepEqual(result.warnings, []);
  });

  it("maxChars truncation that pushes a pageOffsets entry out of range drops the WHOLE array with a warning", async () => {
    // pageOffsets[1] === 12 falls outside the truncated text (length 10), so
    // the whole array is dropped ("dropped, never silently trusted" —
    // validatePageOffsets checks shape against the POST-truncation length).
    const extractor = extractorReturning({ text: "Section One\nSection Two\n", pageOffsets: [0, 12] });
    const result = await preparePdfText(bytes, extractor, 10);
    assert.equal(result.text, "Section On");
    assert.equal(result.text.length, 10);
    assert.equal(result.pageOffsets, undefined);
    assert.ok(
      result.warnings.some((w) => /dropped pdfPageOffsets/.test(w)),
      `expected a dropped-pageOffsets warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("drops descending (non-ascending) pageOffsets with a warning, text still returned", async () => {
    const extractor = extractorReturning({ text: "abcdef", pageOffsets: [5, 2] });
    const result = await preparePdfText(bytes, extractor);
    assert.equal(result.text, "abcdef");
    assert.equal(result.pageOffsets, undefined);
    assert.ok(result.warnings.some((w) => /dropped pdfPageOffsets/.test(w)));
  });

  it("drops out-of-range (negative) pageOffsets with a warning, text still returned", async () => {
    const extractor = extractorReturning({ text: "abcdef", pageOffsets: [-1, 3] });
    const result = await preparePdfText(bytes, extractor);
    assert.equal(result.text, "abcdef");
    assert.equal(result.pageOffsets, undefined);
    assert.ok(result.warnings.some((w) => /dropped pdfPageOffsets/.test(w)));
  });

  it("drops non-finite pageOffsets entries with a warning, text still returned", async () => {
    const extractor = extractorReturning({ text: "abcdef", pageOffsets: [0, NaN] });
    const result = await preparePdfText(bytes, extractor);
    assert.equal(result.text, "abcdef");
    assert.equal(result.pageOffsets, undefined);
    assert.ok(result.warnings.some((w) => /dropped pdfPageOffsets/.test(w)));
  });

  it("drops a non-array `warnings` value (e.g. a bare string) with a warning, instead of silently spreading it into one-char entries", async () => {
    // A misbehaving extractor returning warnings: "some string" would, absent
    // the shape guard, spread via [...("abc")] into ["a","b","c"]. Assert
    // that never happens: the malformed value is dropped wholesale and
    // replaced with a single descriptive warning, mirroring the
    // pageOffsets "dropped, never silently trusted" posture.
    const extractor = { extract: () => ({ text: "abcdef", warnings: "some string" }) } as unknown as PdfTextExtractor;
    const result = await preparePdfText(bytes, extractor);
    assert.equal(result.text, "abcdef");
    assert.equal(result.error, undefined);
    assert.deepEqual(result.warnings, ["dropped extractor-reported warnings: not an array of strings"]);
    // No corrupted one-character entries anywhere in the result.
    assert.ok(!result.warnings.some((w) => w.length === 1));
  });

  it("an extractor that throws synchronously surfaces as a typed error, never propagates", async () => {
    const extractor: PdfTextExtractor = {
      extract: () => {
        throw new Error("boom");
      },
    };
    const result = await preparePdfText(bytes, extractor);
    assert.equal(result.text, "");
    assert.equal(result.error, "pdf text extraction failed: boom");
    assert.deepEqual(result.warnings, []);
  });

  it("an extractor that returns a rejected Promise surfaces as the same typed error shape, never an uncaught rejection", async () => {
    const extractor: PdfTextExtractor = { extract: () => Promise.reject(new Error("network down")) };
    const result = await preparePdfText(bytes, extractor);
    assert.equal(result.text, "");
    assert.equal(result.error, "pdf text extraction failed: network down");
  });

  it("an extractor returning a non-string text produces a typed error, not a crash", async () => {
    const extractor = { extract: () => ({ text: 123 }) } as unknown as PdfTextExtractor;
    const result = await preparePdfText(bytes, extractor);
    assert.equal(result.text, "");
    assert.equal(result.error, "pdf text extraction failed: extractor returned no text");
  });
});

describe("resolvePdfPage", () => {
  it("offset 0 resolves to page 1 when pageOffsets[0] === 0", () => {
    assert.equal(resolvePdfPage([0, 27], 0), 1);
  });

  it("an offset exactly at a later page's boundary resolves to that later page", () => {
    assert.equal(resolvePdfPage([0, 27, 54], 27), 2);
    assert.equal(resolvePdfPage([0, 27, 54], 54), 3);
  });

  it("an offset past every entry resolves to the last page", () => {
    assert.equal(resolvePdfPage([0, 27, 54], 1_000), 3);
  });

  it("returns undefined for empty or undefined pageOffsets", () => {
    assert.equal(resolvePdfPage(undefined, 5), undefined);
    assert.equal(resolvePdfPage([], 5), undefined);
  });

  it("returns undefined for a negative offset", () => {
    assert.equal(resolvePdfPage([0, 27], -1), undefined);
  });
});
