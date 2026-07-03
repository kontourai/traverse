#!/usr/bin/env node
"use strict";

// check-decisions.cjs — validator + index generator for the topic-keyed
// decision registry (context/contracts/decision-registry-contract.md in
// kontourai/flow-agents).
//
// VENDORED from kontourai/flow-agents at commit
// 0bd4e0ba593480c1e11988d2f9257082a3f06b4a (scripts/check-decisions.cjs),
// which is the source of truth for the decision-registry contract, PR
// https://github.com/kontourai/flow-agents/pull/316. Vendored unchanged (aside
// from this header and the schema-path comment two lines below, which is
// updated to this repo's vendored copy path) for traverse's ADR
// freeze-and-index pilot, issue
// https://github.com/kontourai/flow-agents/issues/314. Do not hand-edit the
// validation/generation logic below; re-vendor from flow-agents if the
// upstream validator changes.
//
// Usage:
//   node scripts/check-decisions.cjs check        # validate all topic files + assert index is current (default)
//   node scripts/check-decisions.cjs gen-index    # (re)write docs/decisions/index.md deterministically
//
// Zero runtime dependencies (mirrors scripts/check-content-boundary.cjs): the
// decision-record JSON schema at docs/decisions/decision-record.schema.json
// (vendored from flow-agents' schemas/decision-record.schema.json) is the
// normative structural contract; this script enforces the same rules directly
// so it runs in `npm ci` environments without a JSON-schema/YAML library.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// FLOW_AGENTS_DECISIONS_DIR lets the eval suite point the validator/generator at
// a throwaway fixture directory (mirrors FLOW_AGENTS_CONTENT_BOUNDARY_FILES).
const DECISIONS_DIR = process.env.FLOW_AGENTS_DECISIONS_DIR
  ? path.resolve(process.env.FLOW_AGENTS_DECISIONS_DIR)
  : path.join(ROOT, "docs", "decisions");
const INDEX_PATH = path.join(DECISIONS_DIR, "index.md");
const INDEX_SLUG = "index";

const STATUSES = ["current", "superseded", "merged", "needs-decision"];
const EVIDENCE_KINDS = ["issue", "pr", "commit", "session-archive", "adr", "doc", "url"];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Secret-shaped literal detectors — mirror scripts/hooks/lib/patterns.sh so the
// registry never captures a credential in an evidence ref.
const SECRET_PATTERNS = [
  { label: "aws access key id", re: /AKIA[A-Z0-9]{16}/ },
  { label: "aws sts key id", re: /ASIA[A-Z0-9]{16}/ },
  { label: "github token", re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { label: "private key block", re: /BEGIN[A-Z ]*PRIVATE KEY/ },
  { label: "jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    label: "generic secret literal",
    re: /(secret|password|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i,
  },
];

function listTopicFiles() {
  if (!fs.existsSync(DECISIONS_DIR)) return [];
  return fs
    .readdirSync(DECISIONS_DIR)
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .sort();
}

// Minimal, strict YAML-frontmatter reader. The decision-record frontmatter is a
// flat map of scalars plus two list shapes (evidence[] as `- kind: .. ` blocks
// and slug arrays as inline `[a, b]` or block `- slug`). We parse exactly that
// shape and reject anything we do not understand rather than guessing.
function parseFrontmatter(raw, errors) {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    errors.push("file must begin with a YAML frontmatter block delimited by '---'");
    return null;
  }
  const lines = raw.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    errors.push("frontmatter block is not terminated by a closing '---'");
    return null;
  }
  const body = lines.slice(1, end);
  const data = {};
  let cursorKey = null;

  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const topMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    const listItem = line.match(/^\s*-\s+(.*)$/);

    if (topMatch && !line.startsWith(" ")) {
      const key = topMatch[1];
      const rest = topMatch[2].trim();
      cursorKey = key;
      if (rest === "") {
        data[key] = { __pending_list: true, items: [] };
      } else if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim();
        data[key] = inner === "" ? [] : inner.split(",").map((s) => stripScalar(s.trim()));
      } else {
        data[key] = stripScalar(rest);
      }
      continue;
    }

    if (listItem && cursorKey) {
      const container = data[cursorKey];
      if (!container || !container.__pending_list) {
        errors.push(`unexpected list item under '${cursorKey}': ${line.trim()}`);
        continue;
      }
      const itemBody = listItem[1].trim();
      // Object list item: `- kind: pr, ref: ...` OR `- kind: pr` then following `  ref: ...`
      const inlinePair = itemBody.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (inlinePair) {
        const obj = {};
        obj[inlinePair[1]] = stripScalar(inlinePair[2].trim());
        // consume subsequent indented `key: value` continuation lines
        while (i + 1 < body.length && /^\s+[A-Za-z0-9_]+:\s*/.test(body[i + 1]) && !/^\s*-\s+/.test(body[i + 1])) {
          const cont = body[i + 1].trim().match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (!cont) break;
          obj[cont[1]] = stripScalar(cont[2].trim());
          i += 1;
        }
        container.items.push(obj);
      } else {
        container.items.push(stripScalar(itemBody));
      }
      continue;
    }

    errors.push(`unparseable frontmatter line: ${line}`);
  }

  // Normalize pending lists to plain arrays.
  for (const key of Object.keys(data)) {
    if (data[key] && data[key].__pending_list) {
      data[key] = data[key].items;
    }
  }
  return data;
}

function stripScalar(value) {
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

function firstBodyLine(raw) {
  const lines = raw.split(/\r?\n/);
  let seenClose = false;
  let count = 0;
  for (const line of lines) {
    if (line.trim() === "---") {
      count += 1;
      if (count === 2) seenClose = true;
      continue;
    }
    if (!seenClose) continue;
    const t = line.trim();
    if (t === "") continue;
    return t.replace(/^#+\s*/, "").trim();
  }
  return "";
}

function validateFile(slug, raw, knownSlugs) {
  const errors = [];
  const fm = parseFrontmatter(raw, errors);
  if (!fm) return errors;

  if (!SLUG_RE.test(slug)) {
    errors.push(`filename slug '${slug}' is not a valid kebab-case topic slug`);
  }

  // status
  if (!("status" in fm)) {
    errors.push("missing required field: status");
  } else if (!STATUSES.includes(fm.status)) {
    errors.push(`unknown status '${fm.status}' (allowed: ${STATUSES.join(", ")})`);
  }

  // subject
  if (!("subject" in fm) || typeof fm.subject !== "string" || fm.subject.trim() === "") {
    errors.push("missing required field: subject (non-empty)");
  }

  // decided
  if (!("decided" in fm)) {
    errors.push("missing required field: decided");
  } else if (typeof fm.decided !== "string" || !DATE_RE.test(fm.decided)) {
    errors.push(`decided must be an ISO date (YYYY-MM-DD); got '${fm.decided}'`);
  }

  // evidence
  if (!("evidence" in fm)) {
    errors.push("missing required field: evidence[]");
  } else if (!Array.isArray(fm.evidence) || fm.evidence.length === 0) {
    errors.push("evidence must be a non-empty array of {kind, ref}");
  } else {
    fm.evidence.forEach((item, idx) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push(`evidence[${idx}] must be an object {kind, ref}`);
        return;
      }
      if (!EVIDENCE_KINDS.includes(item.kind)) {
        errors.push(`evidence[${idx}].kind '${item.kind}' is not one of ${EVIDENCE_KINDS.join(", ")}`);
      }
      if (typeof item.ref !== "string" || item.ref.trim() === "") {
        errors.push(`evidence[${idx}].ref must be a non-empty string`);
        return;
      }
      for (const pat of SECRET_PATTERNS) {
        if (pat.re.test(item.ref)) {
          errors.push(`evidence[${idx}].ref contains a secret-shaped literal (${pat.label}); link durable provenance, never a credential`);
          break;
        }
      }
    });
  }

  // tombstone / relationship fields
  const relSingles = ["superseded_by", "merged_into"];
  for (const key of relSingles) {
    if (key in fm) {
      const target = fm[key];
      if (typeof target !== "string" || !SLUG_RE.test(target)) {
        errors.push(`${key} must be a single topic slug; got '${target}'`);
      } else if (!knownSlugs.has(target)) {
        errors.push(`${key} points at missing topic slug '${target}' (no docs/decisions/${target}.md)`);
      } else if (target === slug) {
        errors.push(`${key} must not point at its own slug`);
      }
    }
  }
  if ("supersedes" in fm) {
    const arr = Array.isArray(fm.supersedes) ? fm.supersedes : [fm.supersedes];
    arr.forEach((target) => {
      if (typeof target !== "string" || !SLUG_RE.test(target)) {
        errors.push(`supersedes entry must be a topic slug; got '${target}'`);
      } else if (!knownSlugs.has(target)) {
        errors.push(`supersedes points at missing topic slug '${target}'`);
      }
    });
  }

  // status-conditional relationship rules
  if (fm.status === "current" || fm.status === "needs-decision") {
    if ("superseded_by" in fm || "merged_into" in fm) {
      errors.push(`status '${fm.status}' must not carry superseded_by or merged_into`);
    }
  }
  if (fm.status === "superseded") {
    if (!("superseded_by" in fm)) errors.push("status 'superseded' requires superseded_by");
    if ("merged_into" in fm) errors.push("status 'superseded' must not carry merged_into");
  }
  if (fm.status === "merged") {
    if (!("merged_into" in fm)) errors.push("status 'merged' requires merged_into");
    if ("superseded_by" in fm) errors.push("status 'merged' must not carry superseded_by");
  }

  return errors;
}

function readTopics() {
  const files = listTopicFiles();
  const knownSlugs = new Set(files.map((f) => f.replace(/\.md$/, "")));
  return files.map((file) => {
    const slug = file.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(DECISIONS_DIR, file), "utf8");
    const errors = validateFile(slug, raw, knownSlugs);
    const fm = parseFrontmatter(raw, []);
    return { slug, raw, fm: fm || {}, errors };
  });
}

function oneLiner(topic) {
  const subject = topic.fm && typeof topic.fm.subject === "string" ? topic.fm.subject.trim() : "";
  if (subject) return subject;
  const body = firstBodyLine(topic.raw);
  return body || topic.slug;
}

function renderIndex(topics) {
  const lines = [];
  lines.push("---");
  lines.push("title: Decision Index");
  lines.push("---");
  lines.push("");
  lines.push("# Decision Index");
  lines.push("");
  lines.push("Generated by `npm run gen:decisions-index`. Do not edit by hand.");
  lines.push("Topic-keyed living decision records per `context/contracts/decision-registry-contract.md`.");
  lines.push("Numbered ADRs under `docs/adr/` are frozen history and are not listed here.");
  lines.push("");
  lines.push("| Topic | Status | Decision |");
  lines.push("| --- | --- | --- |");
  const sorted = [...topics].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const topic of sorted) {
    const status = topic.fm && typeof topic.fm.status === "string" ? topic.fm.status : "unknown";
    const summary = oneLiner(topic).replace(/\|/g, "\\|");
    lines.push(`| [${topic.slug}](./${topic.slug}.md) | ${status} | ${summary} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function cmdGenIndex() {
  fs.mkdirSync(DECISIONS_DIR, { recursive: true });
  const topics = readTopics();
  const content = renderIndex(topics);
  fs.writeFileSync(INDEX_PATH, content, "utf8");
  console.log(`Wrote ${path.relative(ROOT, INDEX_PATH)} (${topics.length} topic${topics.length === 1 ? "" : "s"}).`);
  return 0;
}

function cmdCheck() {
  const topics = readTopics();
  let failed = false;

  for (const topic of topics) {
    if (topic.errors.length > 0) {
      failed = true;
      console.error(`FAIL docs/decisions/${topic.slug}.md`);
      for (const err of topic.errors) console.error(`  - ${err}`);
    }
  }

  // Index freshness: check regenerates deterministically and must match on disk
  // (this is what makes regeneration idempotent + diff-clean, AC2).
  const expectedIndex = renderIndex(topics);
  const actualIndex = fs.existsSync(INDEX_PATH) ? fs.readFileSync(INDEX_PATH, "utf8") : null;
  if (actualIndex === null) {
    failed = true;
    console.error("FAIL docs/decisions/index.md is missing; run `npm run gen:decisions-index`");
  } else if (actualIndex !== expectedIndex) {
    failed = true;
    console.error("FAIL docs/decisions/index.md is stale; run `npm run gen:decisions-index`");
  }

  if (failed) {
    console.error("Decision registry check failed.");
    return 1;
  }
  console.log(`Decision registry check passed (${topics.length} topic${topics.length === 1 ? "" : "s"}).`);
  return 0;
}

function main() {
  const mode = process.argv[2] || "check";
  if (mode === "check") return process.exit(cmdCheck());
  if (mode === "gen-index") return process.exit(cmdGenIndex());
  console.error(`Unknown mode '${mode}'. Usage: check-decisions.cjs [check|gen-index]`);
  return process.exit(2);
}

main();
