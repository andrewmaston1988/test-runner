// The cargo workspace graph (src/crates.mjs): what one `cargo metadata` read
// produces, how a changed path resolves to crates, the claim globs derived
// from the graph, and the argv shape the -p list builds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";

import { cratesForPath, deriveCargoGlobs, readCargoGraph, withCrateArgs } from "../src/crates.mjs";
import { makeRepo, metadataFixture, write } from "./helpers.mjs";

/** A spawnSync stub that answers only `cargo metadata`. Anything else is a
 *  test bug the row wants to see, not a silently wrong graph. */
function metadataSpawn(metadata, { status = 0, stdout = null } = {}) {
  const calls = [];
  const spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd !== "cargo") throw new Error(`unexpected command: ${cmd}`);
    if (stdout !== null) return { status, stdout, stderr: "" };
    if (status !== 0) return { status, stdout: "", stderr: "boom\n" };
    return { status: 0, stdout: JSON.stringify(metadata), stderr: "" };
  };
  return { calls, spawnSync };
}

const readGraph = (repo, options = {}) => {
  const stub = metadataSpawn(metadataFixture(repo, options));
  return { result: readCargoGraph({ cwdAbs: repo, repoRoot: repo, _spawnSync: stub.spawnSync }), stub };
};

test("one cargo metadata spawn yields the members and the transitive closure over every edge kind", (t) => {
  const repo = makeRepo(t);
  const { result, stub } = readGraph(repo);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  const graph = result.graph;
  assert.deepEqual(graph.members.map((m) => m.name).sort(), ["alpha", "beta", "delta", "epsilon", "gamma"]);
  assert.deepEqual(
    graph.members.map((m) => m.dir).sort(),
    ["crates/alpha", "crates/beta", "crates/delta", "crates/epsilon", "crates/gamma"],
  );
  const [{ cmd, args, opts }] = stub.calls;
  assert.equal(cmd, "cargo");
  assert.deepEqual(args, ["metadata", "--no-deps", "--format-version", "1"]);
  assert.equal(opts.cwd, repo);
  assert.equal(opts.encoding, "utf8");
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.maxBuffer, 64 * 1024 * 1024, "Node's 1 MiB default truncates a real workspace");
  assert.deepEqual(cratesForPath(graph, "crates/alpha/src/lib.rs"), [
    "alpha", "beta", "delta", "epsilon", "gamma",
  ]);
});

test("target-only edges reach the dependent set like normal edges", (t) => {
  const repo = makeRepo(t);
  const { result } = readGraph(repo);
  assert.deepEqual(cratesForPath(result.graph, "crates/beta/src/lib.rs"), ["beta", "epsilon", "gamma"]);
});

test("a non-member path-dep dir is attributed virtually, from a graph literal", () => {
  const graph = {
    wr: "",
    rootMember: null,
    members: [
      { name: "alpha", dir: "crates/alpha" },
      { name: "beta", dir: "crates/beta" },
      { name: "gamma", dir: "crates/gamma" },
    ],
    edges: [
      ["crates/beta", "vendor/delta", null],
      ["crates/gamma", "vendor/delta", "dev"],
    ],
    includes: [],
  };
  assert.deepEqual(cratesForPath(graph, "vendor/delta/x.rs"), ["beta", "gamma"]);
  assert.deepEqual(deriveCargoGlobs(graph), [
    "crates/alpha/**", "crates/beta/**", "crates/gamma/**",
    "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain", ".cargo/config.toml",
    "vendor/delta/**",
  ]);
});

test("non-.rs files map by member directory prefix and never across a segment", (t) => {
  const repo = makeRepo(t);
  const { result } = readGraph(repo);
  const alphaSet = ["alpha", "beta", "delta", "epsilon", "gamma"];
  assert.deepEqual(cratesForPath(result.graph, "crates/alpha/assets/card.png"), alphaSet);
  assert.deepEqual(cratesForPath(result.graph, "crates/alpha/shaders/water.wgsl"), alphaSet);
  assert.deepEqual(cratesForPath(result.graph, "crates/alpha/Cargo.toml"), alphaSet);
  assert.deepEqual(cratesForPath(result.graph, "crates/alphax/src/x.rs"), []);
});

test("the root-package member catch-alls into ** without silently skipping", (t) => {
  const repo = makeRepo(t);
  const { result } = readGraph(repo, { rootPackage: "app" });
  const globs = deriveCargoGlobs(result.graph);
  assert.ok(globs.includes("**"), JSON.stringify(globs));
  assert.ok(!globs.includes("./**"), `the dead glob sneaked in: ${JSON.stringify(globs)}`);
  assert.deepEqual(cratesForPath(result.graph, "src/lib.rs"), ["app"]);
  assert.deepEqual(cratesForPath(result.graph, "crates/alpha/src/lib.rs"), [
    "alpha", "beta", "delta", "epsilon", "gamma",
  ]);
});

test("a sub-rooted workspace prefixes every glob and claims its own whole-files", (t) => {
  const repo = makeRepo(t);
  const { result } = readGraph(repo, { workspaceRootRel: "sub" });
  assert.deepEqual(deriveCargoGlobs(result.graph), [
    "sub/crates/alpha/**", "sub/crates/beta/**", "sub/crates/gamma/**", "sub/crates/delta/**", "sub/crates/epsilon/**",
    "sub/Cargo.toml", "sub/Cargo.lock", "sub/rust-toolchain.toml", "sub/rust-toolchain", "sub/.cargo/config.toml",
  ]);
  assert.equal(cratesForPath(result.graph, "sub/Cargo.lock"), "whole");
});

test("include_str!/include_bytes!/build.rs joins add readers, and gate outside-crate targets", (t) => {
  const repo = makeRepo(t);
  write(repo, "crates/beta/src/lib.rs", 'pub const M: &str = include_str!("../../gamma/f.txt");\n');
  write(
    repo,
    "crates/delta/build.rs",
    'let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../gamma/inc.bin");\n',
  );
  write(repo, "crates/epsilon/src/lib.rs", 'pub const G: &[u8] = include_bytes!("../../../tools/gen.bin");\n');
  const { result } = readGraph(repo);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  const graph = result.graph;
  assert.deepEqual(cratesForPath(graph, "crates/gamma/f.txt"), ["beta", "epsilon", "gamma"]);
  assert.deepEqual(cratesForPath(graph, "crates/gamma/inc.bin"), ["delta", "gamma"]);
  assert.deepEqual(cratesForPath(graph, "tools/gen.bin"), ["epsilon"]);
  assert.ok(deriveCargoGlobs(graph).includes("tools/**"), JSON.stringify(deriveCargoGlobs(graph)));
});

test("the -p list is sorted, deduped, spliced before -- and argv is untouched when no crate applies", () => {
  assert.deepEqual(
    withCrateArgs(["cargo", "test"], ["gamma", "alpha", "beta", "alpha"]),
    ["cargo", "test", "-p", "alpha", "-p", "beta", "-p", "gamma"],
  );
  assert.deepEqual(
    withCrateArgs(["cargo", "test", "--workspace", "--", "--nocapture"], ["b", "a"]),
    ["cargo", "test", "-p", "a", "-p", "b", "--", "--nocapture"],
  );
  assert.deepEqual(withCrateArgs(["cargo", "test", "--workspace"], []), ["cargo", "test", "--workspace"]);
  assert.deepEqual(withCrateArgs(["cargo", "test"], null), ["cargo", "test"]);
});

test("a failed, throwing, silent-failure or unparsable metadata read degrades instead of throwing", (t) => {
  const repo = makeRepo(t);
  const failed = metadataSpawn({}, { status: 1 });
  const stopped = readCargoGraph({ cwdAbs: repo, repoRoot: repo, _spawnSync: failed.spawnSync });
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /exit 1/);

  const throwing = { spawnSync: () => { throw new Error("boom"); } };
  const thrown = readCargoGraph({ cwdAbs: repo, repoRoot: repo, _spawnSync: throwing.spawnSync });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /spawn failed: boom/);

  const noResult = { spawnSync: () => ({ error: new Error("spawn cargo ENOENT") }) };
  const silent = readCargoGraph({ cwdAbs: repo, repoRoot: repo, _spawnSync: noResult.spawnSync });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /spawn failed/);

  const { spawnSync: junk } = metadataSpawn(null, { stdout: "{oops" });
  const unparsed = readCargoGraph({ cwdAbs: repo, repoRoot: repo, _spawnSync: junk });
  assert.equal(unparsed.ok, false);
  assert.match(unparsed.error, /unparsable JSON/);
});

test("a workspace root outside the repository degrades naming it", (t) => {
  const repo = makeRepo(t);
  const { spawnSync } = metadataSpawn({ workspace_root: join(dirname(repo), "elsewhere"), packages: [] });
  const read = readCargoGraph({ cwdAbs: repo, repoRoot: repo, _spawnSync: spawnSync });
  assert.equal(read.ok, false);
  assert.match(read.error, /workspace root outside the repository/);
});
