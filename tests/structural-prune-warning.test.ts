import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract, prepareAndChunk, serializePortableExtractionResult } from "../src/index.js";
import type { ExtractionProvider, TargetFieldSchema } from "../src/index.js";

// Structural prep prunes navigation-like blocks from the page text outside the
// card container. Content must never go silently: blocks that hold content are
// kept, and anything pruned is named in a warning.

const cards = Array.from({ length: 4 }, (_, i) =>
  `<li class="item"><h3>Program ${i + 1}</h3><p>Weekly session with an instructor, number ${i + 1}.</p></li>`).join("");
const page = (outside: string) =>
  `<!DOCTYPE html><html><body><h1>Riverside Center</h1>${outside}<ul class="list">${cards}</ul></body></html>`;

function prepared(outside: string) {
  const r = prepareAndChunk(page(outside), "html");
  assert.equal(r.structural, true, "the fixture must take the structural path");
  return r;
}
const pruneWarnings = (warnings: string[]) => warnings.filter((w) => w.startsWith("structural prep pruned "));

describe("structural prep keeps content outside the card container, or names what it pruned", () => {
  it("names a linked 'Locations' line it prunes", () => {
    const r = prepared(`<p>Locations: <a href="/austin">Austin</a>, <a href="/denver">Denver</a>, <a href="/boston">Boston</a></p>`);
    // Still pruned as link-dense, but no longer silently.
    assert.ok(!r.fullText.includes("Denver"), r.fullText);
    assert.deepEqual(pruneWarnings(r.warnings), [
      'structural prep pruned 1 navigation-like block outside the card container (33 chars): "Locations: Austin, Denver, Boston"',
    ]);
  });

  it("keeps a contact block of tel/mailto links: contact values are not navigation", () => {
    const r = prepared(`<div class="contact"><a href="tel:+15550100">555-0100</a> <a href="mailto:office@example.org">office@example.org</a> <a href="https://example.org">example.org</a></div>`);
    assert.ok(r.fullText.includes("555-0100") && r.fullText.includes("office@example.org"), r.fullText);
    assert.deepEqual(pruneWarnings(r.warnings), []);
  });

  it("keeps a price box whose actions are call and email links", () => {
    const r = prepared(`<div class="price"><p>$1,250/mo</p><a href="tel:+15550100">Call</a> <a href="mailto:leasing@example.org">Email</a> <a href="/tour">Tour</a></div>`);
    assert.ok(r.fullText.includes("$1,250/mo"), r.fullText);
    assert.deepEqual(pruneWarnings(r.warnings), []);
  });

  it("names an 'Offices' list of linked cities, heading included, when it prunes it", () => {
    const r = prepared(`<div class="offices"><h4>Offices</h4><ul><li><a href="/o/1">Austin</a></li><li><a href="/o/2">Denver</a></li><li><a href="/o/3">Boston</a></li></ul></div>`);
    assert.ok(!r.fullText.includes("Denver"), r.fullText);
    const [warning, ...rest] = pruneWarnings(r.warnings);
    assert.deepEqual(rest, []);
    assert.match(warning ?? "", /\(\d+ chars\): .*"AustinDenverBoston"/);
    assert.match(warning ?? "", /"Offices"/, "the heading left behind is named too");
  });

  it("keeps a banner-role block inside an article: the landmark is scoped to content", () => {
    const r = prepared(`<article><div role="banner"><p>Salary $180k–$220k</p></div><p>Full-time role.</p></article>`);
    assert.ok(r.fullText.includes("Salary $180k–$220k"), r.fullText);
    assert.deepEqual(pruneWarnings(r.warnings), []);
  });

  for (const role of ["navigation", "banner", "contentinfo"]) {
    it(`prunes a role="${role}" landmark outside content and names it`, () => {
      // No links, so only the landmark rule can remove it.
      const r = prepared(`<div role="${role}">Landmark block text</div><p>Open daily from nine.</p>`);
      assert.ok(!r.fullText.includes("Landmark block text"), r.fullText);
      assert.ok(r.fullText.includes("Open daily from nine."), r.fullText);
      assert.deepEqual(pruneWarnings(r.warnings), [
        'structural prep pruned 1 navigation-like block outside the card container (19 chars): "Landmark block text"',
      ]);
    });
  }

  it("quotes at most five blocks, each cut to 60 characters", () => {
    // Distinct classes, so the blocks are not mistaken for a card list.
    const blocks = Array.from({ length: 7 }, (_, i) => `<div class="n${i}" role="navigation">Block ${i} ${"z".repeat(80)}</div>`).join("");
    const [warning] = pruneWarnings(prepared(blocks).warnings);
    assert.match(warning, /^structural prep pruned 7 navigation-like blocks outside the card container \(\d+ chars\): /);
    assert.equal((warning.match(/"Block \d z+…"/g) ?? []).length, 5);
    assert.match(warning, /, and 2 more$/);
  });

  it("classifies the warning on the envelope as a preparation warning", async () => {
    const provider: ExtractionProvider = { name: "p", async extract() { return { proposals: [], raw: { response: "", model: "m" } }; } };
    const targetSchema: TargetFieldSchema[] = [{ path: "title", type: "string" }];
    const result = await extract({
      sourceRef: "s", contentType: "html", targetSchema, provider,
      content: page(`<div role="navigation">Landmark block text</div>`),
    });
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.deepEqual(envelope.result.warningClassifications, [{ category: "preparation", code: "navigation-pruned" }]);
  });
});
