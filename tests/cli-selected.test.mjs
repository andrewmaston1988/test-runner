// --if-selected through main(): whether a diff reaches a suite, and what a
// selected suite runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { main } from "../src/cli.mjs";
import {
  FIX_GLOB,
  JS_SUITE,
  PY_SUITE,
  capture,
  commitAll,
  configOf,
  graphFixture,
  makeRepo,
  pythonFixture,
  stubSpawn,
  suiteOf,
  tempRoot,
  write,
} from "./helpers.mjs";

// --- --if-selected ---------------------------------------------------------

/** A committed fixture with a second plugin whose only test is Windows-only,
 *  so a diff in `plugins/fix` leaves that suite with a `windows` entry alone. */
function ifSelectedRepo(t) {
  const repo = graphFixture(t);
  write(repo, "plugins/elsewhere/tests/x.win.test.mjs");
  commitAll(repo, "fixture");
  return repo;
}

/** On a Windows host, where the fixture's `.win.test.mjs`-only suite runs at all. */
async function ifSelectedRun(t, repo, suites, suiteName, extra = {}) {
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", suiteName, "--if-selected", "--against", "HEAD"], {
    cwd: repo, _config: configOf(suites, extra), _platform: "win32", _spawn: spawn.spawn, _log: out.log, _err: out.err,
    _tmpdir: tempRoot(t),
  });
  return { code, out, spawn };
}

test("--if-selected runs a selected suite whole and skips an unselected one", async (t) => {
  const repo = ifSelectedRepo(t);
  const suites = [
    suiteOf("fix", [FIX_GLOB]),
    suiteOf("elsewhere", ["plugins/elsewhere/tests/*.test.mjs"]),
  ];
  write(repo, "plugins/fix/src/a.mjs", "export const a = 2;\n");

  const selectedRun = await ifSelectedRun(t, repo, suites, "fix");
  assert.equal(selectedRun.code, 0);
  assert.ok(selectedRun.spawn.calls.length > 0, "a selected suite did not run");
  assert.ok(
    selectedRun.spawn.calls[0].args.includes("plugins/fix/tests/unrelated.test.mjs"),
    "the suite did not run whole",
  );

  const skipped = await ifSelectedRun(t, repo, suites, "elsewhere");
  assert.equal(skipped.code, 0);
  assert.equal(skipped.spawn.calls.length, 0, "an unselected suite spawned node --test");
  assert.match(skipped.out.lines.join("\n"), /^\[test\] elsewhere: not selected by this diff$/m);
});

test("a runner, registry or workflow change runs every suite", async (t) => {
  const repo = ifSelectedRepo(t);
  const suites = [
    suiteOf("fix", [FIX_GLOB]),
    suiteOf("elsewhere", ["plugins/elsewhere/tests/*.test.mjs"]),
  ];
  for (const path of ["scripts/test-lib/select.mjs", "scripts/test-suites.mjs", ".github/workflows/test.yml"]) {
    write(repo, path);
    const { code, spawn } = await ifSelectedRun(t, repo, suites, "elsewhere");
    assert.equal(code, 0, path);
    assert.ok(spawn.calls.length > 0, `${path} did not run the suite`);
    rmSync(join(repo, path), { force: true });
  }
});

test("a changed *.win.test.mjs selects its suite", async (t) => {
  const repo = ifSelectedRepo(t);
  const suites = [suiteOf("fix", [FIX_GLOB]), suiteOf("elsewhere", ["plugins/elsewhere/tests/*.test.mjs"])];
  write(repo, "plugins/fix/tests/extra.win.test.mjs");
  const { code, spawn } = await ifSelectedRun(t, repo, suites, "fix");
  assert.equal(code, 0);
  assert.ok(spawn.calls.length > 0, "a changed win test did not select its suite");
});

test("--if-selected on a suite whose globs match nothing exits 1, not 'not selected'", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", "empty", "--if-selected", "--against", "HEAD"], {
    cwd: repo,
    _config: configOf([suiteOf("empty", ["nowhere/*.test.mjs"])]),
    _spawn: spawn.spawn,
    _log: out.log,
    _err: out.err,
  });

  assert.equal(code, 1, out.lines.join("\n"));
  assert.match(out.lines.join("\n"), /no file matched nowhere\/\*\.test\.mjs/);
  assert.equal(spawn.calls.length, 0, "an empty suite spawned node --test bare");
});

test("--if-selected with an unresolvable base exits 2 and runs nothing", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  const spawn = stubSpawn();
  const errors = [];
  const code = await main(["--suite", "fix", "--if-selected", "--against", "nosuchref"], {
    cwd: repo,
    _config: configOf([suiteOf("fix", [FIX_GLOB])]),
    _spawn: spawn.spawn,
    _log: () => {},
    _err: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /not a ref/);
  assert.equal(spawn.calls.length, 0, "a selection error still spawned a run");
});

test("--if-selected runs a suite a scanner selects, and a .md-only diff selects nothing", async (t) => {
  const repo = makeRepo(t);
  write(repo, "packages/api/src/n.mjs", "export const n = 1;\n");
  write(repo, "packages/api/tests/scanner.test.mjs",
    'import { readdirSync } from "node:fs";\nreaddirSync("src");\n');
  write(repo, "packages/api/tests/plain.test.mjs", "export const plain = 1;\n");
  write(repo, "packages/api/notes.md", "notes\n");
  commitAll(repo, "fixture");
  // The declared globs run claims the change, so no `fallback:` entry is added;
  // the scanner is what selects the walking test.
  const suites = [{
    name: "api",
    runs: [
      { label: "gate", cwd: ".", globs: ["packages/api/tests/plain.test.mjs"], paths: ["packages/api/src/**"], timeoutMs: 600000 },
      { label: "unit", cwd: ".", globs: ["packages/api/tests/*.test.mjs"], timeoutMs: 600000 },
    ],
  }];
  const extra = { packages: ["packages/*"] };

  write(repo, "packages/api/src/n.mjs", "export const n = 2;\n");
  const selected = await ifSelectedRun(t, repo, suites, "api", extra);
  assert.equal(selected.code, 0, selected.out.errors.join("\n"));
  assert.ok(selected.spawn.calls.length > 0, "a scanner-selected diff did not run the suite");
  assert.ok(selected.spawn.calls.some((call) => call.args.includes("packages/api/tests/plain.test.mjs")),
    "the suite did not run whole");

  commitAll(repo, "scanner change");
  write(repo, "packages/api/notes.md", "more notes\n");
  const docs = await ifSelectedRun(t, repo, suites, "api", extra);
  assert.equal(docs.code, 0);
  assert.equal(docs.spawn.calls.length, 0, "a .md-only diff ran a suite");
  assert.match(docs.out.lines.join("\n"), /^\[test\] api: not selected by this diff$/m);
});

// --- Python through main() -------------------------------------------------

test("--list prints the Python reasons, and --if-selected still runs the suite whole", async (t) => {
  const repo = pythonFixture(t);
  commitAll(repo, "fixture");
  write(repo, "src/shop/pricing.py", "def total(items):\n    return sum(items) + 1\n");
  const suites = [PY_SUITE, JS_SUITE];

  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo,
    _config: configOf(suites),
    _spawn: spawn.spawn,
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.equal(spawn.calls.length, 0, "list mode spawned a process");
  const lines = out.lines.join("\n");
  assert.match(lines, /^py tests\/test_pricing\.py changed: src\/shop\/pricing\.py$/m, lines);
  assert.match(lines, /^js tests\/test_js\.test\.mjs fallback: src\/shop\/pricing\.py$/m, lines);

  // The graph chooses which suites; a selected suite still runs whole.
  const run = stubSpawn();
  const runOut = capture();
  const runCode = await main(["--suite", "py", "--if-selected", "--against", "HEAD"], {
    cwd: repo,
    _config: configOf(suites),
    _platform: "linux",
    _spawn: run.spawn,
    _log: runOut.log,
    _err: runOut.err,
    _tmpdir: tempRoot(t),
  });
  assert.equal(runCode, 0);
  assert.ok(run.calls.length > 0, "a selected suite did not run");
  assert.ok(run.calls[0].args.includes("tests/test_plain.py"),
    `the suite did not run whole: ${run.calls[0].args.join(" ")}`);
});
