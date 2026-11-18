// Python: the import graph, the conftest seed, and per-suite gating.

import { test } from "node:test";
import assert from "node:assert/strict";

import { expandRun, select } from "../src/select.mjs";
import { pythonEdges } from "../src/python.mjs";
import { JS_SUITE, PY_SUITE, configOf, graphFixture, pythonFixture, write } from "./helpers.mjs";

// --- Python: the import graph, the conftest seed, and per-suite gating ------

/** A selection restricted to the entries one suite owns. */
const ofSuite = (entries, name) => entries.filter((entry) => entry.suite === name);
const pairs = (entries) => entries.map((entry) => [entry.file, entry.why]);

test("an absolute dotted import resolves through a non-empty pythonpath root", (t) => {
  const repo = pythonFixture(t);
  const path = "src/shop/pricing.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  assert.deepEqual(pairs(entries), [["tests/test_pricing.py", `changed: ${path}`]]);
});

test("relative dots climb one level per dot past the first", (t) => {
  const repo = pythonFixture(t);
  const one = select({ suites: [PY_SUITE], changed: ["src/shop/widgets.py"], repoRoot: repo });
  assert.deepEqual(pairs(one.entries), [["tests/test_cart.py", "changed: src/shop/widgets.py"]]);
  const two = select({ suites: [PY_SUITE], changed: ["src/shop/legacy.py"], repoRoot: repo });
  assert.deepEqual(pairs(two.entries), [["tests/test_rules.py", "changed: src/shop/legacy.py"]]);
});

test("the package __init__.py is an edge, so a change to it selects the importer", (t) => {
  const repo = pythonFixture(t);
  const path = "src/shop/discounts/__init__.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  assert.deepEqual(pairs(entries), [["tests/test_rules.py", `changed: ${path}`]]);
});

test("a test that imports nothing is selected by what its conftest imports", (t) => {
  const repo = pythonFixture(t);
  const path = "src/shop/settings.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  const plain = entries.find((entry) => entry.file === "tests/test_plain.py");
  assert.ok(plain, JSON.stringify(entries));
  assert.equal(plain.why, `changed: ${path}`);
  assert.ok(entries.some((entry) => entry.file === "tests/sub/test_nested.py"),
    "the nested test imports shop.settings directly");
});

test("the conftest seed is directory-scoped", (t) => {
  const repo = pythonFixture(t);
  const sub = select({ suites: [PY_SUITE], changed: ["tests/sub/conftest.py"], repoRoot: repo });
  assert.deepEqual(pairs(sub.entries), [["tests/sub/test_nested.py", "changed: tests/sub/conftest.py"]]);

  const root = select({ suites: [PY_SUITE], changed: ["tests/conftest.py"], repoRoot: repo });
  const files = root.entries.map((entry) => entry.file);
  for (const file of ["tests/test_cart.py", "tests/test_plain.py", "tests/sub/test_nested.py"]) {
    assert.ok(files.includes(file), `${file} missing from ${files.join(",")}`);
  }
  assert.ok(root.entries.every((entry) => entry.why === "changed: tests/conftest.py"), JSON.stringify(root.entries));
});

test("the suffix edge narrows where an in-repo module matches, and a true reach-miss still runs whole", (t) => {
  const repo = pythonFixture(t);
  // Without the pythonpath root `shop.pricing` resolves against no configured
  // root, so the suffix arm is what finds it.
  write(repo, "pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');

  const narrowed = select({ suites: [PY_SUITE], changed: ["src/shop/pricing.py"], repoRoot: repo });
  assert.deepEqual(pairs(narrowed.entries), [["tests/test_pricing.py", "changed: src/shop/pricing.py"]]);

  // `other.py` is a name no import carries, so the fallback is still the
  // guarantee it was: the whole run, nothing dropped.
  const path = "src/shop/other.py";
  const missed = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  const expected = expandRun(PY_SUITE.runs[0], { repoRoot: repo });
  assert.ok(expected.length > 1, expected.join(","));
  assert.deepEqual(pairs(missed.entries), expected.map((file) => [file, `fallback: ${path}`]));
});

test("a sys.path importer reaches the module through the suffix arm, beside the rooted importer", (t) => {
  const repo = pythonFixture(t, { sysPath: true });
  const path = "src/shop/pricing.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  assert.deepEqual(pairs(entries), [
    ["tests/test_pricing.py", `changed: ${path}`],
    ["tests/test_syspath.py", `changed: ${path}`],
  ]);
});

test("with the roots removed, a names-arm import matches the module by suffix", (t) => {
  const repo = pythonFixture(t);
  write(repo, "pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  const path = "src/shop/cart.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  assert.deepEqual(pairs(entries), [["tests/test_cart.py", `changed: ${path}`]]);
});

test("with the roots removed, an ancestor package __init__ is matched by suffix", (t) => {
  const repo = pythonFixture(t);
  write(repo, "pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  const path = "src/shop/__init__.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  const pricing = entries.find((entry) => entry.file === "tests/test_pricing.py");
  assert.ok(pricing, JSON.stringify(entries));
  assert.equal(pricing.why, `changed: ${path}`);
});

test("with the roots removed, a bare dotted import matches the rest arm by suffix", (t) => {
  const repo = pythonFixture(t);
  write(repo, "pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  write(repo, "tests/test_plain_import.py", "import shop.pricing\n");
  const path = "src/shop/pricing.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  const bare = entries.find((entry) => entry.file === "tests/test_plain_import.py");
  assert.ok(bare, JSON.stringify(entries));
  assert.equal(bare.why, `changed: ${path}`);
});

test("an unresolved import matches a module off every root by suffix", (t) => {
  const repo = pythonFixture(t, { offRoot: true });
  const index = {
    resolveSet: new Set(["lib/json.py", "tests/test_json.py", "src/shop/pricing.py"]),
    pythonRoots: ["", "src"],
  };
  assert.deepEqual([...pythonEdges("tests/test_json.py", "import json\n", index)].sort(), ["lib/json.py"]);

  const path = "lib/json.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  assert.deepEqual(pairs(entries), [["tests/test_json.py", `changed: ${path}`]]);

  // With no in-repo `json.py` the name resolves nowhere, and adds no edge.
  const absent = { resolveSet: new Set(["src/shop/pricing.py"]), pythonRoots: ["", "src"] };
  assert.deepEqual([...pythonEdges("tests/test_json.py", "import json\n", absent)], []);
});

test("a suffix match keeps the whole module path, and a relative import never takes one", () => {
  const index = { resolveSet: new Set(["other/missing.py", "other/pricing.py"]), pythonRoots: [""] };
  assert.deepEqual([...pythonEdges("tests/test_x.py", "import shop.missing\n", index)], [],
    "a basename-only rule matched other/missing.py");
  assert.deepEqual([...pythonEdges("mod.py", "from . import pricing\n", index)], [],
    "a relative import was matched by suffix");
});

test("gating is per suite, not global", (t) => {
  const repo = pythonFixture(t);
  const path = "src/shop/discounts/rules.py";
  const { entries } = select({ suites: [PY_SUITE, JS_SUITE], changed: [path], repoRoot: repo });
  assert.deepEqual(pairs(ofSuite(entries, "py")), [["tests/test_rules.py", `changed: ${path}`]]);
  const js = ofSuite(entries, "js");
  assert.ok(js.length > 0, "the suite that reaches nothing was suppressed by the reached one");
  assert.ok(js.every((entry) => entry.why === `fallback: ${path}`), JSON.stringify(js));
});

test("a pyproject.toml change runs every Python suite whole and leaves a .mjs suite alone", (t) => {
  const repo = pythonFixture(t);
  const path = "pyproject.toml";
  const { entries } = select({ suites: [PY_SUITE, JS_SUITE], changed: [path], repoRoot: repo });
  const expected = expandRun(PY_SUITE.runs[0], { repoRoot: repo });
  assert.deepEqual(pairs(ofSuite(entries, "py")), expected.map((file) => [file, `fallback: ${path}`]));
  assert.deepEqual(ofSuite(entries, "js"), [], "a Python manifest change reached a .mjs suite");
});

test("the manifest rule still beats the graph", (t) => {
  const repo = graphFixture(t);
  write(repo, "plugins/fix/tests/named.py", 'X = "package.json"\n');
  const suite = {
    name: "fix",
    runs: [
      { cwd: ".", globs: ["plugins/fix/tests/*.test.mjs"], timeoutMs: 600000 },
      { cwd: ".", globs: ["plugins/fix/tests/*.py"], timeoutMs: 600000 },
    ],
  };
  const path = "plugins/fix/package.json";
  const { entries } = select({ suites: [suite], changed: [path], repoRoot: repo, config: configOf([suite]) });
  const expected = expandRun(suite.runs[0], { repoRoot: repo }).length
    + expandRun(suite.runs[1], { repoRoot: repo }).length;
  assert.equal(entries.length, expected, `${JSON.stringify(entries)}`);
  assert.ok(entries.some((entry) => entry.file === "plugins/fix/tests/named.py"));
  // named.py's own basename edge reaches the manifest first, so its reason is
  // the honest one; every other file is the whole-suite fallback the rule owes.
  const rest = entries.filter((entry) => entry.file !== "plugins/fix/tests/named.py");
  assert.ok(rest.every((entry) => entry.why === `fallback: ${path}`), JSON.stringify(rest));
});

test("a computed import makes its suite run whole, so no sibling is dropped", (t) => {
  const repo = pythonFixture(t, { scanner: true });
  const path = "src/shop/pricing.py";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  const expected = expandRun(PY_SUITE.runs[0], { repoRoot: repo });
  assert.deepEqual(pairs(entries), expected.map((file) => [
    file,
    file === "tests/test_pricing.py" ? `changed: ${path}` : `fallback: ${path}`,
  ]));
});

test("a non-.py file a test names by literal is selectable", (t) => {
  const repo = pythonFixture(t);
  const path = "tests/data/catalog.toml";
  const { entries } = select({ suites: [PY_SUITE], changed: [path], repoRoot: repo });
  assert.deepEqual(pairs(entries), [["tests/test_data.py", `changed: ${path}`]]);
});
