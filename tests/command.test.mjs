// Command runs: an argv with no shell, selected as a unit, `{base}` filled in.
// The process tests spawn real children, because "no shell" and "no child
// left alive" are properties of the real spawn, not of a stub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { main } from "../src/cli.mjs";
import { runSuites } from "../src/run.mjs";
import { select } from "../src/select.mjs";
import { capture, commitAll, git, makeRepo, stubSpawn, write } from "./helpers.mjs";

const PRINT_ARGS = "console.log(JSON.stringify(process.argv.slice(1)))";

/** A real spawn whose stdout is captured instead of inherited. */
function capturingSpawn() {
  const out = { text: "", children: [] };
  const spawnFn = (file, args, opts) => {
    const child = spawn(file, args, { ...opts, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk) => {
      out.text += String(chunk);
    });
    out.children.push(child);
    return child;
  };
  return { spawn: spawnFn, out };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const commandSuite = (command, extra = {}) => ({
  name: "cmd", runs: [{ cwd: ".", command, timeoutMs: 60000, platform: "any", ...extra }],
});

test("A3: a command past its timeout is reported and its process is gone", async (t) => {
  const repo = makeRepo(t);
  const { spawn: spawnFn, out } = capturingSpawn();
  const [result] = await runSuites([commandSuite([process.execPath, "-e", "setTimeout(() => {}, 1e6)"], { timeoutMs: 500 })], {
    repoRoot: repo, _spawn: spawnFn,
  });
  assert.equal(result.status, "timeout", JSON.stringify(result));
  const { pid } = out.children[0];
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false, `pid ${pid} survived the kill`);
});

test("A3: an argument with && reaches the child as one argument and runs nothing", async (t) => {
  const repo = makeRepo(t);
  const { spawn: spawnFn, out } = capturingSpawn();
  const [result] = await runSuites([commandSuite([process.execPath, "-e", PRINT_ARGS, "a && echo SECOND"])], {
    repoRoot: repo, _spawn: spawnFn,
  });
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.deepEqual(JSON.parse(out.text.trim()), ["a && echo SECOND"]);
  assert.doesNotMatch(out.text, /^SECOND$/m, "a shell ran the second command");
});

// --- selection ---------------------------------------------------------------

const rustSuite = {
  name: "rust",
  runs: [{ cwd: ".", command: ["cargo", "test"], paths: ["crates/**", "Cargo.toml"], timeoutMs: 1, platform: "linux" }],
};
const anySuite = { name: "gate", runs: [{ cwd: ".", command: ["make", "gate"], timeoutMs: 1, platform: "any" }] };

function picked(changed, config = {}) {
  const { entries } = select({ suites: [rustSuite, anySuite], changed, repoRoot: process.cwd(), config });
  return entries.filter((entry) => entry.suite === "rust").map((entry) => entry.why);
}

test("A4: a command run is selected by a change its paths match, and not by one they miss", () => {
  assert.deepEqual(picked(["crates/a/src/lib.rs"]), ["changed: crates/a/src/lib.rs"]);
  assert.deepEqual(picked(["docs/x.md"]), []);
  assert.deepEqual(picked(["src/other.rs"]), []);
});

test("A4: the config file, the root lockfile and a selectAll path select every command run", () => {
  for (const path of ["test-runner.config.mjs", "package-lock.json", "ci/gate.sh"]) {
    assert.deepEqual(picked([path], { selectAll: ["ci/**"] }), [`fallback: ${path}`], path);
  }
});

test("A4: a command run with no paths is selected by any change", () => {
  const { entries } = select({ suites: [anySuite], changed: ["docs/x.md"], repoRoot: process.cwd() });
  assert.deepEqual(entries, [{ suite: "gate", file: "command:0", why: "changed: docs/x.md" }]);
});

test("A4: an unselected command run is not spawned in diff mode", async (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  write(repo, "docs/x.md");
  const spawned = stubSpawn();
  const out = capture();
  const code = await main([], {
    cwd: repo, _config: { suites: [rustSuite] }, _platform: "linux", _spawn: spawned.spawn, _log: out.log, _err: out.err,
  });
  assert.equal(code, 0);
  assert.equal(spawned.calls.length, 0, "a command whose paths the diff missed was run");
});

// --- {base} and unowned ------------------------------------------------------

test("A9: a main-only repository resolves its base, and {base} reaches the argv", async (t) => {
  const repo = makeRepo(t, "main");
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  const head = git(repo, "rev-parse", "HEAD").trim();
  const { spawn: spawnFn, out } = capturingSpawn();
  const log = capture();
  const code = await main(["--all"], {
    cwd: repo,
    _config: { suites: [commandSuite([process.execPath, "-e", "console.log(process.argv[1])", "{base}"])] },
    _spawn: spawnFn,
    _log: log.log,
    _err: log.err,
  });
  assert.equal(code, 0, log.errors.join("\n"));
  assert.equal(out.text.trim(), head);
});

test("A12: with no repoSuite, an unowned change exits 0 and is listed", async (t) => {
  const repo = makeRepo(t);
  write(repo, "tools/map/tests/a.test.mjs");
  commitAll(repo, "seed");
  write(repo, "scripts/x.mjs");
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo, _config: { suites: [{ name: "map", runs: [{ globs: ["tools/map/tests/*.test.mjs"] }] }] }, _log: out.log, _err: out.err,
  });
  assert.equal(code, 0);
  assert.match(out.errors.join("\n"), /unowned: 1 changed file\(s\) no suite owns: scripts\/x\.mjs/);
  assert.doesNotMatch(out.errors.join("\n"), /docs-only/);
});

test("a suite globbing a root tests/ owns the changes nothing more specific owns", async (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  write(repo, "tools/map/tests/b.test.mjs");
  commitAll(repo, "seed");
  write(repo, "src/x.mjs");
  write(repo, "tools/map/y.mjs");
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo,
    _config: { suites: [
      { name: "unit", runs: [{ globs: ["tests/*.test.mjs"] }] },
      { name: "map", runs: [{ globs: ["tools/map/tests/*.test.mjs"] }] },
    ] },
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.doesNotMatch(out.errors.join("\n"), /unowned/);
  assert.deepEqual(out.lines.sort(), [
    "map tools/map/tests/b.test.mjs fallback: tools/map/y.mjs",
    "unit tests/a.test.mjs fallback: src/x.mjs",
  ], "the root suite took src/x.mjs and left tools/map/y.mjs to its own home");
});
