// Declared `paths`, scanner tests and the cross-package sweep: what a glob
// run claims beyond its import closure, and when a package falls back whole.

import { test } from "node:test";
import assert from "node:assert/strict";

import { expandRun, select } from "../src/select.mjs";
import {
  PATHS_PY_SUITE,
  PATHS_SUITE,
  crossPackageFixture,
  makeRepo,
  pathsFixture,
  powershellFixture,
  pythonFixture,
  scannerFixture,
  write,
} from "./helpers.mjs";

// --- declared paths, scanners and the sweep --------------------------------

const PACKAGES = { packages: ["packages/*"] };

/** The attributable entries as `[file, why]`, with the always-windows rows out
 *  of the comparison. */
const attributable = (entries) =>
  entries.filter((entry) => entry.why !== "windows").map((entry) => [entry.file, entry.why]);

test("a declared paths match selects its globs run whole, and no other run", (t) => {
  const repo = pathsFixture(t);
  const path = "packages/api/src/n.mjs";
  const { entries } = select({ suites: [PATHS_SUITE], changed: [path], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(attributable(entries), [
    ["packages/api/tests/a.test.mjs", `paths: ${path}`],
    ["packages/api/tests/b.test.mjs", `paths: ${path}`],
  ]);
  assert.deepEqual(
    entries.filter((entry) => entry.file.endsWith(".win.test.mjs")).map((entry) => entry.why),
    ["windows"],
  );
});

test("paths match repo-relative paths whatever the run's cwd", (t) => {
  const repo = pathsFixture(t);
  const path = "packages/api/src/n.mjs";
  const suite = (paths) => ({
    name: "api",
    runs: [{ cwd: "packages/api", globs: ["tests/a.test.mjs", "tests/b.test.mjs"], paths, timeoutMs: 600000 }],
  });

  const matched = select({ suites: [suite(["packages/api/src/**"])], changed: [path], repoRoot: repo, config: PACKAGES }).entries;
  assert.deepEqual(attributable(matched), [
    ["packages/api/tests/a.test.mjs", `paths: ${path}`],
    ["packages/api/tests/b.test.mjs", `paths: ${path}`],
  ]);

  const missed = select({ suites: [suite(["src/**"])], changed: [path], repoRoot: repo, config: PACKAGES }).entries;
  assert.deepEqual(missed.filter((entry) => entry.why.startsWith("paths:")), [],
    "a cwd-relative glob matched a repo-relative changed path");
  assert.ok(attributable(missed).every(([, why]) => why === `fallback: ${path}`), JSON.stringify(missed));
});

test("a claim suppresses the fallback for the claiming suite only", (t) => {
  const repo = pathsFixture(t);
  const path = "packages/api/src/n.mjs";
  const sibling = { name: "sibling", runs: [{ cwd: ".", globs: ["packages/api/tests/c.test.mjs"], timeoutMs: 600000 }] };
  const { entries } = select({ suites: [PATHS_SUITE, sibling], changed: [path], repoRoot: repo, config: PACKAGES });
  const claimed = entries.filter((entry) => entry.suite === "api" && entry.why !== "windows");
  assert.ok(claimed.every((entry) => entry.why === `paths: ${path}`), JSON.stringify(claimed));
  assert.deepEqual(entries.filter((entry) => entry.suite === "sibling"), [
    { suite: "sibling", file: "packages/api/tests/c.test.mjs", why: `fallback: ${path}` },
  ]);
});

test("declared paths is additive to the graph closure", (t) => {
  const repo = pathsFixture(t);
  const path = "packages/api/src/m.mjs";
  const { entries } = select({ suites: [PATHS_SUITE], changed: [path], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(attributable(entries), [
    ["packages/api/tests/a.test.mjs", `paths: ${path}`],
    ["packages/api/tests/b.test.mjs", `paths: ${path}`],
    ["packages/api/tests/reacher.test.mjs", `changed: ${path}`],
  ]);
});

test("a .md is selected by declared paths, and docs-only only when nothing selects it", (t) => {
  const repo = pathsFixture(t);
  const path = "packages/api/notes.md";
  const docs = { name: "docs", runs: [{ cwd: ".", globs: ["packages/api/tests/a.test.mjs"], paths: ["packages/api/**/*.md"], timeoutMs: 600000 }] };

  const claimed = select({ suites: [docs], changed: [path], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(attributable(claimed.entries), [["packages/api/tests/a.test.mjs", `paths: ${path}`]]);
  assert.equal(claimed.docsOnly, false);

  const reachedNothing = select({ suites: [PATHS_SUITE], changed: [path], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(attributable(reachedNothing.entries), [], "a .md nothing claims selected a test");
  assert.ok(reachedNothing.entries.every((entry) => entry.why === "windows"), JSON.stringify(reachedNothing.entries));
  assert.equal(reachedNothing.docsOnly, true);
});

test("claim state is per changed path, so an unclaimed path still reaches repoSuite or unowned", (t) => {
  const repo = pathsFixture(t);
  const repoSuite = { name: "repo", runs: [{ cwd: ".", globs: ["scripts/*.test.mjs"], timeoutMs: 600000 }] };
  const claimedFirst = select({
    suites: [PATHS_SUITE, repoSuite],
    changed: ["packages/api/src/n.mjs", "root/x.mjs"],
    repoRoot: repo,
    config: { packages: ["packages/*"], repoSuite: "repo" },
  });
  assert.deepEqual(claimedFirst.entries.filter((entry) => entry.suite === "repo"), [
    { suite: "repo", file: "scripts/keep.test.mjs", why: "fallback: root/x.mjs" },
  ]);
  assert.deepEqual(claimedFirst.unowned, []);

  const unowned = select({
    suites: [PATHS_SUITE],
    changed: ["packages/api/src/n.mjs", "root/x.mjs"],
    repoRoot: repo,
    config: PACKAGES,
  });
  assert.deepEqual(unowned.unowned, ["root/x.mjs"], "the first path's claim swallowed the second");
  assert.deepEqual(unowned.entries.filter((entry) => entry.why === "fallback: root/x.mjs"), []);
});

test("a select-all change runs every suite whole even when a paths glob matches", (t) => {
  const repo = pathsFixture(t);
  const path = ".github/workflows/test.yml";
  const { entries } = select({
    suites: [PATHS_SUITE], changed: [path], repoRoot: repo,
    config: { packages: ["packages/*"], selectAll: [".github/workflows/**"] },
  });
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.why === `fallback: ${path}`), JSON.stringify(entries));
});

test("a fallback manifest still runs the package whole, second run included", (t) => {
  const repo = pathsFixture(t);
  const path = "packages/api/package.json";
  const suite = {
    name: "api",
    runs: [
      {
        cwd: ".", globs: ["packages/api/tests/a.test.mjs", "packages/api/tests/b.test.mjs"],
        paths: ["packages/api/**"], timeoutMs: 600000,
      },
      { cwd: ".", globs: ["packages/api/tests/c.test.mjs"], timeoutMs: 600000 },
    ],
  };
  const { entries } = select({
    suites: [suite], changed: [path], repoRoot: repo,
    config: { packages: ["packages/*"], fallback: ["**/package.json"] },
  });
  assert.deepEqual(attributable(entries).map(([file]) => file), [
    "packages/api/tests/a.test.mjs", "packages/api/tests/b.test.mjs", "packages/api/tests/c.test.mjs",
  ]);
  const second = entries.find((entry) => entry.file === "packages/api/tests/c.test.mjs");
  assert.equal(second.why, `fallback: ${path}`);
});

test("tests/** crosses directories and tests/* does not", (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  write(repo, "tests/deep/b.test.mjs");
  assert.deepEqual(expandRun({ cwd: ".", globs: ["tests/**"] }, { repoRoot: repo }),
    ["tests/a.test.mjs", "tests/deep/b.test.mjs"]);
  assert.deepEqual(expandRun({ cwd: ".", globs: ["tests/*"] }, { repoRoot: repo }), ["tests/a.test.mjs"]);
});

test("a pathless command run claims nothing", (t) => {
  const repo = pathsFixture(t);
  const mixed = {
    name: "api",
    runs: [
      { cwd: ".", globs: ["packages/api/tests/a.test.mjs"], timeoutMs: 600000 },
      { cwd: ".", command: ["make", "gate"], timeoutMs: 1 },
    ],
  };
  const path = "packages/api/src/n.mjs";
  const { entries } = select({ suites: [mixed], changed: [path], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(entries.map((entry) => [entry.file, entry.why]), [
    ["packages/api/tests/a.test.mjs", `fallback: ${path}`],
    ["command:1", `changed: ${path}`],
  ]);
  const unowned = select({ suites: [mixed], changed: ["root/x.mjs"], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(unowned.unowned, ["root/x.mjs"], "a pathless command run swallowed an unowned change");
});

test("a change reached inside its own package still selects a sibling package's importer", (t) => {
  const repo = crossPackageFixture(t);
  const path = "packages/b/src/m.mjs";
  const suites = [
    { name: "a", runs: [{ cwd: ".", globs: ["packages/a/tests/*.test.mjs"], timeoutMs: 600000 }] },
    { name: "b", runs: [{ cwd: ".", globs: ["packages/b/tests/*.test.mjs"], timeoutMs: 600000 }] },
  ];
  const { entries } = select({ suites, changed: [path], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(entries.filter((entry) => entry.suite === "a").map((entry) => [entry.file, entry.why]), [
    ["packages/a/tests/x.test.mjs", `changed: ${path}`],
  ]);
  assert.deepEqual(entries.filter((entry) => entry.suite === "b").map((entry) => [entry.file, entry.why]), [
    ["packages/b/tests/b.test.mjs", `changed: ${path}`],
  ], "the owning suite fell back whole instead of selecting its importer");
});

test("a claim does not suppress the cross-package sweep", (t) => {
  const repo = crossPackageFixture(t);
  write(repo, "scripts/keep.test.mjs");
  const path = "packages/b/src/m.mjs";
  const claimer = { name: "gate", runs: [{ cwd: ".", globs: ["scripts/*.test.mjs"], paths: ["packages/b/**"], timeoutMs: 600000 }] };
  const suites = [
    claimer,
    { name: "a", runs: [{ cwd: ".", globs: ["packages/a/tests/*.test.mjs"], timeoutMs: 600000 }] },
    { name: "b", runs: [{ cwd: ".", globs: ["packages/b/tests/*.test.mjs"], timeoutMs: 600000 }] },
  ];
  const { entries } = select({ suites, changed: [path], repoRoot: repo, config: PACKAGES });
  const x = entries.find((entry) => entry.file === "packages/a/tests/x.test.mjs");
  assert.ok(x, JSON.stringify(entries));
  assert.equal(x.why, `changed: ${path}`);
});

test("a scanner test runs on a non-Markdown change the graph reaches elsewhere", (t) => {
  const repo = scannerFixture(t);
  const path = "packages/api/src/m.mjs";
  const suite = { name: "api", runs: [{ cwd: ".", globs: ["packages/api/tests/*.test.mjs"], timeoutMs: 600000 }] };
  const { entries } = select({ suites: [suite], changed: [path], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(entries.map((entry) => [entry.file, entry.why]), [
    ["packages/api/tests/reacher.test.mjs", `changed: ${path}`],
    ["packages/api/tests/scanner.test.mjs", `scanner: ${path}`],
  ]);
});

test("a computed .ps1 target with no literal is selected only by declared paths", (t) => {
  const repo = powershellFixture(t);
  const path = "scripts/smoke.ps1";
  write(repo, path, "# computed target\n");
  const declared = {
    name: "tools",
    runs: [{ cwd: ".", globs: ["tools/tests/*.test.mjs"], paths: ["scripts/*.ps1"], timeoutMs: 600000 }],
  };
  const { entries } = select({ suites: [declared], changed: [path], repoRoot: repo });
  assert.deepEqual(entries.map((entry) => [entry.file, entry.why]), [
    ["tools/tests/computed.test.mjs", `paths: ${path}`],
    ["tools/tests/literal.test.mjs", `paths: ${path}`],
    ["tools/tests/outside.test.mjs", `paths: ${path}`],
  ]);

  // `join(root, "sm" + "oke.ps1")` leaves no literal for the graph to follow,
  // so without the declaration the change is owned by nothing at all.
  const undeclared = { name: "tools", runs: [{ cwd: ".", globs: ["tools/tests/*.test.mjs"], timeoutMs: 600000 }] };
  const none = select({ suites: [undeclared], changed: [path], repoRoot: repo });
  assert.deepEqual(none.entries, []);
  assert.deepEqual(none.unowned, [path]);
});

test("scanners never fire on a .md, and outside packages the home rule owns the change", (t) => {
  const repo = scannerFixture(t);
  const packageSuite = { name: "api", runs: [{ cwd: ".", globs: ["packages/api/tests/*.test.mjs"], timeoutMs: 600000 }] };
  const markdown = select({ suites: [packageSuite], changed: ["packages/api/notes.md"], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(markdown.entries.filter((entry) => entry.why.startsWith("scanner:")), [],
    "a Markdown change dragged a scanner along");
  assert.equal(markdown.docsOnly, true);

  const homeSuite = { name: "tools", runs: [{ cwd: ".", globs: ["tools/x/tests/*.test.mjs"], timeoutMs: 600000 }] };
  const path = "tools/x/helper.mjs";
  const home = select({ suites: [homeSuite], changed: [path], repoRoot: repo, config: {} });
  assert.ok(home.entries.length > 0);
  assert.ok(home.entries.every((entry) => entry.why === `fallback: ${path}`), JSON.stringify(home.entries));
  assert.deepEqual(home.entries.filter((entry) => entry.why.startsWith("scanner:")), []);
});

// --- select: "paths" -------------------------------------------------------

test('a select: "paths" suite is selected by its globs only', (t) => {
  const repo = pathsFixture(t);
  const suite = {
    name: "api",
    select: "paths",
    runs: [{
      cwd: ".",
      globs: ["packages/api/tests/a.test.mjs", "packages/api/tests/b.test.mjs", "packages/api/tests/reacher.test.mjs"],
      paths: ["packages/api/src/n.mjs"],
      timeoutMs: 600000,
    }],
  };

  const matched = select({ suites: [suite], changed: ["packages/api/src/n.mjs"], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(attributable(matched.entries), [
    ["packages/api/tests/a.test.mjs", "paths: packages/api/src/n.mjs"],
    ["packages/api/tests/b.test.mjs", "paths: packages/api/src/n.mjs"],
    ["packages/api/tests/reacher.test.mjs", "paths: packages/api/src/n.mjs"],
  ]);
  // `reacher.test.mjs` imports `src/m.mjs`, so the graph would narrow this to
  // one test; with the graph off, the suite runs whole instead.
  const path = "packages/api/src/m.mjs";
  const outside = select({ suites: [suite], changed: [path], repoRoot: repo, config: PACKAGES });
  const expected = expandRun(suite.runs[0], { repoRoot: repo });
  assert.deepEqual(attributable(outside.entries), expected.map((file) => [file, `fallback: ${path}`]));
  assert.deepEqual(matched.wide, [], "a paths match was reported as an undetermined radius");
  assert.deepEqual(outside.wide, [{ path, suites: ["api"] }]);
});

test('a select: "paths" Python suite is not narrowed by an import', (t) => {
  const repo = pythonFixture(t, { sysPath: true });
  const path = "src/shop/pricing.py";
  const { entries, wide } = select({ suites: [PATHS_PY_SUITE], changed: [path], repoRoot: repo });
  const expected = expandRun(PATHS_PY_SUITE.runs[0], { repoRoot: repo });
  assert.deepEqual(attributable(entries), expected.map((file) => [file, `fallback: ${path}`]));
  assert.deepEqual(wide, [{ path, suites: ["py"] }]);
});

test('a select: "paths" suite a sibling sweep does not deselect runs whole', (t) => {
  const repo = crossPackageFixture(t);
  const suites = [
    { name: "a", runs: [{ cwd: ".", globs: ["packages/a/tests/*.test.mjs"], timeoutMs: 600000 }] },
    {
      name: "b",
      select: "paths",
      runs: [{ cwd: ".", globs: ["packages/b/tests/*.test.mjs"], paths: ["nothing/**"], timeoutMs: 600000 }],
    },
  ];
  const path = "packages/b/src/m.mjs";
  const { entries, wide } = select({ suites, changed: [path], repoRoot: repo, config: PACKAGES });
  assert.deepEqual(
    entries.filter((entry) => entry.suite === "b").map((entry) => [entry.file, entry.why]),
    [["packages/b/tests/b.test.mjs", `fallback: ${path}`]],
    "the sibling sweep deselected a paths-mode suite",
  );
  assert.deepEqual(wide, [{ path, suites: ["b"] }]);
});
