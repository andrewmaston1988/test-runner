// Selection: what a diff reaches. Failures are in DERIVATION -- the import
// closure -- so selection runs the real graph over fixture repos.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import { expandRun, select } from "../src/select.mjs";
import {
  FIX_GLOB,
  MARKETPLACE,
  capture,
  commitAll,
  configOf,
  graphFixture,
  makeRepo,
  suiteOf,
  write,
} from "./helpers.mjs";

/** The marketplace's ui-probe suite: one run under plugins/, one outside it. */
const UI_PROBE = {
  name: "ui-probe",
  runs: [
    { label: "browser", cwd: ".", globs: ["plugins/ui-probe/tests/*.test.mjs"], timeoutMs: 600000 },
    { label: "bakeoff", cwd: ".", globs: ["bakeoff/ui-probe/protocols/tests/*.test.mjs"], timeoutMs: 600000 },
  ],
};

// --- the import closure ----------------------------------------------------

const fixEntries = (repo, changed) =>
  select({ suites: [suiteOf("fix", [FIX_GLOB])], changed, repoRoot: repo, config: MARKETPLACE }).entries;

const selectedFile = (entries, suffix) => entries.filter((entry) => entry.file.endsWith(suffix));

test("a change reaches a test through a transitive import and no further", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/src/a.mjs"]);
  const reached = selectedFile(entries, "transitive.test.mjs");
  assert.equal(reached.length, 1, JSON.stringify(entries));
  assert.equal(reached[0].why, "changed: plugins/fix/src/a.mjs");
  assert.deepEqual(selectedFile(entries, "unrelated.test.mjs"), [], "a test importing neither was selected");
});

test("a string-literal import() enters the closure", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/src/dyn.mjs"]);
  assert.equal(selectedFile(entries, "dynamic.test.mjs").length, 1, JSON.stringify(entries));
});

test("a new URL literal naming a file enters the closure", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/bin/urlonly.mjs"]);
  assert.equal(selectedFile(entries, "url-file.test.mjs").length, 1, JSON.stringify(entries));
});

test("a new URL literal naming a directory adds every file under it", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/templates/a.md"]);
  assert.equal(selectedFile(entries, "url-dir.test.mjs").length, 1, JSON.stringify(entries));
});

test("a URL locator ending in . or .. enumerates no directory contents", (t) => {
  const result = select({ suites: [suiteOf("fix", [FIX_GLOB])], changed: ["plugins/fix/notes.md"], repoRoot: graphFixture(t), config: MARKETPLACE });
  assert.deepEqual(result.entries.filter((entry) => entry.why !== "windows"), [], "a plugin-root locator walked the plugin");
  assert.equal(result.docsOnly, true);
});

test("a computed join() path is caught by its basename literal", (t) => {
  const repo = graphFixture(t);
  const cli = fixEntries(repo, ["plugins/fix/bin/joined.mjs"]);
  assert.equal(selectedFile(cli, "join-cli.test.mjs").length, 1, JSON.stringify(cli));
  const skill = fixEntries(repo, ["plugins/fix/skills/x/SKILL.md"]);
  assert.equal(selectedFile(skill, "join-skill.test.mjs").length, 1, JSON.stringify(skill));
});

test("a changed .md in no closure selects nothing and reports docs-only", (t) => {
  const result = select({ suites: [suiteOf("fix", [FIX_GLOB])], changed: ["plugins/fix/notes.md"], repoRoot: graphFixture(t), config: MARKETPLACE });
  assert.deepEqual(result.entries.filter((entry) => entry.why !== "windows"), [], "a .md in no closure selected a test");
  assert.equal(result.docsOnly, true);
});

test("a changed non-.md file in no closure runs the whole suite", (t) => {
  const path = "plugins/fix/src/tray/windows.ps1";
  const entries = fixEntries(graphFixture(t), [path]);
  assert.ok(entries.length >= 6, JSON.stringify(entries));
  assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`));
});

test("--list reports the change docs-only through the real CLI", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  write(repo, "plugins/fix/extra.md", "more notes\n");
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo,
    _config: configOf([suiteOf("fix", [FIX_GLOB])]),
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.match(out.errors.join("\n"), /docs-only/);
  const rows = out.lines.map((line) => line.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(rows, ["fix plugins/fix/tests/thing.win.test.mjs"], ".md selects nothing");
});

test("lockfiles and plugin manifests run the whole suite", (t) => {
  const repo = graphFixture(t);
  const suite = [suiteOf("fix", [FIX_GLOB])];
  const all = expandRun(suite[0].runs[0], { repoRoot: repo }).length;
  const fallbacks = ["plugins/fix/package.json", "plugins/fix/package-lock.json",
    "plugins/fix/.claude-plugin/plugin.json", "plugins/fix/.codex-plugin/plugin.json",
    "plugins/fix/hooks/hooks.json", "plugins/fix/.env.test"];
  for (const path of fallbacks) {
    const { entries } = select({ suites: suite, changed: [path], repoRoot: repo, config: MARKETPLACE });
    assert.equal(entries.length, all, `${path} should run the whole suite`);
    assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`), path);
  }
});

test("a change under a suite's own home, outside every package, selects that suite whole", (t) => {
  const repo = makeRepo(t);
  write(repo, "bakeoff/ui-probe/protocols/protocol.mjs");
  write(repo, "bakeoff/ui-probe/protocols/tests/smoke.test.mjs");
  write(repo, FIX_GLOB.replace("*.test.mjs", "transitive.test.mjs"));
  const suites = [UI_PROBE, suiteOf("fix", [FIX_GLOB])];
  const path = "bakeoff/ui-probe/protocols/x.mjs";

  const { entries, docsOnly } = select({ suites, changed: [path], repoRoot: repo, config: MARKETPLACE });
  const chosen = entries.filter((entry) => entry.suite === "ui-probe");
  assert.ok(
    chosen.some((entry) => entry.file === "bakeoff/ui-probe/protocols/tests/smoke.test.mjs"),
    JSON.stringify(entries),
  );
  assert.ok(chosen.every((entry) => entry.why === `fallback: ${path}`), JSON.stringify(entries));
  assert.deepEqual(entries.filter((entry) => entry.suite === "fix"), [], "a bakeoff change selected a plugin");
  assert.equal(docsOnly, false);
});

test("a change under scripts/ runs the repo suite, not a plugin's", (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("repo", ["scripts/*.test.mjs"])];
  const path = "scripts/x.mjs";
  const { entries } = select({ suites, changed: [path], repoRoot: repo, config: MARKETPLACE });
  const repoEntries = entries.filter((entry) => entry.suite === "repo");
  assert.equal(repoEntries.length, 1, path);
  assert.equal(repoEntries[0].why, `fallback: ${path}`);
  const attributed = entries.filter((entry) => entry.suite === "fix" && entry.why !== "windows");
  assert.deepEqual(attributed, [], "a repo-level change must not select a plugin test");
});

test("a workflow change selects every suite, because it decides what CI runs", (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("repo", ["scripts/*.test.mjs"])];
  const path = ".github/workflows/test.yml";
  const { entries } = select({ suites, changed: [path], repoRoot: repo, config: MARKETPLACE });
  for (const name of ["fix", "repo"]) {
    const chosenSuite = entries.filter((entry) => entry.suite === name);
    assert.ok(chosenSuite.length > 0, `${name} was not selected by ${path}`);
    assert.ok(chosenSuite.every((entry) => entry.why === `fallback: ${path}`), name);
  }
});

test("a .win.test.mjs is selected by a diff that touches none of it", (t) => {
  const entries = fixEntries(graphFixture(t), ["plugins/fix/notes.md"]);
  const win = selectedFile(entries, ".win.test.mjs");
  assert.equal(win.length, 1, JSON.stringify(entries));
  assert.equal(win[0].why, "windows");
});

test("** matches zero or more directories, * matches one level", (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  write(repo, "tests/deep/b.test.mjs");
  write(repo, "tests/deep/deeper/c.test.mjs");

  const deep = expandRun({ cwd: ".", globs: ["tests/**/*.test.mjs"] }, { repoRoot: repo });
  assert.deepEqual(deep, ["tests/a.test.mjs", "tests/deep/b.test.mjs", "tests/deep/deeper/c.test.mjs"]);
  const flat = expandRun({ cwd: ".", globs: ["tests/*.test.mjs"] }, { repoRoot: repo });
  assert.deepEqual(flat, ["tests/a.test.mjs"]);
});
