import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract, htmlToMarkdown, prepareAndChunk, prepareContent, serializePortableExtractionResult } from "../src/index.js";
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

describe("markdown prep keeps an article's own header/footer/aside, and names all page chrome it prunes", () => {
  const chromeWarnings = (warnings: string[] = []) => warnings.filter((w) => w.startsWith("markdown prep pruned "));
  const articlePage = `<!DOCTYPE html><html><body><header><p>Site banner text</p></header><article><header><h1>Engineer</h1><p>Salary $180k–$220k</p></header><p>Body text about the role.</p><footer><p>Posted 2026-09-01</p></footer></article></body></html>`;

  it("keeps an article's header and footer on the whole-page path, and names the page header it pruned", () => {
    const r = prepareAndChunk(articlePage, "html");
    assert.equal(r.structural, false);
    assert.ok(r.fullText.includes("Salary $180k–$220k"), r.fullText);
    assert.ok(r.fullText.includes("Posted 2026-09-01"), r.fullText);
    assert.ok(!r.fullText.includes("Site banner text"), r.fullText);
    assert.deepEqual(chromeWarnings(r.warnings), ['markdown prep pruned 1 page-chrome element (16 chars): "Site banner text"']);
  });

  for (const tag of ["header", "footer", "aside"]) {
    it(`keeps a <${tag}> inside <article>`, () => {
      const r = prepareAndChunk(`<!DOCTYPE html><html><body><main><article><${tag}><p>Fee $40 per class</p></${tag}><p>Main body.</p></article></main></body></html>`, "html");
      assert.ok(r.fullText.includes("Fee $40 per class"), r.fullText);
      assert.deepEqual(chromeWarnings(r.warnings), []);
    });

    it(`removes and names a <${tag}> inside <main> but outside any article`, () => {
      const r = prepareAndChunk(`<!DOCTYPE html><html><body><main><${tag}><p>Related $99 offer</p></${tag}><p>Main body.</p></main></body></html>`, "html");
      assert.ok(!r.fullText.includes("Related $99 offer"), r.fullText);
      assert.deepEqual(chromeWarnings(r.warnings), ['markdown prep pruned 1 page-chrome element (17 chars): "Related $99 offer"']);
    });
  }

  it("removes and names a <form> even inside an article", () => {
    const r = prepareAndChunk(`<!DOCTYPE html><html><body><article><p>Role body.</p><form><p>Subscribe for alerts</p><button>Go</button></form></article></body></html>`, "html");
    assert.ok(!r.fullText.includes("Subscribe for alerts"), r.fullText);
    assert.deepEqual(chromeWarnings(r.warnings), ['markdown prep pruned 1 page-chrome element (22 chars): "Subscribe for alertsGo"']);
  });

  it("names noscript text it removes", () => {
    const r = prepareAndChunk(`<!DOCTYPE html><html><body><noscript>Enable scripts to see prices</noscript><p>Body.</p></body></html>`, "html");
    assert.deepEqual(chromeWarnings(r.warnings), ['markdown prep pruned 1 page-chrome element (28 chars): "Enable scripts to see prices"']);
  });

  it("keeps a header inside a card whose article is outside the card, although each card is converted on its own", () => {
    const cardsWithHeaders = Array.from({ length: 4 }, (_, i) =>
      `<div class="card"><header><h3>Role ${i + 1}</h3><p>Pay $${i + 1}00</p></header><p>Details ${i + 1}.</p></div>`).join("");
    const r = prepareAndChunk(`<!DOCTYPE html><html><body><article><section>${cardsWithHeaders}</section></article></body></html>`, "html");
    assert.equal(r.structural, true);
    for (let i = 1; i <= 4; i++) assert.ok(r.fullText.includes(`Pay $${i}00`), r.fullText);
  });

  it("names pruned nav, page header and footer on the structural path too", () => {
    const r = prepareAndChunk(`<!DOCTYPE html><html><body><nav>Home Products</nav><h1>T</h1><ul class="list">${cards}</ul><footer>Copyright line</footer></body></html>`, "html");
    assert.equal(r.structural, true);
    assert.deepEqual(chromeWarnings(r.warnings), ['markdown prep pruned 2 page-chrome elements (27 chars): "Home Products", "Copyright line"']);
  });

  it("does not warn for scripts and styles, which hold no page text", () => {
    const r = prepareAndChunk(`<!DOCTYPE html><html><body><script>var x = 1;</script><style>p{}</style><p>Body.</p></body></html>`, "html");
    assert.deepEqual(chromeWarnings(r.warnings), []);
  });

  it("prepareContent and htmlToMarkdown apply the same rule", () => {
    const prepared = prepareContent(articlePage, "html");
    assert.ok(prepared.text?.includes("Salary $180k–$220k"), String(prepared.text));
    assert.deepEqual(chromeWarnings(prepared.warnings), ['markdown prep pruned 1 page-chrome element (16 chars): "Site banner text"']);
    assert.ok(htmlToMarkdown(articlePage).includes("Salary $180k–$220k"));
  });

  it("a bodyless fragment converted by Turndown directly keeps an article's header only", () => {
    assert.ok(htmlToMarkdown(`<article><header><p>Salary $90k</p></header><p>Role.</p></article>`).includes("Salary $90k"));
    assert.ok(!htmlToMarkdown(`<main><header><p>Breadcrumbs</p></header><p>Role.</p></main>`).includes("Breadcrumbs"));
    assert.ok(!htmlToMarkdown(`<header><p>Site banner</p></header><p>Role.</p>`).includes("Site banner"));
  });

  it("a realistic job page keeps the article and names the in-main chrome it drops", () => {
    const article = `<h1>Senior Engineer</h1><p>Salary $180k–$220k. Remote.</p>` + "<p>Role body paragraph.</p>".repeat(5);
    const related = `<footer><h3>Related jobs</h3><ul>${Array.from({ length: 10 }, (_, i) => `<li><a href="/j${i}">Job ${i} — $${100 + i}k</a></li>`).join("")}</ul></footer>`;
    const page = `<html><body><main><header><p>Breadcrumbs: Home / Jobs</p></header><form><p>We use cookies.</p><button>Accept</button></form>${article}<aside><p>Newsletter signup</p></aside>${related}</main></body></html>`;
    const prepared = prepareContent(page, "html", 1_000_000);
    const alone = prepareContent(`<html><body><main>${article}</main></body></html>`, "html", 1_000_000);
    assert.equal(prepared.text, alone.text, "only the article's own text is left");
    const [warning] = chromeWarnings(prepared.warnings);
    assert.match(warning, /^markdown prep pruned 4 page-chrome elements \(\d+ chars\): "Breadcrumbs: Home \/ Jobs", "Related jobsJob 0 — \$100k.*…", "Newsletter signup", "We use cookies\.Accept"$/);
  });

  it("classifies the chrome warning on the envelope as navigation-pruned", async () => {
    const provider: ExtractionProvider = { name: "p", async extract() { return { proposals: [], raw: { response: "", model: "m" } }; } };
    const result = await extract({ sourceRef: "s", contentType: "html", targetSchema: [{ path: "title", type: "string" }], provider, content: articlePage });
    const envelope = JSON.parse(serializePortableExtractionResult(result));
    assert.deepEqual(envelope.result.warningClassifications, [{ category: "preparation", code: "navigation-pruned" }]);
  });
});
