// The cargo graph and its derived claim set: which crates a changed path maps
// to, and when the run is selected whole instead.

import { test } from "node:test";
import assert from "node:assert/strict";

import { select } from "../src/select.mjs";
import { cliSpawnSync, configOf, makeRepo, write } from "./helpers.mjs";

// --- the cargo graph --------------------------------------------------------

const cargoSuite = (extra = {}) => ({
  name: "rust",
  runs: [{ label: "test", cwd: ".", command: ["cargo", "test"], cargo: true, timeoutMs: 600000, ...extra }],
});

const cargoEntries = (repo, changed, options = {}) => {
  const stub = cliSpawnSync(repo, options.stub ?? {});
  const result = select({
    suites: options.suites ?? [cargoSuite()], changed, repoRoot: repo,
    config: configOf(options.suites ?? [cargoSuite()]),
    _spawnSync: options.spawn ?? stub.spawnSync,
    ...(options.select ?? {}),
  });
  return { result, stub, suites: options.suites ?? [cargoSuite()] };
};

test("a changed crate file under explicit paths selects the per-crate keys", (t) => {
  const repo = makeRepo(t);
  const { result } = cargoEntries(repo, ["crates/alpha/src/lib.rs"], {
    suites: [cargoSuite({ paths: ["crates/**", "Cargo.toml", "Cargo.lock"] })],
  });
  assert.deepEqual(result.entries, [
    { suite: "rust", file: "command:test#alpha", why: "paths: crates/alpha/src/lib.rs" },
    { suite: "rust", file: "command:test#beta", why: "paths: crates/alpha/src/lib.rs" },
    { suite: "rust", file: "command:test#delta", why: "paths: crates/alpha/src/lib.rs" },
    { suite: "rust", file: "command:test#epsilon", why: "paths: crates/alpha/src/lib.rs" },
    { suite: "rust", file: "command:test#gamma", why: "paths: crates/alpha/src/lib.rs" },
  ]);
  assert.ok(!result.entries.some((entry) => entry.file === "command:test"), JSON.stringify(result.entries));
  assert.equal(result.degraded.length, 0, JSON.stringify(result.degraded));
});

test("a changed Cargo.lock selects the run whole, never per crate", (t) => {
  const repo = makeRepo(t);
  const { result } = cargoEntries(repo, ["Cargo.lock"]);
  assert.deepEqual(result.entries, [
    { suite: "rust", file: "command:test", why: "changed: Cargo.lock" },
  ]);
  assert.equal(result.degraded.length, 0, JSON.stringify(result.degraded));

  // A root-package workspace's manifest is both the workspace's and the root
  // member's own: still the whole key, never the root crate's key.
  const rooted = cargoEntries(repo, ["Cargo.toml"], { stub: { rootPackage: "app" } });
  assert.deepEqual(rooted.result.entries, [
    { suite: "rust", file: "command:test", why: "changed: Cargo.toml" },
  ]);
});

test("a matched-but-unattributable path claims whole on the healthy graph that still maps crates", (t) => {
  const repo = makeRepo(t);
  const whole = cargoEntries(repo, ["docs/x.txt"], { suites: [cargoSuite({ paths: ["docs/**"] })] });
  assert.deepEqual(whole.result.entries, [
    { suite: "rust", file: "command:test", why: "paths: docs/x.txt" },
  ]);
  assert.equal(whole.result.degraded.length, 0, JSON.stringify(whole.result.degraded));
  // The sibling control: the same fixture's healthy graph attributes a crate change.
  const mapped = cargoEntries(repo, ["crates/beta/src/lib.rs"]);
  assert.deepEqual(mapped.result.entries, [
    { suite: "rust", file: "command:test#beta", why: "changed: crates/beta/src/lib.rs" },
    { suite: "rust", file: "command:test#epsilon", why: "changed: crates/beta/src/lib.rs" },
    { suite: "rust", file: "command:test#gamma", why: "changed: crates/beta/src/lib.rs" },
  ]);
});

test("a failed metadata read selects the run whole and records one degrade", (t) => {
  const repo = makeRepo(t);
  const cases = [
    { stub: { fail: 1 }, matching: { error: "exit 1: boom" } },
    { stub: { fail: "throw" }, matching: { error: "spawn failed: boom" } },
    { stub: { metadata: { workspace_root: "D:/elsewhere", packages: [] } }, prefix: "workspace root outside the repository: " },
  ];
  for (const { stub, matching, prefix } of cases) {
    const { result } = cargoEntries(repo, ["crates/alpha/src/lib.rs"], { stub });
    assert.deepEqual(result.entries, [
      { suite: "rust", file: "command:test", why: "changed: crates/alpha/src/lib.rs" },
    ], JSON.stringify(result.degraded));
    assert.equal(result.degraded.length, 1, "every degrade recorded a second entry");
    assert.deepEqual(result.degraded[0].suite, "rust");
    assert.deepEqual(result.degraded[0].runIndex, 0);
    if (matching) assert.deepEqual(result.degraded[0].error, matching.error);
    else assert.ok(result.degraded[0].error.startsWith(prefix), result.degraded[0].error);
  }
});

test("the metadata read is cached per run cwd, not per run or per path", (t) => {
  const repo = makeRepo(t);
  const suites = [{
    name: "rust",
    runs: [
      { label: "a", cwd: ".", command: ["cargo", "test"], cargo: true, timeoutMs: 600000 },
      { label: "b", cwd: ".", command: ["cargo", "test"], cargo: true, timeoutMs: 600000 },
      { label: "c", cwd: "sub", command: ["cargo", "test"], cargo: true, timeoutMs: 600000 },
    ],
  }];
  const { result, stub } = cargoEntries(repo, ["crates/alpha/src/lib.rs", "crates/beta/src/lib.rs"], { suites });
  const cwds = stub.calls.filter((call) => call.cmd === "cargo").map((call) => call.opts.cwd);
  assert.equal(new Set(cwds.map((cwd) => cwd.toLowerCase())).size, 2, `two distinct cwds expected: ${JSON.stringify(cwds)}`);
  assert.equal(cwds.length, 2, `one spawn per cwd expected, got ${cwds.length}`);
  assert.equal(cwds.filter((cwd) => cwd.toLowerCase() === repo.toLowerCase()).length, 1,
    `the two same-cwd runs spawned twice: ${JSON.stringify(cwds)}`);
  assert.equal(result.entries.length, 15, JSON.stringify(result.entries));
});

// --- the derived claim set (R5 select, R11) ---------------------------------

test("a root-package workspace maps a root change to the root crate through select", (t) => {
  const repo = makeRepo(t);
  const { result } = cargoEntries(repo, ["src/lib.rs"], { stub: { rootPackage: "app" } });
  assert.deepEqual(result.entries, [
    { suite: "rust", file: "command:test#app", why: "changed: src/lib.rs" },
  ]);
  // The root member's directory catch-all also claims docs under it: one
  // over-selection costs seconds, a dropped test costs the whole gate.
  const docs = cargoEntries(repo, ["README.md"], { stub: { rootPackage: "app" } });
  assert.deepEqual(docs.result.entries, [
    { suite: "rust", file: "command:test#app", why: "changed: README.md" },
  ]);
});

test("the derived claim set maps without paths, gates docs out, and keeps the workspace files whole", (t) => {
  const repo = makeRepo(t);
  // The base crate maps with `changed:` reasons through the derived gate alone.
  const mapped = cargoEntries(repo, ["crates/alpha/src/lib.rs"]);
  assert.deepEqual(mapped.result.entries, [
    { suite: "rust", file: "command:test#alpha", why: "changed: crates/alpha/src/lib.rs" },
    { suite: "rust", file: "command:test#beta", why: "changed: crates/alpha/src/lib.rs" },
    { suite: "rust", file: "command:test#delta", why: "changed: crates/alpha/src/lib.rs" },
    { suite: "rust", file: "command:test#epsilon", why: "changed: crates/alpha/src/lib.rs" },
    { suite: "rust", file: "command:test#gamma", why: "changed: crates/alpha/src/lib.rs" },
  ]);
  // Docs and workflows claim nothing (this fixture has no root member for R5's
  // catch-all): without them the run would rebuild the world on every README.
  for (const path of ["README.md", ".github/workflows/ci.yml"]) {
    const none = cargoEntries(repo, [path]);
    assert.deepEqual(none.result.entries, [], path);
    assert.equal(none.result.degraded.length, 0, path);
  }
  // The toolchain file runs the run whole; so does the workspace-root .cargo
  // config, through the mirror's workspace-root-relative match.
  const toolchain = cargoEntries(repo, ["rust-toolchain.toml"]);
  assert.deepEqual(toolchain.result.entries, [
    { suite: "rust", file: "command:test", why: "changed: rust-toolchain.toml" },
  ]);
  const sub = cargoEntries(repo, ["sub/.cargo/config.toml"], { stub: { workspaceRootRel: "sub" } });
  assert.deepEqual(sub.result.entries, [
    { suite: "rust", file: "command:test", why: "changed: sub/.cargo/config.toml" },
  ]);
});

test("a crate-mapped path is attributed: no unowned entry and no repoSuite whole run", (t) => {
  const repo = makeRepo(t);
  write(repo, "scripts/keep.test.mjs", "export const keep = 1;\n");
  const bare = cargoEntries(repo, ["crates/alpha/src/lib.rs"]);
  assert.deepEqual(bare.result.unowned, [], "a crate-mapped path was also reported unowned");

  const suites = [cargoSuite(), { name: "repo", runs: [{ cwd: ".", globs: ["scripts/*.test.mjs"], timeoutMs: 600000 }] }];
  const withRepo = cargoEntries(repo, ["crates/alpha/src/lib.rs"], { suites });
  assert.ok(withRepo.result.entries.every((entry) => entry.suite === "rust"), JSON.stringify(withRepo.result.entries));
  assert.ok(!withRepo.result.entries.some((entry) => entry.why.startsWith("fallback:")), JSON.stringify(withRepo.result.entries));
});

test("the derived matcher never claims, so a sibling globs run keeps its package fallback", (t) => {
  const repo = makeRepo(t);
  write(repo, "pkgs/api/tests/a.test.mjs", "export const a = 1;\n");
  write(repo, "pkgs/api/tests/thing.win.test.mjs", "export const w = 1;\n");
  write(repo, "pkgs/api/src/dep.mjs", "export const dep = 1;\n");
  const suites = [{
    name: "rust",
    runs: [
      { label: "test", cwd: ".", command: ["cargo", "test"], cargo: true, timeoutMs: 600000 },
      { cwd: ".", globs: ["pkgs/api/tests/*.test.mjs"], timeoutMs: 600000 },
    ],
  }];
  const { result } = cargoEntries(repo, ["pkgs/api/src/dep.mjs"], {
    suites,
    select: { config: configOf(suites, { packages: ["pkgs/*"] }) },
  });
  // The change is unreached and non-Markdown, so the package fallback fires.
  // A matcher that claimed would suppress it -- the missed-test failure mode
  // this row guards.
  assert.deepEqual(result.entries, [
    { suite: "rust", file: "pkgs/api/tests/a.test.mjs", why: "fallback: pkgs/api/src/dep.mjs" },
    { suite: "rust", file: "pkgs/api/tests/thing.win.test.mjs", why: "fallback: pkgs/api/src/dep.mjs" },
    { suite: "rust", file: "command:test", why: "fallback: pkgs/api/src/dep.mjs" },
  ]);
  // The cargo run contributed no crate keys of its own here: `pkgs/` is off
  // every derived crate glob, so nothing of the run was claimed by the graph.
  assert.ok(!result.entries.some((entry) => entry.file.includes("#")), JSON.stringify(result.entries));
  assert.equal(result.degraded.length, 0, JSON.stringify(result.degraded));
});
