// The runner's command line: --list and --suite output, the flag refusals,
// config-load validation and the orphan check.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import {
  FIX_GLOB,
  capture,
  commitAll,
  configOf,
  graphFixture,
  makeRepo,
  stubSpawn,
  suiteOf,
  write,
} from "./helpers.mjs";

// --- --list and --suite ----------------------------------------------------

test("--list prints <suite> <file> <why> and spawns no node --test", async (t) => {
  const repo = graphFixture(t);
  commitAll(repo, "fixture");
  write(repo, "plugins/fix/src/a.mjs", "export const a = 2;\n");
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo,
    _config: configOf([suiteOf("fix", [FIX_GLOB])]),
    _spawn: spawn.spawn,
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.equal(spawn.calls.length, 0, "list mode spawned a process");
  assert.ok(out.lines.length > 0);
  for (const line of out.lines) {
    const [, suite, file, why] = /^(\S+) (\S+) (.*)$/.exec(line);
    assert.equal(suite, "fix", line);
    assert.match(file, /^plugins\/fix\/tests\//);
    assert.match(why, /^(changed: |windows$|fallback: )/, line);
  }
});

test("a whole-suite run whose globs match nothing exits 1 and names the glob", async (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", "empty"], {
    cwd: repo,
    _config: configOf([suiteOf("empty", ["nowhere/*.test.mjs"])]),
    _spawn: spawn.spawn,
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 1, "an empty whole-suite run reported success");
  assert.match(out.lines.join("\n"), /no file matched nowhere\/\*\.test\.mjs/);
  assert.equal(spawn.calls.length, 0, "an empty expansion spawned node --test bare");
});

test("--suite resolves only against the injected suite list", async (t) => {
  const repo = graphFixture(t);
  const out = capture();
  const code = await main(["--suite", "repo", "--list"], {
    cwd: repo,
    _config: configOf([suiteOf("repo", [FIX_GLOB])]),
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.ok(out.lines.length > 0, "the injected suite selected nothing");
  for (const line of out.lines) assert.match(line, /^repo plugins\/fix\/tests\//, line);
});

test("a failing run exits 1 and the summary names it; all green exits 0", async (t) => {
  const repo = graphFixture(t);
  const lines = [];
  const run = (spawn) =>
    main(["--suite", "fix"], {
      cwd: repo,
      _config: configOf([suiteOf("fix", [FIX_GLOB])]),
      _spawn: spawn.spawn,
      _log: (line) => lines.push(line),
      _err: () => {},
    });

  const failing = stubSpawn({ code: 1 });
  assert.equal(await run(failing), 1);
  assert.ok(failing.calls.length > 0, "nothing was spawned at all");
  assert.match(lines.join("\n"), /\[test\] fix: FAIL/);
  assert.match(lines.join("\n"), /0\/1 run\(s\) passed/);

  assert.equal(await run(stubSpawn({ code: 0 })), 0);
  assert.match(lines.join("\n"), /1\/1 run\(s\) passed/);
});

// --- flag refusals ---------------------------------------------------------

test("--fast is refused with --wsl", async () => {
  const errors = [];
  const refuse = () => {
    throw new Error("a refused combination spawned a process");
  };
  const code = await main(["--wsl", "--fast"], {
    _spawn: refuse, _spawnSync: refuse, _log: () => {}, _err: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /--wsl cannot be combined with --fast/);
});

test("--mirror is refused outside the WSL mirror, so it cannot reinstall the host's dependencies", async () => {
  const errors = [];
  const refuse = () => {
    throw new Error("--mirror on the host spawned a process");
  };
  const code = await main(["--mirror"], {
    _spawn: refuse, _spawnSync: refuse, _log: () => {}, _err: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /--mirror is internal to --wsl/);
});

test("--wsl refuses --reporter and --orphans, rather than ignoring them", async () => {
  for (const flag of ["--reporter=agent", "--orphans"]) {
    const errors = [];
    const refuse = () => {
      throw new Error(`--wsl ${flag} spawned a process`);
    };
    const code = await main(["--wsl", flag], {
      _spawn: refuse, _spawnSync: refuse, _log: () => {}, _err: (line) => errors.push(line),
    });
    assert.equal(code, 2, flag);
    assert.match(errors.join("\n"), new RegExp(`--wsl cannot be combined with ${flag.split("=")[0]}`));
  }
});

test("--reporter=x exits 2 naming the two modes", async (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed"); // a resolvable base, so only the flag check can exit 2
  const errors = [];
  const refuse = () => {
    throw new Error("a rejected --reporter still ran a suite");
  };
  // An empty registry keeps the mutant's path cheap: without the check the
  // bad mode is accepted and the run reaches "nothing selected" as exit 0.
  const code = await main(["--reporter=x"], {
    cwd: repo,
    _config: configOf([]),
    _spawn: refuse,
    _log: () => {},
    _err: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /--reporter must be agent or default, not x/);
});

// --- R14: format and fastSkip validation exits 2 at config load -------------

test("format and fastSkip misuse exits 2 naming the field", async (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed"); // a resolvable base, so only config load can exit 2
  const cases = [
    [{ suites: [{ name: "c", runs: [{ globs: ["tests/*.test.mjs"], format: "tap" }] }] }, /\.format: applies only to a command run/],
    [{ suites: [{ name: "c", runs: [{ globs: ["tests/*.test.mjs"], fastSkip: true }] }] }, /\.fastSkip: applies only to a command run/],
    [{ suites: [{ name: "c", runs: [{ command: ["x"], format: "unknown" }] }] }, /\.format: is "unknown"/],
    [{ suites: [{ name: "c", runs: [{ command: ["pytest", "--junitxml={report}"] }] }] }, /\{report\} but the run declares no format/],
    [{ suites: [{ name: "c", runs: [{ command: ["pytest", "--junitxml={report}"], format: "tap" }] }] }, /names \{report\}\. \{report\} applies only to a junit or shim run/],
    [{ suites: [{ name: "c", runs: [{ command: ["x"], fastSkip: "no" }] }] }, /fastSkip: /],
  ];
  for (const [raw, pattern] of cases) {
    const out = capture();
    const spawn = stubSpawn();
    const code = await main(["--all"], {
      cwd: repo, _config: raw, _spawn: spawn.spawn, _log: out.log, _err: out.err,
    });
    assert.equal(code, 2, pattern.toString());
    assert.match(out.errors.join("\n"), pattern);
    assert.equal(spawn.calls.length, 0, "a refused config still ran a suite");
  }
});

// --- R13: the .mjs shim loader ----------------------------------------------

const shimConfig = () => ({
  suites: [{ name: "c", runs: [{ cwd: ".", command: [process.execPath, "-e", "console.log(1)"], timeoutMs: 60000, format: "shims/go.mjs" }] }],
});

test("a shim module that fails to load or default-exports a non-function exits 2 at load", async (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed"); // a resolvable base, so only config load can exit 2
  const cases = [
    [async () => { throw new Error("Cannot find module 'shims/go.mjs'"); }, /shims\/go\.mjs/],
    [async () => { throw new Error("module boomed"); }, /shims\/go\.mjs/],
    [async () => ({ default: 42 }), /shims\/go\.mjs/],
    [async () => ({ noDefault: true }), /shims\/go\.mjs/],
  ];
  for (const [_import, pattern] of cases) {
    const out = capture();
    const spawn = stubSpawn();
    const code = await main(["--all"], {
      cwd: repo, _config: shimConfig(), _import, _spawn: spawn.spawn, _log: out.log, _err: out.err,
    });
    assert.equal(code, 2, pattern.toString());
    assert.match(out.errors.join("\n"), pattern);
    assert.equal(spawn.calls.length, 0, "a bad shim got as far as spawning a run");
  }
});

test("a shim parse renders its rows through the readConfig -> main -> runSuites hand-off", async (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  const spawn = stubSpawn({ out: "go test chatter\n" });
  const parse = () => ({
    events: [
      { name: "go passes", outcome: "pass", ms: 5 },
      { name: "go fails", outcome: "fail", ms: 2, detail: "boom" },
      { name: "go skips", outcome: "skip", ms: null },
    ],
  });
  const out = capture();
  const code = await main(["--all"], {
    cwd: repo, _config: shimConfig(), _import: async () => ({ default: parse }), _env: {},
    _spawn: spawn.spawn, _log: out.log, _err: out.err, _writeErr: () => {},
  });
  assert.equal(code, 0);
  const lines = out.lines.join("\n");
  assert.match(lines, /✓ go passes  5ms/);
  assert.match(lines, /✗ go fails/);
  assert.match(lines, /↓ go skips/);
  assert.doesNotMatch(lines, /no tests recognised/, "a loaded shim's events went unparsed");
});

// --- --orphans -------------------------------------------------------------

test("--orphans exits 1 on a stray test and 0 once notRun lists it", async (t) => {
  const repo = makeRepo(t);
  write(repo, "plugins/x/tests/covered.test.mjs");
  write(repo, "other/y.test.mjs");
  const suites = [suiteOf("x", ["plugins/x/tests/*.test.mjs"])];

  const bad = capture();
  assert.equal(await main(["--orphans"], {
    cwd: repo, _config: configOf(suites), _log: bad.log, _err: bad.err,
  }), 1);
  assert.deepEqual(bad.lines, ["other/y.test.mjs"]);

  const exempt = capture();
  assert.equal(await main(["--orphans"], {
    cwd: repo,
    _config: configOf(suites, { notRun: [{ path: "other/y.test.mjs", reason: "fixture read by a suite" }] }),
    _log: exempt.log,
    _err: exempt.err,
  }), 0);
  assert.deepEqual(exempt.lines, []);
});

test("an ordinary run warns about orphan test files on stderr", async (t) => {
  const repo = makeRepo(t);
  write(repo, "plugins/x/tests/covered.test.mjs");
  write(repo, "other/y.test.mjs");
  const out = capture();
  await main(["--suite", "x", "--list"], {
    cwd: repo, _config: configOf([suiteOf("x", ["plugins/x/tests/*.test.mjs"])]), _log: out.log, _err: out.err,
  });
  assert.match(out.errors.join("\n"), /orphan test file\(s\) no suite runs: other\/y\.test\.mjs/);
});
