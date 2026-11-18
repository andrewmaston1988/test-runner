// Shared fixtures for the runner's tests: temporary git repositories, the
// package graph the selection tests walk, the config they are driven by, and
// the spawn/log stubs main() is driven through.

import assert from "node:assert/strict";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This directory, so a test file can locate the package. */
export const HERE = dirname(fileURLToPath(import.meta.url));

/** The package's CLI, for tests that run it as a real process. */
export const BIN = join(HERE, "..", "bin", "test-runner.mjs");

/** claude-plugin-marketplace's runner behaviour as config: the ported tests
 *  were written against it, so passing it proves the port changed nothing. */
export const MARKETPLACE = {
  base: ["origin/master", "master"],
  repoSuite: "repo",
  packages: ["plugins/*"],
  fallback: [
    "**/package.json",
    "**/package-lock.json",
    "**/.env.test",
    "**/hooks/hooks.json",
    "**/.claude-plugin/**",
    "**/.codex-plugin/**",
  ],
  selectAll: ["scripts/test.mjs", "scripts/test-suites.mjs", "scripts/test-lib/**", ".github/workflows/test.yml"],
  skipDirs: ["sessions"],
};

/** A config holding `suites` and the marketplace's behaviour. `repoSuite` is
 *  kept only when a `repo` suite is present: the marketplace runner treated a
 *  missing one as none, and validation refuses a name that matches no suite. */
export function configOf(suites, extra = {}) {
  const { repoSuite, ...rest } = MARKETPLACE;
  const hasRepo = suites.some((suite) => suite.name === repoSuite);
  return { ...rest, ...(hasRepo ? { repoSuite } : {}), suites, ...extra };
}

export const FIX_GLOB = "plugins/fix/tests/*.test.mjs";

export function git(cwd, ...args) {
  const r = nodeSpawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** An injected `_tmpdir` for runSuites/main: a throwaway parent the test
 *  removes afterwards, so the package's own runs never leave a root in the
 *  machine's real temp dir. */
export function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "runner-tmp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return () => dir;
}

export function makeRepo(t, branch = "master") {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "runner@example.com");
  git(dir, "config", "user.name", "runner");
  git(dir, "config", "core.autocrlf", "false"); // stable bytes on Windows and Linux
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

export function write(cwd, rel, text = "x\n") {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
}

export function suiteOf(name, globs, extra = {}) {
  return { name, runs: [{ cwd: ".", globs, timeoutMs: 600000, ...extra }] };
}

/** A command run's suite: one unlabelled command, platform `any` unless given. */
export function commandSuite(command, extra = {}) {
  return { name: "cmd", runs: [{ cwd: ".", command, timeoutMs: 60000, platform: "any", ...extra }] };
}

/** A spawn stub: records every call, and closes (or never closes) on the next
 *  turn of the loop so the runner's listeners are attached first. The capture
 *  tests need more: `out`/`errOut` are chunk data fed on that first turn even
 *  to a never-closing child, the child is reachable at `calls[i].child` (with
 *  `child.stdout`/`child.stderr` accepting "data"), and a never-closing child
 *  is settled by hand with `child.close(code)`. */
export function stubSpawn({ code = 0, never = false, pid = 4242, out = "", errOut = "" } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const listeners = { close: [], error: [], stdout: [], stderr: [] };
    const child = {
      pid,
      once(event, cb) { if (listeners[event]) listeners[event].push(cb); return child; },
      stdout: { on(event, cb) { if (event === "data") listeners.stdout.push(cb); return this; } },
      stderr: { on(event, cb) { if (event === "data") listeners.stderr.push(cb); return this; } },
      close(exit = code) { for (const cb of listeners.close.splice(0)) cb(exit); },
    };
    calls.push({ cmd, args, opts, child });
    setImmediate(() => {
      for (const cb of listeners.stdout.splice(0)) cb(Buffer.from(out));
      for (const cb of listeners.stderr.splice(0)) cb(Buffer.from(errOut));
      if (!never) setImmediate(() => { for (const cb of listeners.close.splice(0)) cb(code); });
    });
    return child;
  };
  return { spawn, calls };
}

export function capture() {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (line) => lines.push(line), err: (line) => errors.push(line) };
}

/** The fixture plugin: one module chain, one dynamic import, one URL file, one
 *  URL directory, a computed plugin-root locator, two computed `join()` paths
 *  -- and a `.win.test.mjs`. */
export function graphFixture(t) {
  const repo = makeRepo(t);
  const files = {
    "plugins/fix/src/a.mjs": "export const a = 1;\n",
    "plugins/fix/src/b.mjs": 'import { a } from "./a.mjs";\nexport const b = a;\n',
    "plugins/fix/tests/transitive.test.mjs": 'import { b } from "../src/b.mjs";\n',
    "plugins/fix/tests/unrelated.test.mjs": "export const nothing = 1;\n",
    "plugins/fix/src/dyn.mjs": "export const dyn = 1;\n",
    "plugins/fix/tests/dynamic.test.mjs": 'await import("../src/dyn.mjs");\n',
    "plugins/fix/bin/urlonly.mjs": "export const cli = 1;\n",
    "plugins/fix/tests/url-file.test.mjs":
      'const p = new URL("../bin/urlonly.mjs", import.meta.url).pathname;\n',
    "plugins/fix/templates/a.md": "template\n",
    "plugins/fix/tests/url-dir.test.mjs": 'const d = new URL("../templates", import.meta.url);\n',
    "plugins/fix/src/root.mjs": 'export const root = new URL("..", import.meta.url);\nexport const here = new URL(".", import.meta.url);\n',
    "plugins/fix/tests/root.test.mjs": 'import { root } from "../src/root.mjs";\n',
    "plugins/fix/bin/joined.mjs": "export const joined = 1;\n",
    "plugins/fix/tests/join-cli.test.mjs": 'join(here, "..", "bin", "joined.mjs");\n',
    "plugins/fix/skills/x/SKILL.md": "skill\n",
    "plugins/fix/tests/join-skill.test.mjs": 'join(SKILLS, "skills/x/SKILL.md");\n',
    "plugins/fix/package.json": "{}\n",
    "plugins/fix/package-lock.json": "{}\n",
    "plugins/fix/hooks/hooks.json": "{}\n",
    "plugins/fix/.claude-plugin/plugin.json": "{}\n",
    "plugins/fix/.codex-plugin/plugin.json": "{}\n",
    "plugins/fix/.env.test": "A=1\n",
    "plugins/fix/notes.md": "notes\n",
    // Names the fallback files from inside a closure: without the fallback
    // rule only this one test would be selected, not the whole suite.
    "plugins/fix/tests/manifest.test.mjs":
      'for (const p of ["../package.json", "../package-lock.json", "../hooks/hooks.json",\n  "../.claude-plugin/plugin.json", "../.codex-plugin/plugin.json", "../.env.test"]) new URL(p, import.meta.url);\n',
    "plugins/fix/src/tray/windows.ps1": "# tray\n",
    "plugins/fix/tests/thing.win.test.mjs": "export const w = 1;\n",
    "scripts/keep.test.mjs": "export const k = 1;\n",
  };
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}

/** One package whose graph reaches a single test, plus the files a declared
 *  `paths` glob claims. The shapes S1-S8 and S19 select on. */
export function pathsFixture(t) {
  const repo = makeRepo(t);
  const files = {
    "packages/api/src/m.mjs": "export const m = 1;\n",
    "packages/api/src/n.mjs": "export const n = 1;\n",
    "packages/api/tests/reacher.test.mjs": 'import { m } from "../src/m.mjs";\n',
    "packages/api/tests/a.test.mjs": "export const a = 1;\n",
    "packages/api/tests/b.test.mjs": "export const b = 1;\n",
    "packages/api/tests/c.test.mjs": "export const c = 1;\n",
    "packages/api/tests/thing.win.test.mjs": "export const w = 1;\n",
    "packages/api/package.json": "{}\n",
    "packages/api/notes.md": "notes\n",
    "packages/other/tests/z.test.mjs": "export const z = 1;\n",
    "scripts/keep.test.mjs": "export const k = 1;\n",
  };
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}

/** A declared-`paths` globs run over a and b, and an unrelated second run. */
export const PATHS_SUITE = {
  name: "api",
  runs: [
    {
      cwd: ".",
      globs: ["packages/api/tests/a.test.mjs", "packages/api/tests/b.test.mjs"],
      paths: ["packages/api/src/**"],
      timeoutMs: 600000,
    },
    { cwd: ".", globs: ["packages/api/tests/*.test.mjs"], timeoutMs: 600000 },
  ],
};

/** A package whose tests walk directories, and one that only imports. */
export function scannerFixture(t) {
  const repo = makeRepo(t);
  const files = {
    "packages/api/src/m.mjs": "export const m = 1;\n",
    "packages/api/src/n.mjs": "export const n = 1;\n",
    "packages/api/tests/reacher.test.mjs": 'import { m } from "../src/m.mjs";\n',
    "packages/api/tests/scanner.test.mjs":
      'import { readdirSync } from "node:fs";\nreaddirSync("src");\n',
    "packages/api/tests/plain.test.mjs": "export const plain = 1;\n",
    "packages/api/notes.md": "notes\n",
    "tools/x/tests/a.test.mjs": 'import { readdirSync } from "node:fs";\nreaddirSync(".");\n',
    "tools/x/helper.mjs": "export const helper = 1;\n",
  };
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}

/** Two packages that reach each other through relative specifiers. */
export function crossPackageFixture(t) {
  const repo = makeRepo(t);
  const files = {
    "shared/u.mjs": "export const u = 1;\n",
    "packages/a/tests/a.test.mjs": 'import "../../../shared/u.mjs";\n',
    "packages/a/tests/x.test.mjs": 'import "../../../packages/b/src/m.mjs";\n',
    "packages/b/src/m.mjs": "export const m = 1;\n",
    "packages/b/tests/b.test.mjs": 'import "../src/m.mjs";\n',
  };
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}

/** A `cargo metadata --no-deps` payload over five crates under `crates/` --
 *  alpha, beta, gamma, delta, epsilon -- with the edge kinds the cargo-graph
 *  tests pin: beta->alpha normal, gamma->beta normal, delta->alpha dev-only,
 *  epsilon->beta target-only, plus one registry dep carrying no path.
 *  Absolute paths are built from `repoRoot` at runtime. `workspaceRootRel`
 *  roots the workspace at a subdirectory; `rootPackage` adds the member whose
 *  manifest is the workspace manifest itself. */
export function metadataFixture(repoRoot, { workspaceRootRel = "", rootPackage = null } = {}) {
  const wr = workspaceRootRel === "" ? repoRoot : join(repoRoot, workspaceRootRel);
  const crateDir = (name) => join(wr, "crates", name);
  const dep = (name, extra = {}) => ({ name, kind: null, target: null, path: crateDir(name), ...extra });
  const pkg = (name, deps = []) => ({ name, manifest_path: join(crateDir(name), "Cargo.toml"), dependencies: deps });
  const packages = [
    ...(rootPackage ? [{ name: rootPackage, manifest_path: join(wr, "Cargo.toml"), dependencies: [] }] : []),
    pkg("alpha", [{ name: "serde", kind: null, target: null, source: "registry+https://github.com/rust-lang/crates.io-index" }]),
    pkg("beta", [dep("alpha")]),
    pkg("gamma", [dep("beta")]),
    pkg("delta", [dep("alpha", { kind: "dev" })]),
    pkg("epsilon", [dep("beta", { target: 'cfg(target_os = "android")' })]),
  ];
  return { workspace_root: wr, packages };
}

/** A spawnSync stub for selection and CLI-level tests: answers `cargo metadata`
 *  with the repo's fixture payload (or `metadata` when given directly), records
 *  every call, and passes anything else -- git, node -- through to the real
 *  spawnSync. `fail: "throw"` throws, a `fail` number is the exit status. */
export function cliSpawnSync(repoRoot, { metadata = null, fail = null, workspaceRootRel = "", rootPackage = null } = {}) {
  const calls = [];
  const spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "cargo") {
      if (fail === "throw") throw new Error("boom");
      if (typeof fail === "number") return { status: fail, stdout: "", stderr: "boom\n" };
      const payload = metadata ?? metadataFixture(repoRoot, { workspaceRootRel, rootPackage });
      return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
    }
    return nodeSpawnSync(cmd, args, opts);
  };
  return { calls, spawnSync };
}

/** A `.ps1` target inside a suite's glob root named by a backslash literal, and
 *  the same shape for a target outside it. */
export function powershellFixture(t) {
  const repo = makeRepo(t);
  const files = {
    "tools/tests/tool.ps1": "# tool\n",
    "tools/tests/literal.test.mjs": 'const p = "..\\\\tool.ps1";\n',
    "tools/tests/outside.test.mjs": 'const p = "..\\\\..\\\\smoke.ps1";\n',
    "tools/tests/computed.test.mjs": 'const p = join(root, "sm" + "oke.ps1");\n',
    "tools/smoke.ps1": "# outside the suite root\n",
  };
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}

/** A pytest repository: code under `src/` behind `pythonpath`, tests under
 *  `tests/`, two conftests, a data file a test names by literal, and a `.mjs`
 *  test so a second suite can reach nothing. `scanner` adds a test with a
 *  computed import, which turns its whole suite into a whole-run suite.
 *  `sysPath` adds a test that reaches `shop.pricing` only through
 *  `sys.path.insert`; `offRoot` adds a `lib/json.py` no root names and the test
 *  that imports it. */
export function pythonFixture(t, { scanner = false, sysPath = false, offRoot = false } = {}) {
  const repo = makeRepo(t);
  const files = {
    "pyproject.toml": '[tool.pytest.ini_options]\npythonpath = ["src"]\ntestpaths = ["tests"]\n',
    "src/shop/__init__.py": "LIMIT = 3\n",
    "src/shop/pricing.py": "def total(items):\n    return sum(items)\n",
    "src/shop/settings.py": "LIMIT = 3\n",
    "src/shop/cart.py": "from . import widgets\n\n\ndef items():\n    return widgets.NAME\n",
    "src/shop/widgets.py": "NAME = 'widget'\n",
    "src/shop/legacy.py": "LEGACY = True\n",
    "src/shop/discounts/__init__.py": "RULES = ()\n",
    "src/shop/discounts/rules.py": "from .. import legacy\n",
    "tests/conftest.py": "from shop.settings import LIMIT  # noqa: E402\n",
    "tests/test_cart.py": "from shop import (\n    cart,\n    widgets,\n    LIMIT,\n)\n",
    "tests/test_pricing.py": "from shop.pricing import total\n",
    "tests/test_rules.py": "from shop.discounts import rules\n",
    "tests/test_plain.py": "def test_plain():\n    assert True\n",
    "tests/test_data.py": 'def test_data():\n    open("catalog.toml")\n',
    "tests/data/catalog.toml": '[catalog]\nname = "fixture"\n',
    "tests/sub/conftest.py": "# a narrower conftest\n",
    "tests/sub/test_nested.py": "from shop import settings\n",
    "tests/test_js.test.mjs": "export const js = 1;\n",
  };
  if (scanner) {
    files["tests/test_dynamic.py"] =
      "import importlib\n\n\ndef test_dynamic(name):\n    importlib.import_module(name)\n";
  }
  if (sysPath) {
    files["tests/test_syspath.py"] =
      'import sys\n\nsys.path.insert(0, "src")\n\nimport pricing  # noqa: E402\n';
  }
  if (offRoot) {
    files["lib/json.py"] = "DATA = 1\n";
    files["tests/test_json.py"] = "import json\n";
  }
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}

/** The Python half of the fixture, and a `.mjs` suite over the same repository
 *  that reaches none of it. */
export const PY_SUITE = {
  name: "py",
  runs: [{ cwd: ".", globs: ["tests/**/test_*.py"], timeoutMs: 600000 }],
};
export const JS_SUITE = {
  name: "js",
  runs: [{ cwd: ".", globs: ["tests/**/test_*.mjs"], timeoutMs: 600000 }],
};
/** A paths-mode Python suite: its declared paths deliberately miss the code the
 *  `sys.path` test imports, so only the mode gate keeps the suite whole. */
export const PATHS_PY_SUITE = {
  name: "py",
  select: "paths",
  runs: [{ cwd: ".", globs: ["tests/**/test_*.py"], paths: ["tests/data/**"], timeoutMs: 600000 }],
};
