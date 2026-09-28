import { readFileSync } from "node:fs";
import type { ContentType, PrepMode } from "../../src/index.js";

// Fixed inputs whose prepared-text digests are pinned in
// preparation-goldens.json (see tests/preparation-version.test.ts).

const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");

// Text Turndown escapes (emphasis, list and heading markers, brackets) and
// elements whose Markdown depends on its options (`emDelimiter`,
// `bulletListMarker`, `headingStyle`), so a change to any of them moves the
// HTML digests.
export const detailHtml = `<!DOCTYPE html><html><body><h1>Riverside Clinic</h1><main>
<section><p>Annual enrollment fee: $4,250 per participant.</p>
<p>1. Bring *two* forms_of ID [original] # not a heading</p>
<p>Arrive <em>early</em> and <strong>bring water</strong>.</p></section>
<section><ul><li>Parking available</li><li>Wheelchair accessible</li><li>Open weekends</li></ul></section>
</main></body></html>`;

// Page chrome inside and outside an article: the article's own header and
// footer are kept; a header, aside and form inside main but outside the
// article, a noscript, and the page nav/footer are removed.
export const chromeHtml = `<!DOCTYPE html><html><body><nav><a href="/">Home</a></nav><main>
<header><p>Breadcrumbs: Home / Roles</p></header>
<form><p>Accept cookies</p><button>OK</button></form>
<article><header><h1>Field Technician</h1><p>Pay: $31 per hour</p></header>
<p>Full-time role at the north depot.</p><footer><p>Posted 2026-09-01</p></footer></article>
<aside><p>Related roles: $28 per hour</p></aside><noscript>Enable scripts</noscript>
</main><footer>Site footer</footer></body></html>`;

export const preparationInputs: Record<string, { content: string; contentType: ContentType; prep?: PrepMode }> = {
  "html-listing": { content: fixture("repeated-cards-page.html"), contentType: "html" },
  "html-detail": { content: detailHtml, contentType: "html" },
  "html-as-text": { content: detailHtml, contentType: "html", prep: "text" },
  "html-chrome": { content: chromeHtml, contentType: "html" },
  transcript: { content: fixture("auto-captions.vtt"), contentType: "transcript" },
  text: { content: "Title: Alpine Hut\nFee: 1. *Twenty* dollars_per night", contentType: "text" },
};
