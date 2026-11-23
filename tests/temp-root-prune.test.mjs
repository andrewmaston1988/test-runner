// Kept temp roots are pruned before the next root is made: the newest few per
// label survive, old ones go, and a root still being written to is never
// touched. All of it is best effort -- a prune that fails is a log line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, dirname, join, sep } from "node:path";

import { pruneKeptRoots, withTempRoot } from "../src/temp-root.mjs";

const PARENT = join("tmp", "test-runner");
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 0, 10);

/** An in-memory `_fs`: `nodes` maps a path to `{ dir, mtimeMs, size }`, a
 *  `link` node also follows to another path the way `statSync` does, and
 *  `rmError` names one path whose removal keeps failing. */
function memFs(nodes, { rmError } = {}) {
  const calls = [];
  const node = (path) => {
    if (!nodes[path]) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return nodes[path];
  };
  const children = (path) => Object.keys(nodes).filter((p) => p !== path && dirname(p) === path);
  return {
    calls,
    nodes,
    mkdirSync(path) { nodes[path] = { dir: true, mtimeMs: 0, size: 0 }; },
    mkdtempSync(prefix) {
      calls.push(["mkdtemp", prefix]);
      nodes[`${prefix}AbC123`] = { dir: true, mtimeMs: NOW, size: 0 };
      return `${prefix}AbC123`;
    },
    readdirSync(path, options) {
      calls.push(["read", path]);
      const found = node(path);
      if (found.link) return [];
      const names = children(path);
      return options?.withFileTypes
        ? names.map((p) => ({ name: basename(p), isDirectory: () => nodes[p].dir }))
        : names;
    },
    statSync(path) {
      const found = node(path);
      if (found.link) return this.statSync(found.link);
      return { mtimeMs: found.mtimeMs, size: found.size, isDirectory: () => found.dir };
    },
    lstatSync(path) {
      const found = node(path);
      return { mtimeMs: found.mtimeMs, size: found.link ? 0 : found.size, isDirectory: () => found.dir && !found.link };
    },
    rmSync(path) {
      calls.push(["rm", path]);
      if (path === rmError) throw Object.assign(new Error("EBUSY: busy"), { code: "EBUSY" });
      for (const p of Object.keys(nodes)) if (p === path || p.startsWith(path + sep)) delete nodes[p];
    },
  };
}

/** The parent and one root per `name`, whose value is its age in hours or
 *  `{ age, entry, size }` (one direct file `entry` hours old, `size` bytes). */
function tree(roots) {
  const nodes = { [PARENT]: { dir: true, mtimeMs: NOW, size: 0 } };
  const paths = {};
  for (const [name, spec] of Object.entries(roots)) {
    const { age, entry, size = 0 } = typeof spec === "number" ? { age: spec } : spec;
    const path = join(PARENT, name);
    nodes[path] = { dir: true, mtimeMs: NOW - age * HOUR, size: 0 };
    if (entry !== undefined) nodes[join(path, "out.log")] = { dir: false, mtimeMs: NOW - entry * HOUR, size };
    paths[name] = path;
  }
  return { nodes, paths };
}

/** Prune `roots` at NOW and return what went. */
function pruned(roots, options) {
  const { nodes, paths } = tree(roots);
  const _fs = memFs(nodes, options);
  const lines = [];
  pruneKeptRoots({ parent: PARENT, now: NOW, _fs, _log: (line) => lines.push(line) });
  return { _fs, lines, gone: (name) => _fs.nodes[paths[name]] === undefined };
}

test("the prune keeps the newest three roots with one label", () => {
  const { gone } = pruned({
    "swarm-000000": 25, "swarm-000001": 30, "swarm-000002": 35,
    "swarm-000003": 40, "swarm-000004": 45,
  });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => gone(`swarm-00000${i}`)), [false, false, false, true, true]);
});

test("a root older than three days goes even as its group's only root", () => {
  const { gone } = pruned({ "py-AbC123": 96 });
  assert.equal(gone("py-AbC123"), true);
});

test("a root touched within a day survives and takes no keep slot", () => {
  const { gone } = pruned({
    "swarm-000000": 1, "swarm-000001": 30, "swarm-000002": 35, "swarm-000003": 40, "swarm-000004": 45,
  });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => gone(`swarm-00000${i}`)),
    [false, false, false, false, true]);
});

test("a recent direct entry keeps an old root alive", () => {
  const { gone } = pruned({
    "swarm-AbC123": { age: 120, entry: 1 },
    "py-AbC123": { age: 120 },
  });
  assert.equal(gone("swarm-AbC123"), false, "a root written to an hour ago was pruned");
  assert.equal(gone("py-AbC123"), true, "an untouched root of the same age survived");
});

test("a prune that fails is logged and the run still gets its root", async () => {
  const base = memFs({ [PARENT]: { dir: true, mtimeMs: 0, size: 0 } });
  const _fs = {
    ...base,
    readdirSync(path, options) {
      if (path === PARENT) throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
      return base.readdirSync(path, options);
    },
  };
  const lines = [];
  let seen;
  const result = await withTempRoot(
    { label: "probe", _fs, _tmpdir: () => "tmp", _now: () => NOW, _log: (line) => lines.push(line) },
    (tempEnv) => { seen = tempEnv; return { ok: true }; },
  );
  assert.deepEqual(result, { ok: true }, "the prune changed the run's result");
  assert.equal(dirname(seen.TEMP), PARENT, "the run got no temp root");
  assert.deepEqual(lines, ["[test] probe: could not prune kept temp roots (EACCES)"]);
});

test("a hand-made look-alike under the parent is pruned too", () => {
  const { gone } = pruned({ "my-folder": 96 });
  assert.equal(gone("my-folder"), true);
});

test("each label's keep count is its own", () => {
  const { gone } = pruned({
    "swarm-000000": 25, "swarm-000001": 30, "swarm-000002": 35, "swarm-000003": 40,
    "pipeline_core_-000000": 25, "pipeline_core_-000001": 30,
    "pipeline_core_-000002": 35, "pipeline_core_-000003": 40,
  });
  assert.deepEqual(
    ["swarm-000000", "swarm-000001", "swarm-000002", "swarm-000003",
      "pipeline_core_-000000", "pipeline_core_-000001", "pipeline_core_-000002", "pipeline_core_-000003"].map(gone),
    [false, false, false, true, false, false, false, true]);
});

test("files, names without a six-character suffix and other parents are untouched", () => {
  const { nodes, paths } = tree({ "keep-me": 200, "swarm-AbC123": 96 });
  nodes[join(PARENT, "notes.txt")] = { dir: false, mtimeMs: NOW - 200 * HOUR, size: 3 };
  const outside = join("elsewhere", "test-runner", "swarm-XyZ789");
  nodes[outside] = { dir: true, mtimeMs: NOW - 200 * HOUR, size: 0 };
  const _fs = memFs(nodes);
  pruneKeptRoots({ parent: PARENT, now: NOW, _fs });
  assert.equal(_fs.nodes[paths["swarm-AbC123"]], undefined, "a candidate root was not pruned");
  assert.ok(_fs.nodes[paths["keep-me"]], "a name without a six-character suffix was pruned");
  assert.ok(_fs.nodes[join(PARENT, "notes.txt")], "a file was pruned");
  assert.ok(_fs.nodes[outside], "a root outside the parent was pruned");
});

test("a root that cannot be removed is logged and the rest still go", async () => {
  const { nodes } = tree({
    "swarm-000000": 25, "swarm-000001": 30, "swarm-000002": 35,
    "swarm-000003": 40, "swarm-000004": 45,
  });
  const busy = join(PARENT, "swarm-000003");
  const _fs = memFs(nodes, { rmError: busy });
  const lines = [];
  const result = await withTempRoot(
    { label: "probe", _fs, _tmpdir: () => "tmp", _now: () => NOW, _log: (line) => lines.push(line) },
    () => ({ ok: true }),
  );
  assert.deepEqual(result, { ok: true }, "the run did not finish");
  assert.ok(_fs.nodes[busy], "the busy root was removed");
  assert.equal(_fs.nodes[join(PARENT, "swarm-000004")], undefined, "a later removal was skipped");
  assert.deepEqual(lines, [
    `[test] could not prune temp root ${busy} (EBUSY)`,
    "[test] pruned 1 kept temp roots (0 MB)",
  ]);
});

test("the prune runs before the new root is made", async () => {
  const { nodes } = tree({});
  const _fs = memFs(nodes);
  await withTempRoot(
    { label: "probe", _fs, _tmpdir: () => "tmp", _now: () => NOW },
    () => ({ ok: true }),
  );
  const read = _fs.calls.findIndex(([kind, path]) => kind === "read" && path === PARENT);
  const mint = _fs.calls.findIndex(([kind]) => kind === "mkdtemp");
  assert.ok(read >= 0 && mint > read, `not pruned before the root was made: ${JSON.stringify(_fs.calls)}`);
  assert.equal(_fs.calls.some(([kind], index) => kind === "rm" && index < mint), false,
    "a root was pruned before the new root existed");
});

test("removals print one prune line and nothing prints none", () => {
  const { lines } = pruned({
    "swarm-000000": 25, "swarm-000001": 30, "swarm-000002": 35,
    "swarm-000003": { age: 40, entry: 40, size: 2 * 1024 * 1024 },
  });
  assert.deepEqual(lines, ["[test] pruned 1 kept temp roots (2 MB)"]);
  assert.deepEqual(pruned({ "swarm-000000": 25 }).lines, []);
});

test("a link inside a kept root is counted as a link, never followed", () => {
  const { nodes, paths } = tree({ "swarm-AbC123": 96 });
  const link = join(paths["swarm-AbC123"], "loop");
  nodes[link] = { dir: false, link: paths["swarm-AbC123"], mtimeMs: NOW, size: 0 };
  const _fs = memFs(nodes);
  const lines = [];
  pruneKeptRoots({ parent: PARENT, now: NOW, _fs, _log: (line) => lines.push(line) });
  assert.equal(_fs.calls.some(([kind, path]) => kind === "read" && path === link), false,
    "the size walk descended into a link");
  assert.equal(_fs.nodes[paths["swarm-AbC123"]], undefined, "the aged root was not pruned");
  assert.deepEqual(lines, ["[test] pruned 1 kept temp roots (0 MB)"]);
});
