// The import graph package suites select on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closureOf, edgesOf, isScanner, makeIndex, pyClosure, repoFiles } from "../src/graph.mjs";
import { crossPackageFixture, makeRepo, powershellFixture, pythonFixture, write } from "./helpers.mjs";

test("a module shared by many tests is parsed once, not once per test", (t) => {
  const repo = makeRepo(t);
  write(repo, "lib/shared.mjs", "export const x = 1;\n");
  for (const name of ["a", "b", "c"]) {
    write(repo, `tests/${name}.test.mjs`, 'import "../lib/shared.mjs";\n');
  }
  const index = makeIndex({ repoRoot: repo });
  const reads = new Map();
  const read = index.read.bind(index);
  index.read = (file) => {
    reads.set(file, (reads.get(file) ?? 0) + 1);
    return read(file);
  };

  for (const name of ["a", "b", "c"]) {
    assert.ok(closureOf(`tests/${name}.test.mjs`, index).has("lib/shared.mjs"), name);
  }
  assert.equal(reads.get("lib/shared.mjs"), 1, "the shared module was re-parsed per closure");
});

test("a relative specifier that leaves its package resolves, and basenames stay package-scoped", (t) => {
  const repo = crossPackageFixture(t);
  write(repo, "packages/b/u.mjs", "export const other = 1;\n");
  const index = makeIndex({ repoRoot: repo, root: "packages/a", repoFileSet: repoFiles({ repoRoot: repo }) });

  assert.ok(closureOf("packages/a/tests/a.test.mjs", index).has("shared/u.mjs"),
    "a specifier that leaves packages/a did not resolve");
  assert.ok(closureOf("packages/a/tests/x.test.mjs", index).has("packages/b/src/m.mjs"),
    "a specifier into a sibling package did not resolve");
  assert.ok(!closureOf("packages/a/tests/a.test.mjs", index).has("packages/b/u.mjs"),
    "a same-basename file in another package was resolved by basename");
});

test("a computed import by file location or runpy is a scanner", () => {
  assert.equal(isScanner("spec = importlib.util.spec_from_file_location(name, path)\n"), true,
    "spec_from_file_location was not a scanner token");
  assert.equal(isScanner("module = runpy.run_path(target, run_name=\"__main__\")\n"), true,
    "runpy.run_path was not a scanner token");
});

test("two suite indexes over one repo share the text cache", (t) => {
  const repo = crossPackageFixture(t);
  const texts = new Map();
  const reads = new Map();
  const readFile = (path, encoding) => {
    reads.set(path, (reads.get(path) || 0) + 1);
    return readFileSync(path, encoding);
  };
  const options = { repoRoot: repo, root: "", _texts: texts, _readFileSync: readFile };
  const first = makeIndex(options);
  const second = makeIndex(options);

  closureOf("packages/a/tests/a.test.mjs", first);
  closureOf("packages/a/tests/a.test.mjs", second);
  assert.equal(reads.get(join(repo, "shared/u.mjs")), 1, "each index parsed the shared module itself");
});

test("a backslash literal reaches a .ps1 inside the suite root but not outside it", (t) => {
  const repo = powershellFixture(t);
  const index = makeIndex({ repoRoot: repo, root: "tools/tests" });
  assert.ok(closureOf("tools/tests/literal.test.mjs", index).has("tools/tests/tool.ps1"),
    "a backslash literal lost its edge to a target inside the suite root");
  assert.ok(!closureOf("tools/tests/outside.test.mjs", index).has("tools/smoke.ps1"),
    "a target outside the suite root was resolved");
});

// --- Python edges and the conftest seed ------------------------------------

const pythonIndex = (repo) => makeIndex({
  repoRoot: repo,
  root: "tests",
  repoFileSet: repoFiles({ repoRoot: repo }),
  pythonRoots: ["", "src"],
});

test("a .py file's edges are Python edges, and pyClosure seeds every conftest", (t) => {
  const repo = pythonFixture(t);
  const index = pythonIndex(repo);
  const direct = edgesOf("tests/test_pricing.py", "from shop.pricing import total\n", index);
  assert.ok(direct.has("src/shop/pricing.py"), [...direct].join(", "));
  assert.ok(direct.has("src/shop/__init__.py"), "the ancestor __init__.py was not an edge");

  const seeded = pyClosure("tests/test_plain.py", index);
  assert.ok(seeded.has("tests/conftest.py"), "the test's own conftest was not seeded");
  assert.ok(seeded.has("src/shop/settings.py"), "the conftest's closure was not seeded");
  assert.ok(!closureOf("tests/test_plain.py", index).has("src/shop/settings.py"),
    "the plain closure reached the conftest's import, so this row cannot witness the seed");
  assert.equal(pyClosure("tests/test_plain.py", index), seeded, "pyClosure was not memoised");
});

test(".venv is never walked or resolved", (t) => {
  const repo = makeRepo(t);
  write(repo, ".venv/lib/pkg/mod.py", "X = 1\n");
  write(repo, ".venv/lib/pkg/x.test.mjs", "export const x = 1;\n");
  write(repo, "tests/test_x.py", "from pkg import mod\n");

  const files = repoFiles({ repoRoot: repo });
  assert.deepEqual([...files].filter((file) => file.startsWith(".venv/")), [], "the walk entered .venv");

  const index = makeIndex({ repoRoot: repo, root: "tests", repoFileSet: files, pythonRoots: [".venv/lib"] });
  assert.deepEqual([...index.resolveSet].filter((file) => file.startsWith(".venv/")), [],
    ".venv entered the resolver's file set");
  assert.deepEqual([...edgesOf("tests/test_x.py", "from pkg import mod\n", index)], [],
    "an import resolved into .venv");
});
