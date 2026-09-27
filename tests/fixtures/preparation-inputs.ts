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

export const preparationInputs: Record<string, { content: string; contentType: ContentType; prep?: PrepMode }> = {
  "html-listing": { content: fixture("repeated-cards-page.html"), contentType: "html" },
  "html-detail": { content: detailHtml, contentType: "html" },
  "html-as-text": { content: detailHtml, contentType: "html", prep: "text" },
  transcript: { content: fixture("auto-captions.vtt"), contentType: "transcript" },
  text: { content: "Title: Alpine Hut\nFee: 1. *Twenty* dollars_per night", contentType: "text" },
};
