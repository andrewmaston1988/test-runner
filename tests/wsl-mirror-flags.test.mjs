// What the host forwards into the WSL mirror: colour and WSLENV, --slow-ms,
// wsl.keep, and cargo's whole-run hand-off. The fake spawnSync lives in
// `wsl-harness.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import { configOf } from "./helpers.mjs";
import { SOURCE, TREE, WSL, makeFake, makeFs, run } from "./wsl-harness.mjs";

// --- colour and the slow threshold across the mirror ------------------------

test("the wsl.exe run carries TEST_COLOUR and keeps a pre-existing WSLENV", async () => {
  const fake = makeFake({ mirrorOrigin: SOURCE, mirrorExists: true });
  await run(fake, { colour: true, env: { WSLENV: "FOO/p" } });

  const last = fake.calls[fake.calls.length - 1];
  assert.equal(last.cmd, "wsl.exe");
  assert.equal(last.opts.env.TEST_COLOUR, "1");
  assert.equal(last.opts.env.WSLENV, "FOO/p:TEST_COLOUR/u", "the existing WSLENV entry was dropped");
});

test("a plain --wsl run tells the mirror not to colour", async () => {
  const fake = makeFake({ mirrorOrigin: SOURCE, mirrorExists: true });
  await run(fake);
  const last = fake.calls[fake.calls.length - 1];
  assert.equal(last.opts.env.TEST_COLOUR, "0");
  assert.equal(last.opts.env.WSLENV, "TEST_COLOUR/u");
});

test("--wsl forwards --slow-ms into the mirror's runner args", async () => {
  const fake = makeFake({ mirrorOrigin: SOURCE, mirrorExists: true });
  const code = await main(["--wsl", "--slow-ms", "500"], {
    _config: configOf([{ name: "repo", runs: [{ globs: ["tests/*.test.mjs"] }] }], { wsl: WSL }),
    _spawnSync: fake.spawn,
    _fs: makeFs(true),
    _env: {},
    _log: () => {},
    _err: () => {},
  });

  assert.equal(code, 0);
  const last = fake.calls[fake.calls.length - 1];
  const args = last.args.slice(last.args.indexOf("--") + 1);
  assert.ok(args.includes("--mirror"), args.join(" "));
  assert.deepEqual(args.slice(-2), ["--slow-ms", "500"], args.join(" "));
});

test(".venv is not kept unconditionally, and wsl.keep adds it", async () => {
  const bare = makeFake();
  await run(bare);
  const args = bare.calls.find((c) => c.args.includes(TREE)).args;
  const excluded = args.filter((arg, i) => args[i - 1] === "--exclude");
  assert.ok(!excluded.includes(".venv"), `the mirror keeps .venv unconditionally: ${excluded.join(", ")}`);

  const kept = makeFake();
  await run(kept, { wsl: { ...WSL, keep: [".venv"] } });
  const keptArgs = kept.calls.find((c) => c.args.includes(TREE)).args;
  assert.ok(keptArgs.join(" ").includes("--exclude .venv"), keptArgs.join(" "));
});

test("--wsl hands the whole run to the mirror and never builds a -p list host-side", async () => {
  const fake = makeFake({ mirrorOrigin: SOURCE, mirrorExists: true });
  const code = await main(["--wsl"], {
    _config: configOf([{ name: "rust", runs: [{ command: ["cargo", "test"], cargo: true }] }], { wsl: WSL }),
    _spawnSync: fake.spawn,
    _fs: makeFs(true),
    _env: {},
    _log: () => {},
    _err: () => {},
  });

  assert.equal(code, 0);
  const last = fake.calls[fake.calls.length - 1];
  const args = last.args.slice(last.args.indexOf("--") + 1);
  assert.ok(args.includes("--all"), args.join(" "));
  assert.ok(args.includes("--mirror"), args.join(" "));
  assert.ok(!args.includes("-p"), `the host built a -p list: ${args.join(" ")}`);
});
