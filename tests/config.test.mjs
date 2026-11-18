// The config file: what loads, what defaults, and what is refused. A refusal
// must name the field and the fix, because a weak model authors these files.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import { ConfigError, DEFAULT_BASE, DEFAULT_SLOW_MS, configPathFor, normalizeConfig, validateConfig } from "../src/config.mjs";
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

test("a run with both globs and command is refused, naming the field", () => {
  const message = refusal({ suites: [run({ command: ["cargo", "test"] })] });
  assert.match(message, /^suites\[0\]\.runs\[0\]: has both "globs" and "command"/);
  assert.match(message, /example:/);
});

test("a run with neither globs nor command is refused", () => {
  const message = refusal({ suites: [{ name: "unit", runs: [{ cwd: "." }] }] });
  assert.match(message, /^suites\[0\]\.runs\[0\]: has neither "globs" nor "command"/);
});

test("an unknown platform is refused, listing the three", () => {
  const message = refusal({ suites: [run({ platform: "mac" })] });
  assert.match(message, /^suites\[0\]\.runs\[0\]\.platform: is "mac"\. Use one of: any, windows, linux/);
});

test("A2/A10: install on the repository root is refused", () => {
  for (const cwd of [undefined, ".", "./", "./.", ""]) {
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

test("paths is accepted on a globs run; exclude stays command-refused", () => {
  assert.doesNotThrow(() => validateConfig({ suites: [run({ paths: ["src/**"] })] }));
  const cmd = { name: "c", runs: [{ command: ["make"], exclude: ["x"] }] };
  assert.match(refusal({ suites: [cmd] }), /exclude: applies only to a globs run/);
});

test("repoSuite must name a suite, and a cwd cannot leave the repository", () => {
  assert.match(refusal({ suites: [run()], repoSuite: "nope" }), /^repoSuite: "nope" names no suite\. Use one of: unit/);
  assert.match(refusal({ suites: [run({ cwd: "../elsewhere" })] }), /cwd: must be a path relative to the repository root/);
  assert.match(refusal({ suites: [run({ cwd: "packages\\api" })] }), /cwd: contains a backslash\. Use forward slashes/);
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

test("an empty paths list is refused for both run kinds, with the matching example", () => {
  const globs = refusal({ suites: [run({ paths: [] })] });
  assert.match(globs, /^suites\[0\]\.runs\[0\]\.paths: must be an array of non-empty strings/);
  assert.match(globs, /example: \{ globs:/, "a globs run was given the command example");

  const command = refusal({ suites: [{ name: "rust", runs: [{ command: ["cargo", "test"], paths: [] }] }] });
  assert.match(command, /^suites\[0\]\.runs\[0\]\.paths: must be an array of non-empty strings/);
  assert.match(command, /example: \{ command:/, "a command run was given the globs example");
});

test("format and fastSkip are refused on a globs run, naming the field and the run kind", () => {
  assert.match(refusal({ suites: [run({ format: "tap" })] }), /^suites\[0\]\.runs\[0\]\.format: applies only to a command run/);
  assert.match(refusal({ suites: [run({ fastSkip: true })] }), /^suites\[0\]\.runs\[0\]\.fastSkip: applies only to a command run/);
});

test("format accepts the three built-ins and a repository-relative .mjs shim, and refuses the rest", () => {
  for (const format of ["tap", "libtest", "junit"]) {
    assert.doesNotThrow(() => validateConfig({ suites: [{ name: "c", runs: [{ command: ["x"], format }] }] }), format);
  }
  assert.doesNotThrow(() => validateConfig({ suites: [{ name: "c", runs: [{ command: ["x"], format: "scripts/parse-go.mjs" }] }] }));
  const message = refusal({ suites: [{ name: "c", runs: [{ command: ["x"], format: "unknown" }] }] });
  assert.match(message, /^suites\[0\]\.runs\[0\]\.format: is "unknown"/);
  assert.match(message, /tap, libtest, junit/);
  assert.match(message, /example: /);
  for (const bad of ["go.json", "C:\\repo\\parse.mjs", "../parse.mjs", "scripts\\parse.mjs"]) {
    assert.match(refusal({ suites: [{ name: "c", runs: [{ command: ["x"], format: bad }] }] }), /^suites\[0\]\.runs\[0\]\.format: /, bad);
  }
});

test("fastSkip must be a boolean, default off", () => {
  assert.doesNotThrow(() => validateConfig({ suites: [{ name: "c", runs: [{ command: ["x"], fastSkip: false }] }] }));
  const message = refusal({ suites: [{ name: "c", runs: [{ command: ["x"], fastSkip: "no" }] }] });
  assert.match(message, /^suites\[0\]\.runs\[0\]\.fastSkip: /);
  assert.match(message, /default off/);
  assert.match(message, /example: /);
});

test("cargo opts a command run into per-crate selection and is refused on a globs run", () => {
  assert.doesNotThrow(() => validateConfig({
    suites: [{ name: "c", runs: [{ command: ["cargo", "test"], cargo: true }] }],
  }));
  const message = refusal({ suites: [{ name: "c", runs: [{ command: ["cargo", "test"], cargo: "yes" }] }] });
  assert.match(message, /^suites\[0\]\.runs\[0\]\.cargo: /);
  assert.match(message, /must be true or false/);
  assert.match(message, /example: /);
  const globs = refusal({ suites: [run({ cargo: true })] });
  assert.match(globs, /^suites\[0\]\.runs\[0\]\.cargo: applies only to a command run/);
  assert.match(globs, /example: \{ command:/, "a globs run was given the globs example");
});

test("{report} names the junit or shim token and is refused without format or on stdout formats", () => {
  const junit = (extra) => ({ name: "c", runs: [{ command: ["pytest", "--junitxml={report}"], ...extra }] });
  assert.doesNotThrow(() => validateConfig({ suites: [junit({ format: "junit" })] }));
  assert.doesNotThrow(() => validateConfig({ suites: [junit({ format: "scripts/parse-go.mjs" })] }));
  assert.match(refusal({ suites: [junit()] }), /^suites\[0\]\.runs\[0\]\.command: names \{report\} but the run declares no format/);
  assert.match(refusal({ suites: [junit({ format: "tap" })] }), /\.command: names \{report\}\. \{report\} applies only to a junit or shim run; "tap" parses stdout/);
  assert.match(refusal({ suites: [junit({ format: "libtest" })] }), /\.command: names \{report\}\. \{report\} applies only to a junit or shim run; "libtest" parses stdout/);
});

test("a key given as undefined still takes its default", () => {
  const config = normalizeConfig({ suites: [run({ cwd: undefined, timeoutMs: undefined, platform: undefined })] });
  const [only] = config.suites[0].runs;
  assert.equal(only.cwd, ".");
  assert.equal(only.timeoutMs, 600000);
  assert.equal(only.platform, "any");
});

test("slowMs must be a positive whole number, and defaults to 300", () => {
  for (const value of [0, -1, 1.5, "300", Number.NaN]) {
    const message = refusal({ suites: [run()], slowMs: value });
    assert.match(message, /^slowMs: /, String(value));
    assert.match(message, /example: /, String(value));
  }
  assert.equal(DEFAULT_SLOW_MS, 300);
  assert.equal(normalizeConfig({ suites: [run()] }).slowMs, DEFAULT_SLOW_MS);
  assert.equal(normalizeConfig({ suites: [run()], slowMs: 150 }).slowMs, 150);
  assert.doesNotThrow(() => validateConfig({ suites: [run()], slowMs: 300 }));
});

test('select: "paths" needs a globs run, and every globs run needs non-empty paths', () => {
  const pathsSuite = (run, extra = {}) => ({ name: "unit", select: "paths", runs: [run], ...extra });
  assert.doesNotThrow(() => validateConfig({ suites: [pathsSuite({ globs: ["tests/*.test.mjs"], paths: ["src/**"] })] }));
  assert.doesNotThrow(() => validateConfig({ suites: [run()] }), "graph is the default and needs no paths");
  assert.equal(normalizeConfig({ suites: [run()] }).suites[0].select, "graph");

  const missingPaths = refusal({ suites: [pathsSuite({ globs: ["tests/*.test.mjs"] })] });
  assert.match(missingPaths, /^suites\[0\]\.runs\[0\]\.paths: /);
  assert.match(missingPaths, /select: "paths"/, "the refusal did not name the mode it came from");
  assert.match(missingPaths, /example: /);

  const noGlobs = refusal({ suites: [pathsSuite({ command: ["make"], paths: ["src/**"] })] });
  assert.match(noGlobs, /^suites\[0\]\.select: /);
  assert.match(noGlobs, /globs run/);
  assert.match(noGlobs, /example: /);

  const unknown = refusal({ suites: [pathsSuite({ globs: ["tests/*.test.mjs"], paths: ["src/**"] }, { select: "suite" })] });
  assert.match(unknown, /^suites\[0\]\.select: is "suite"/);
  assert.match(unknown, /graph, paths/);
  assert.match(unknown, /example: /);
});

test("runner is accepted on a globs run and refused on a command run, with envFile, or empty", () => {
  assert.doesNotThrow(() => validateConfig({
    suites: [run({ runner: ["python", "-m", "pytest"] })],
  }));
  assert.match(refusal({ suites: [{ name: "unit", runs: [{ command: ["cargo", "test"], runner: ["python", "-m", "pytest"] }] }] }),
    /^suites\[0\]\.runs\[0\]\.runner: applies only to a globs run/);
  assert.match(refusal({ suites: [run({ envFile: ".env.test", runner: ["python", "-m", "pytest"] })] }),
    /^suites\[0\]\.runs\[0\]\.runner: .*envFile/);
  assert.match(refusal({ suites: [run({ runner: [] })] }), /^suites\[0\]\.runs\[0\]\.runner: must be an array of non-empty strings/);
  assert.match(refusal({ suites: [run({ runner: [""] })] }), /^suites\[0\]\.runs\[0\]\.runner: /);
  assert.match(refusal({ suites: [run({ runner: ["python", ""] })] }), /\.runner: /);
});
