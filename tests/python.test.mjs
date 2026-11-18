// The Python side of the import graph: `from a.b import c` resolved against the
// roots pytest itself uses, relative dots climbed from the importing file, and
// the `pyproject.toml` reader that supplies those roots.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importedNames, pythonEdges, pythonRootsFor, readPythonPath } from "../src/python.mjs";
import { makeRepo, write } from "./helpers.mjs";

const FILES = [
  "src/shop/__init__.py",
  "src/shop/pricing.py",
  "src/shop/settings.py",
  "src/shop/cart.py",
  "src/shop/widgets.py",
  "src/shop/legacy.py",
  "src/shop/discounts/__init__.py",
  "src/shop/discounts/rules.py",
  "tests/conftest.py",
  "tests/test_cart.py",
  "tests/test_pricing.py",
  "tests/test_rules.py",
];

/** A bare index: `pythonEdges` reads only these two fields. */
const indexOf = (files = FILES, pythonRoots = ["", "src"]) => ({
  resolveSet: new Set(files),
  pythonRoots,
});

const edges = (file, text, index = indexOf()) => [...pythonEdges(file, text, index)].sort();

// --- the extractor ---------------------------------------------------------

test("an absolute dotted import resolves through a non-empty pythonpath root", () => {
  const out = edges("tests/test_pricing.py", "from shop.pricing import total\n");
  assert.ok(out.includes("src/shop/pricing.py"), out.join(", "));
  assert.ok(out.includes("src/shop/__init__.py"), "the ancestor package was not added");
  // Concatenating the root and the module instead of joining them resolves nothing.
  assert.deepEqual(out, ["src/shop/__init__.py", "src/shop/pricing.py"]);
});

test("relative dots climb one level per dot past the first", () => {
  const one = edges("src/shop/cart.py", "from . import widgets\n");
  assert.ok(one.includes("src/shop/widgets.py"), one.join(", "));

  const two = edges("src/shop/discounts/rules.py", "from .. import legacy\n");
  assert.ok(two.includes("src/shop/legacy.py"), two.join(", "));
  assert.ok(!two.includes("src/shop/discounts/legacy.py"), "the climb stopped one level short");
});

test("a from-import probes both the package and each named submodule", () => {
  const text = "from shop import (\n    cart,\n    widgets,\n    LIMIT,\n)\n";
  const out = edges("tests/test_cart.py", text);
  assert.ok(out.includes("src/shop/cart.py"), out.join(", "));
  assert.ok(out.includes("src/shop/widgets.py"), out.join(", "));
  assert.ok(out.includes("src/shop/__init__.py"), "the package itself was not added");
  assert.deepEqual(out.filter((file) => file.endsWith("LIMIT")), [], "a package name became a file");

  const submodule = edges("tests/test_rules.py", "from shop.discounts import rules\n");
  assert.ok(submodule.includes("src/shop/discounts/rules.py"));
  assert.ok(submodule.includes("src/shop/discounts/__init__.py"));

  const star = edges("tests/test_cart.py", "from shop import *\n");
  assert.deepEqual(star, ["src/shop/__init__.py"], "a star import named a module");
});

test("every ancestor __init__.py is an edge", () => {
  const out = edges("tests/test_pricing.py", "from shop.pricing import total\n");
  assert.ok(out.includes("src/shop/__init__.py"), out.join(", "));
});

test("multi-line parenthesised imports and as-aliases are read", () => {
  assert.deepEqual(importedNames("(\n    cart,\n    widgets,\n)"), ["cart", "widgets"]);
  assert.deepEqual(importedNames("total as t, other"), ["total", "other"]);
  const out = edges("tests/test_cart.py", "from shop import (\n    cart,\n    widgets,\n)\n");
  assert.ok(out.includes("src/shop/cart.py"));
  assert.ok(out.includes("src/shop/widgets.py"));
});

test("a trailing comment is stripped and a second statement on the line is read", () => {
  assert.deepEqual(edges("tests/conftest.py", "import pytest  # noqa: E402\n"), []);
  const commented = edges("tests/test_cart.py", "from shop import cart  # the cart\n");
  assert.deepEqual(commented, ["src/shop/__init__.py", "src/shop/cart.py"]);

  const two = edges("tests/test_cart.py", "from shop import cart; from shop import widgets\n");
  assert.ok(two.includes("src/shop/cart.py"), two.join(", "));
  assert.ok(two.includes("src/shop/widgets.py"), two.join(", "));
});

test("a plain import and a literal import_module() resolve against every root", () => {
  const plain = edges("tests/test_pricing.py", "import shop.pricing\n");
  assert.ok(plain.includes("src/shop/pricing.py"), plain.join(", "));

  const dynamic = edges("tests/test_dynamic.py", 'importlib.import_module("shop.pricing")\n');
  assert.ok(dynamic.includes("src/shop/pricing.py"), dynamic.join(", "));

  const bare = edges("tests/test_dynamic.py", 'import_module("shop.settings")\n');
  assert.ok(bare.includes("src/shop/settings.py"), bare.join(", "));
});

// --- roots -----------------------------------------------------------------

const readPath = (t, text) => {
  const repo = makeRepo(t);
  write(repo, "pyproject.toml", text);
  return readPythonPath({ repoRoot: repo });
};

test("pythonpath is read inline and across lines", (t) => {
  assert.deepEqual(readPath(t, '[tool.pytest.ini_options]\npythonpath = ["src"]\n'), ["src"]);
  assert.deepEqual(
    readPath(t, '[tool.pytest.ini_options]\npythonpath = [\n    "src",\n    "tests",  # helpers\n]\ntestpaths = ["tests"]\n'),
    ["src", "tests"],
  );
});

test("a missing file, section or key returns [] rather than throwing", (t) => {
  const repo = makeRepo(t);
  assert.deepEqual(readPythonPath({ repoRoot: repo }), [], "a missing pyproject.toml threw");
  assert.deepEqual(readPath(t, '[tool.black]\nline-length = 100\n'), [], "a missing section was read");
  assert.deepEqual(readPath(t, '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n'), [], "a missing key was read");
});

test("the scanner is section-scoped, so a stray pythonpath is not a root", (t) => {
  assert.deepEqual(
    readPath(t, '[tool.other]\npythonpath = ["nope"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n'),
    [],
    "a pythonpath before the pytest section was read",
  );
  assert.deepEqual(
    readPath(t, '[tool.pytest.ini_options]\n# pythonpath = ["nope"]\n'),
    [],
    "a commented pythonpath was read",
  );
  assert.deepEqual(
    readPath(t, '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.mypy]\npythonpath = ["nope"]\n'),
    [],
    "a pythonpath in a later section was read",
  );
});

test("a commented entry inside the array is not a root", (t) => {
  assert.deepEqual(
    readPath(t, '[tool.pytest.ini_options]\npythonpath = [\n    "src",\n    # "nope",\n]\n'),
    ["src"],
  );
});

test("pythonRootsFor puts the repo root first, normalises and deduplicates", () => {
  assert.deepEqual(pythonRootsFor({ pythonPath: ["src/", "./tests"], cwds: ["", ".", "src"] }), ["", "src", "tests"]);
  assert.deepEqual(pythonRootsFor({ pythonPath: [], cwds: [] }), [""]);
  assert.deepEqual(pythonRootsFor({ pythonPath: ["src\\lib"], cwds: ["packages/api"] }), ["", "src/lib", "packages/api"]);
});
