// The config file: what loads, what defaults, and what is refused. A refusal
// must name the field and the fix, because a weak model authors these files.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import { ConfigError, DEFAULT_BASE, configPathFor, normalizeConfig, validateConfig } from "../src/config.mjs";
import { capture, commitAll, makeRepo, write } from "./helpers.mjs";

const run = (extra) => ({ name: "unit", runs: [{ globs: ["tests/*.test.mjs"], ...extra }] });

/** The ConfigError message `raw` is refused with. */
function refusal(raw) {
  try {
    validateConfig(raw);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `a ${err.constructor.name} escaped: ${err.message}`);
    return err.message;
  }
  assert.fail("the config was accepted");
}

test("A2: a run with both globs and command is refused, naming the field", () => {
  const message = refusal({ suites: [run({ command: ["cargo", "test"] })] });
  assert.match(message, /^suites\[0\]\.runs\[0\]: has both "globs" and "command"/);
  assert.match(message, /example:/);
});

test("A2: a run with neither globs nor command is refused", () => {
  const message = refusal({ suites: [{ name: "unit", runs: [{ cwd: "." }] }] });
  assert.match(message, /^suites\[0\]\.runs\[0\]: has neither "globs" nor "command"/);
});

test("A2: an unknown platform is refused, listing the three", () => {
  const message = refusal({ suites: [run({ platform: "mac" })] });
  assert.match(message, /^suites\[0\]\.runs\[0\]\.platform: is "mac"\. Use one of: any, windows, linux/);
});

test("A2/A10: install on the repository root is refused", () => {
  for (const cwd of [undefined, ".", "./"]) {
    const message = refusal({ suites: [run({ cwd, install: ["npm", "ci"] })] });
    assert.match(message, /runs\[0\]\.install: cannot install at the repository root/, String(cwd));
  }
  assert.doesNotThrow(() => validateConfig({ suites: [run({ cwd: "packages/api", install: ["npm", "ci"] })] }));
});

test("a misspelt field is refused rather than ignored", () => {
  assert.match(refusal({ suites: [], selectall: [] }), /^config\.selectall: is not a known field/);
  assert.match(refusal({ suites: [run({ timeout: 5 })] }), /^suites\[0\]\.runs\[0\]\.timeout: is not a known field/);
});

test("two runs of a suite sharing a label are refused, so neither log overwrites the other", () => {
  const twin = { name: "x", runs: [{ globs: ["a/*.test.mjs"] }, { globs: ["b/*.test.mjs"] }] };
  assert.match(refusal({ suites: [twin] }), /^suites\[0\]\.runs\[1\]\.label: no label is shared with another run/);
});

test("command-only and globs-only fields are refused on the other kind", () => {
  assert.match(refusal({ suites: [run({ paths: ["src/**"] })] }), /paths: applies only to a command run/);
  const cmd = { name: "c", runs: [{ command: ["make"], exclude: ["x"] }] };
  assert.match(refusal({ suites: [cmd] }), /exclude: applies only to a globs run/);
});

test("repoSuite must name a suite, and a cwd cannot leave the repository", () => {
  assert.match(refusal({ suites: [run()], repoSuite: "nope" }), /^repoSuite: "nope" names no suite\. Use one of: unit/);
  assert.match(refusal({ suites: [run({ cwd: "../elsewhere" })] }), /cwd: must be a path relative to the repository root/);
});

test("a wsl block needs its distro", () => {
  assert.match(refusal({ suites: [], wsl: { keep: ["target"] } }), /^wsl\.distro: is missing/);
});

test("defaults fill every optional field", () => {
  const config = normalizeConfig({ suites: [run()] });
  assert.deepEqual(config.base, DEFAULT_BASE);
  assert.deepEqual(config.selectAll, []);
  assert.equal(config.repoSuite, null);
  assert.deepEqual(config.suites[0].runs[0], {
    cwd: ".", timeoutMs: 600000, platform: "any", globs: ["tests/*.test.mjs"],
  });
});

test("--config outside the repository is refused", () => {
  assert.throws(() => configPathFor({ repoRoot: "/r/repo", override: "../other.mjs" }), ConfigError);
  assert.equal(configPathFor({ repoRoot: "/r/repo", override: "ci/tests.config.mjs" }), "ci/tests.config.mjs");
});

test("a repository with no config file exits 2 with an example to copy", async (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  const out = capture();
  assert.equal(await main(["--list"], { cwd: repo, _log: out.log, _err: out.err }), 2);
  assert.match(out.errors.join("\n"), /no config at test-runner\.config\.mjs[\s\S]*export default/);
});

test("an invalid config file exits 2 naming its path and the field", async (t) => {
  const repo = makeRepo(t);
  write(repo, "test-runner.config.mjs", 'export default { suites: [{ name: "x", runs: [{ cwd: "." }] }] };\n');
  commitAll(repo, "seed");
  const out = capture();
  assert.equal(await main(["--list"], { cwd: repo, _log: out.log, _err: out.err }), 2);
  assert.match(out.errors.join("\n"), /test-runner\.config\.mjs: suites\[0\]\.runs\[0\]: has neither/);
});
