const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");

const checker = resolve("scripts/check-content-boundary.cjs");
const prohibited = ["c", "a", "m", "p", "f", "i", "t"].join("");

function fixtureRepository() {
  const directory = mkdtempSync(join(tmpdir(), "traverse-content-boundary-"));
  mkdirSync(join(directory, "scripts"));
  copyFileSync(checker, join(directory, "scripts/check-content-boundary.cjs"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  writeFileSync(join(directory, "tracked.txt"), "generic public fixture\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
  return directory;
}

test("content boundary rejects an untracked non-ignored file", () => {
  const directory = fixtureRepository();
  try {
    writeFileSync(join(directory, "new-fixture.txt"), `${prohibited}\n`);
    const result = spawnSync(
      process.execPath,
      ["scripts/check-content-boundary.cjs"],
      { cwd: directory, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /new-fixture\.txt:1 private vertical product name/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("content boundary excludes ignored untracked files", () => {
  const directory = fixtureRepository();
  try {
    writeFileSync(join(directory, ".gitignore"), "ignored.txt\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: directory });
    writeFileSync(join(directory, "ignored.txt"), `${prohibited}\n`);
    const result = spawnSync(
      process.execPath,
      ["scripts/check-content-boundary.cjs"],
      { cwd: directory, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
