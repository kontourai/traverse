import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const cache = await mkdtemp(path.join(os.tmpdir(), "traverse-pack-"));

try {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--cache", cache], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 10,
  });

  const packEntries = parsePackJson(stdout);
  if (packEntries.length !== 1) {
    throw new Error(`Expected one npm pack entry, found ${packEntries.length}.`);
  }

  const entry = packEntries[0];
  if (entry.name !== packageJson.name) throw new Error(`Unexpected package name: ${entry.name}`);
  if (entry.version !== packageJson.version) throw new Error(`Unexpected package version: ${entry.version}`);
  if (entry.bundled?.length) throw new Error(`Package must not bundle dependencies: ${entry.bundled.join(", ")}`);

  const files = entry.files.map((file) => file.path).sort();
  const fileSet = new Set(files);

  const requiredFiles = [
    "LICENSE",
    "README.md",
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "dist/src/anthropic.js",
    "dist/src/anthropic.d.ts",
  ];

  for (const requiredFile of requiredFiles) {
    if (!fileSet.has(requiredFile)) throw new Error(`Missing expected package file: ${requiredFile}`);
  }

  const forbiddenPatterns = [
    /^node_modules\//,
    /^test-results\//,
    /^scripts\//,
    /^tests\//,
    /^dist\/tests\//,
    /^tsconfig/,
    /node_modules/,
  ];

  for (const file of files) {
    const forbiddenPattern = forbiddenPatterns.find((pattern) => pattern.test(file));
    if (forbiddenPattern) throw new Error(`Unexpected package file matched ${forbiddenPattern}: ${file}`);
  }

  console.log(`Traverse package contents check passed: ${files.length} files.`);
} finally {
  await rm(cache, { recursive: true, force: true });
}

function parsePackJson(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not find npm pack JSON in output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}
