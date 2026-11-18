// Colour and the slow threshold: the env main() hands each child, and the
// flag and config precedence that decide it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import {
  FIX_GLOB, capture, commitAll, configOf, graphFixture, pathsFixture, stubSpawn, suiteOf, write,
} from "./helpers.mjs";

// --- colour and the slow threshold -----------------------------------------

test("the parent resolves colour once, agent mode included", async (t) => {
  const repo = graphFixture(t);
  const colourFor = async (env) => {
    const spawn = stubSpawn();
    const code = await main(["--suite", "fix"], {
      cwd: repo,
      _config: configOf([suiteOf("fix", [FIX_GLOB])]),
      _env: env,
      stream: { isTTY: true },
      _spawn: spawn.spawn,
      _log: () => {},
      _err: () => {},
    });
    assert.equal(code, 0);
    return spawn.calls[0].opts.env.TEST_COLOUR;
  };

  assert.equal(await colourFor({}), "1", "a TTY in default mode is not coloured");
  assert.equal(await colourFor({ CLAUDECODE: "1" }), "0", "agent mode stayed coloured");
  assert.equal(await colourFor({ CLAUDECODE: "1", FORCE_COLOR: "1" }), "1", "FORCE_COLOR lost to agent mode");
  assert.equal(await colourFor({ NO_COLOR: "1" }), "0");
  assert.equal(await colourFor({ FORCE_COLOR: "1" }), "1");
  assert.equal(await colourFor({ FORCE_COLOR: "0" }), "0");
});

test("--reporter=agent never colours unless the user set FORCE_COLOR", async (t) => {
  const repo = graphFixture(t);
  const colourFor = async ({ env, isTTY }) => {
    const spawn = stubSpawn();
    const code = await main(["--suite", "fix", "--reporter=agent"], {
      cwd: repo,
      _config: configOf([suiteOf("fix", [FIX_GLOB])]),
      _env: env,
      stream: { isTTY },
      _spawn: spawn.spawn,
      _log: () => {},
      _err: () => {},
    });
    assert.equal(code, 0);
    return spawn.calls[0].opts.env.TEST_COLOUR;
  };

  assert.equal(await colourFor({ env: {}, isTTY: true }), "0", "a TTY coloured an agent run");
  assert.equal(await colourFor({ env: { CI: "1" }, isTTY: false }), "0", "CI coloured an agent run");
  assert.equal(await colourFor({ env: { FORCE_COLOR: "1" }, isTTY: false }), "1", "FORCE_COLOR lost to agent mode");
});

test("--slow-ms refuses anything but a positive whole number", async (t) => {
  const repo = graphFixture(t);
  for (const argv of [["--slow-ms", "abc"], ["--slow-ms", "0"], ["--slow-ms"], ["--slow-ms", "1.5"]]) {
    const errors = [];
    const code = await main(["--suite", "fix", ...argv], {
      cwd: repo,
      _config: configOf([suiteOf("fix", [FIX_GLOB])]),
      _spawn: () => assert.fail(`a rejected --slow-ms ran a suite: ${argv.join(" ")}`),
      _log: () => {},
      _err: (line) => errors.push(line),
    });
    assert.equal(code, 2, argv.join(" "));
    assert.match(errors.join("\n"), /--slow-ms needs a positive whole number/, argv.join(" "));
    assert.doesNotMatch(errors.join("\n"), /unknown argument/, `${argv.join(" ")} was merely unknown, not validated`);
  }
});

test("TEST_COLOUR overrides the TTY answer for command rows", async (t) => {
  const repo = graphFixture(t);
  const colourFor = async ({ env, isTTY }) => {
    const spawn = stubSpawn();
    const code = await main(["--suite", "fix"], {
      cwd: repo,
      _config: configOf([suiteOf("fix", [FIX_GLOB])]),
      _env: env,
      stream: { isTTY },
      _spawn: spawn.spawn,
      _log: () => {},
      _err: () => {},
    });
    assert.equal(code, 0);
    return spawn.calls[0].opts.env.TEST_COLOUR;
  };

  assert.equal(await colourFor({ env: { TEST_COLOUR: "1" }, isTTY: false }), "1", "the override lost to non-TTY");
  assert.equal(await colourFor({ env: { TEST_COLOUR: "0" }, isTTY: true }), "0", "the override lost to TTY");
});

test("--slow-ms beats the config's slowMs, which beats 300", async (t) => {
  const repo = graphFixture(t);
  const slowFor = async (argv, extra = {}) => {
    const spawn = stubSpawn();
    const code = await main(["--suite", "fix", ...argv], {
      cwd: repo,
      _config: configOf([suiteOf("fix", [FIX_GLOB])], extra),
      _spawn: spawn.spawn,
      _log: () => {},
      _err: () => {},
    });
    assert.equal(code, 0);
    return spawn.calls[0].opts.env.SLOW_MS;
  };

  assert.equal(await slowFor([]), "300");
  assert.equal(await slowFor([], { slowMs: 150 }), "150");
  assert.equal(await slowFor(["--slow-ms", "500"], { slowMs: 150 }), "500");
});

// --- the wide-run notice ----------------------------------------------------

/** One suite over `a.test.mjs`, `count` sources no test reaches. The sources are
 *  committed and then all changed, so every one is an undetermined radius. */
function wideFixture(t, count = 12) {
  const repo = pathsFixture(t);
  const paths = [];
  for (let i = 1; i <= count; i++) {
    const path = `packages/api/src/x${i}.mjs`;
    write(repo, path, "export const x = 1;\n");
    paths.push(path);
  }
  commitAll(repo, "fixture");
  for (const path of paths) write(repo, path, "export const x = 2;\n");
  return { repo, paths };
}

const apiConfig = (globs) => configOf([suiteOf("api", globs)], { packages: ["packages/*"] });
const wideLines = (errors) => errors.filter((line) => line.includes("wide run: the blast radius"));
const MORE_LINE = "[test] wide run: and 2 more (see --list)";
const wideText = (path) =>
  `[test] wide run: the blast radius of '${path}' could not be determined, so api run whole`;

test("a wide run is announced once with the path and the suite", async (t) => {
  const repo = pathsFixture(t);
  commitAll(repo, "fixture");
  write(repo, "packages/api/src/n.mjs", "export const n = 2;\n");
  const out = capture();
  const code = await main([], {
    cwd: repo,
    _config: apiConfig(["packages/api/tests/a.test.mjs", "packages/api/tests/b.test.mjs"]),
    _env: {},
    _spawn: stubSpawn().spawn,
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.deepEqual(wideLines(out.errors), [wideText("packages/api/src/n.mjs")]);

  // A change the graph reaches narrows the suite, so nothing is undetermined.
  const reached = pathsFixture(t);
  commitAll(reached, "fixture");
  write(reached, "packages/api/src/m.mjs", "export const m = 2;\n");
  const graphOut = capture();
  const graphCode = await main([], {
    cwd: reached,
    _config: apiConfig(["packages/api/tests/*.test.mjs"]),
    _env: {},
    _spawn: stubSpawn().spawn,
    _log: graphOut.log,
    _err: graphOut.err,
  });
  assert.equal(graphCode, 0);
  assert.deepEqual(wideLines(graphOut.errors), [], "a reached change printed a wide-run notice");
});

test("the wide-run notice is amber when colour is on", async (t) => {
  const repo = pathsFixture(t);
  commitAll(repo, "fixture");
  write(repo, "packages/api/src/n.mjs", "export const n = 2;\n");
  const notice = async (env) => {
    const out = capture();
    const code = await main([], {
      cwd: repo,
      _config: apiConfig(["packages/api/tests/a.test.mjs"]),
      _env: env,
      _spawn: stubSpawn().spawn,
      _log: out.log,
      _err: out.err,
    });
    assert.equal(code, 0);
    return wideLines(out.errors);
  };

  assert.deepEqual(await notice({ FORCE_COLOR: "1" }), [`\x1b[33m${wideText("packages/api/src/n.mjs")}\x1b[39m`]);
  assert.deepEqual(await notice({ NO_COLOR: "1" }), [wideText("packages/api/src/n.mjs")]);
});

test("a deliberate whole-repo change prints no wide-run notice", async (t) => {
  const repo = pathsFixture(t);
  write(repo, "test-runner.config.mjs", "export default {};\n");
  write(repo, "package-lock.json", "{}\n");
  commitAll(repo, "fixture");
  write(repo, "test-runner.config.mjs", "export default { a: 1 };\n");
  write(repo, "package-lock.json", '{ "a": 1 }\n');
  write(repo, "scripts/keep.test.mjs", "export const k = 2;\n");

  const spawn = stubSpawn();
  const out = capture();
  const code = await main([], {
    cwd: repo,
    _config: configOf([suiteOf("api", ["packages/api/tests/a.test.mjs"])], {
      packages: ["packages/*"],
      selectAll: ["scripts/keep.test.mjs"],
    }),
    _spawn: spawn.spawn,
    _log: out.log,
    _err: out.err,
  });
  assert.equal(code, 0);
  assert.deepEqual(wideLines(out.errors), [], "a config, lockfile or selectAll change was called undetermined");
  assert.ok(spawn.calls[0].args.join(" ").includes("a.test.mjs"), "the select-all change ran nothing");
});

test("twelve undetermined paths print ten notices and a pointer to --list", async (t) => {
  const { repo, paths } = wideFixture(t, 12);
  const out = capture();
  const code = await main([], {
    cwd: repo, _config: apiConfig(["packages/api/tests/a.test.mjs"]), _env: {},
    _spawn: stubSpawn().spawn, _log: out.log, _err: out.err,
  });
  assert.equal(code, 0);
  const lines = wideLines(out.errors);
  assert.equal(lines.length, 10, `${lines.length} notice(s): ${lines.join(" | ")}`);
  assert.ok(out.errors.includes(MORE_LINE), JSON.stringify(out.errors));

  const named = new Set(paths);
  const shown = new Set();
  for (const line of lines) {
    const path = /^\[test\] wide run: the blast radius of '(.+)' could not be determined, so api run whole$/.exec(line);
    assert.ok(path, line);
    assert.ok(named.has(path[1]), `${path[1]} was never changed`);
    shown.add(path[1]);
  }
  assert.equal(shown.size, 10, "a path was announced twice");
});

test("--if-selected stays silent, --list is uncapped, and agent mode is capped", async (t) => {
  const { repo, paths } = wideFixture(t, 12);
  const run = async (argv) => {
    const out = capture();
    const code = await main(argv, {
      cwd: repo, _config: apiConfig(["packages/api/tests/a.test.mjs"]), _env: {},
      _spawn: stubSpawn().spawn, _log: out.log, _err: out.err,
    });
    assert.equal(code, 0, argv.join(" ") || "default");
    return out;
  };

  const ci = await run(["--suite", "api", "--if-selected"]);
  assert.deepEqual(wideLines(ci.errors), [], "--if-selected printed a wide-run notice");

  const list = await run(["--list"]);
  const listed = wideLines(list.errors).map((line) => /'(.+)'/.exec(line)[1]);
  assert.deepEqual(listed.sort(), [...paths].sort(), "--list capped the notices");
  assert.ok(!list.errors.includes(MORE_LINE), "--list printed the capped pointer");

  const agent = await run(["--reporter=agent"]);
  assert.equal(wideLines(agent.errors).length, 10, "agent mode printed a different count");
  assert.ok(agent.errors.includes(MORE_LINE), "agent mode lost the pointer");

  const plain = await run([]);
  assert.equal(wideLines(plain.errors).length, 10, "default mode printed a different count");
  assert.ok(plain.errors.includes(MORE_LINE), "default mode lost the pointer");
});
