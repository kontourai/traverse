#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const SELF = "scripts/check-content-boundary.cjs";

const bannedTerms = [
  {
    label: "private vertical product name",
    pattern: new RegExp(["c", "a", "m", "p", "f", "i", "t"].join(""), "i"),
  },
  {
    label: "private regulated vertical repository name",
    pattern: new RegExp("\\b" + ["t", "a", "x", "e", "s"].join("") + "\\b", "i"),
  },
  {
    label: "private regulated vertical term",
    pattern: new RegExp("\\b" + ["t", "a", "x"].join("") + "\\b", "i"),
  },
];

const ignoredPathPatterns = [
  /^node_modules\//,
  /^dist\//,
  /^build\//,
  /^\.git\//,
  /^\.astro\//,
  /^test-results\//,
  /^\.omx\//,
];

function candidateFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  return output.split("\0").filter(Boolean);
}

function isIgnoredPath(filePath) {
  return filePath === SELF || ignoredPathPatterns.some((pattern) => pattern.test(filePath));
}

function lineNumberFor(content, index) {
  return content.slice(0, index).split("\n").length;
}

const findings = [];

for (const filePath of candidateFiles()) {
  if (filePath.startsWith(".flow-agents/")) {
    findings.push({
      filePath,
      line: 1,
      label: "Flow Agents runtime artifact must not be tracked in this repo",
    });
    continue;
  }

  if (isIgnoredPath(filePath)) {
    continue;
  }

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }

  if (content.includes("\0")) {
    continue;
  }

  for (const term of bannedTerms) {
    const match = term.pattern.exec(content);
    if (match) {
      findings.push({
        filePath,
        line: lineNumberFor(content, match.index),
        label: term.label,
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Content boundary check failed:");
  for (const finding of findings) {
    console.error(`- ${finding.filePath}:${finding.line} ${finding.label}`);
  }
  process.exit(1);
}

console.log("Content boundary check passed.");
