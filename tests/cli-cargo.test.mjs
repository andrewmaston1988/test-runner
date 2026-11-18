// Cargo through main(): the degraded-metadata notice and what --if-selected
// counts as a touched diff when the entries are crate keys.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import { capture, cliSpawnSync, commitAll, configOf, makeRepo, stubSpawn, tempRoot, write } from "./helpers.mjs";

// --- cargo: the degraded-metadata notice and --if-selected (cargo R12, R16) ---

const cargoConfig = (labelled) => configOf([{
  name: "rust",
  runs: [{
    cwd: ".", command: ["cargo", "test"], cargo: true, timeoutMs: 600000,
    ...(labelled ? { label: "test" } : {}),
  }],
}]);

/** A committed repository whose uncommitted diff touches crate files; the
 *  metadata read itself is answered by the injected stub. `files` is the list
 *  of changed paths the diff carries. */
function cargoRepo(t, files = ["crates/alpha/src/lib.rs"]) {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  for (const rel of files) write(repo, rel, "pub fn changed() {}\n");
  return repo;
}

test("a degraded metadata read prints one labelled notice and still selects the run whole", async (t) => {
  const repo = cargoRepo(t, ["crates/alpha/src/lib.rs", "crates/beta/src/lib.rs"]);
  const stub = cliSpawnSync(repo, { fail: 1 });
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo, _config: cargoConfig(true), _spawnSync: stub.spawnSync, _spawn: stubSpawn().spawn,
    _log: out.log, _err: out.err,
  });
  assert.equal(code, 0, out.errors.join("\n"));
  const notices = out.errors.filter((line) => line.includes("cargo metadata failed"));
  assert.deepEqual(notices, [
    "[test] rust[test]: cargo metadata failed (exit 1: boom); selecting the run whole",
  ], out.errors.join("\n"));
  // The degraded run reports the whole key; the rest of the diff selects normally.
  assert.deepEqual(out.lines, ["rust command:test changed: crates/alpha/src/lib.rs"]);
  assert.equal(stub.calls.filter((call) => call.cmd === "cargo").length, 1, "select did not see main's spawnSync");
});

test("the notice names an unlabelled run by its suite alone, once per entry", async (t) => {
  const repo = cargoRepo(t);
  const stub = cliSpawnSync(repo, { fail: "throw" });
  const out = capture();
  const code = await main(["--list"], {
    cwd: repo, _config: cargoConfig(false), _spawnSync: stub.spawnSync, _spawn: stubSpawn().spawn,
    _log: out.log, _err: out.err,
  });
  assert.equal(code, 0, out.errors.join("\n"));
  assert.deepEqual(out.errors.filter((line) => line.includes("cargo metadata failed")), [
    "[test] rust: cargo metadata failed (spawn failed: boom); selecting the run whole",
  ], out.errors.join("\n"));
});

test("--if-selected counts a diff whose entries are only crate keys as touched", async (t) => {
  const repo = cargoRepo(t, ["crates/beta/src/lib.rs"]);
  const stub = cliSpawnSync(repo); // a healthy fixture: select maps the crate change
  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", "rust", "--if-selected", "--against", "HEAD"], {
    cwd: repo, _config: cargoConfig(true), _platform: "win32", _spawn: spawn.spawn,
    _spawnSync: stub.spawnSync, _log: out.log, _err: out.err, _tmpdir: tempRoot(t),
  });
  assert.equal(code, 0, out.errors.join("\n"));
  assert.ok(spawn.calls.length > 0, "a crate-key diff did not count as touched");
  assert.deepEqual(spawn.calls[0].args, ["test"], "the suite did not run whole, as declared");
});
