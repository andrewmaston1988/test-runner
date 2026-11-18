// Tests for `--fast`'s skip rule (`src/fast.mjs`): each row breaks
// one leg -- edited bytes, stale measurement, never slow -- and expects the file
// back in the run. Hashes are computed here, never by the module under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  loadTimings,
  mergeTimings,
  readTimings,
  recordCommandTimings,
  recordTimings,
  slowCommandTests,
  slowFiles,
  timingKey,
} from "../src/fast.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "fast-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function write(repoRoot, rel, text) {
  const path = join(repoRoot, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function shaOf(repoRoot, rel) {
  return createHash("sha256").update(readFileSync(join(repoRoot, rel))).digest("hex");
}

function entry(repoRoot, rel, { ms = 45_000, at = NOW - DAY } = {}) {
  return { ms, sha256: shaOf(repoRoot, rel), at };
}

const skip = (timings, repoRoot) => slowFiles(timings, { repoRoot, _now: () => NOW });

test("a measured-slow file whose bytes are unchanged is skipped and named", (t) => {
  const repo = makeRepo(t);
  const file = "plugins/swarm/tests/slow.test.mjs";
  write(repo, file, "slow\n");

  assert.deepEqual(skip({ [file]: entry(repo, file) }, repo), [{ file, ms: 45_000 }]);
});

test("an edited file runs again, and re-measuring it restores the skip", (t) => {
  const repo = makeRepo(t);
  const file = "plugins/swarm/tests/slow.test.mjs";
  write(repo, file, "slow\n");
  const timings = { [file]: entry(repo, file) };

  write(repo, file, "edited\n");
  assert.deepEqual(skip(timings, repo), [], "a changed file has not been measured as it is now");

  const remeasured = { [file]: entry(repo, file) };
  assert.deepEqual(skip(remeasured, repo).map((e) => e.file), [file]);
});

test("a measurement at or over seven days old runs the file again", (t) => {
  const repo = makeRepo(t);
  const file = "plugins/swarm/tests/slow.test.mjs";
  write(repo, file, "slow\n");

  const fresh = { [file]: entry(repo, file, { at: NOW - (7 * 24 * 60 * 60 * 1000) + 1 }) };
  const boundary = { [file]: entry(repo, file, { at: NOW - 7 * 24 * 60 * 60 * 1000 }) };
  const stale = { [file]: entry(repo, file, { at: NOW - 8 * DAY }) };

  assert.equal(skip(fresh, repo).length, 1);
  assert.deepEqual(skip(boundary, repo), []);
  assert.deepEqual(skip(stale, repo), []);
});

test("the slow bar is strict: 30.0 s runs, 30.001 s skips", (t) => {
  const repo = makeRepo(t);
  const file = "plugins/swarm/tests/slow.test.mjs";
  write(repo, file, "slow\n");

  const atBar = { [file]: entry(repo, file, { ms: 30_000 }) };
  const overBar = { [file]: entry(repo, file, { ms: 30_001 }) };

  assert.deepEqual(skip(atBar, repo), []);
  assert.deepEqual(skip(overBar, repo), [{ file, ms: 30_001 }]);
});

test("two suites' files with the same basename keep separate timings", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  const swarm = "plugins/swarm/tests/landed.test.mjs";
  const pipeline = "plugins/pipeline/tests/landed.test.mjs";
  write(repo, swarm, "swarm\n");
  write(repo, pipeline, "pipeline\n");

  recordTimings({
    resultsDir,
    repoRoot: repo,
    entries: [
      { file: swarm, ms: 45_000 },
      { file: pipeline, ms: 45_000 },
    ],
    _now: () => NOW,
  });
  const timings = readTimings(resultsDir);
  assert.deepEqual(Object.keys(timings).sort(), [pipeline, swarm]);

  write(repo, pipeline, "pipeline edited\n");
  assert.deepEqual(skip(timings, repo).map((e) => e.file), [swarm]);
});

test("with no timings recorded nothing is skipped and nothing throws", (t) => {
  const repo = makeRepo(t);
  const timings = readTimings(join(repo, "test-results"));

  assert.deepEqual(timings, {});
  assert.deepEqual(skip(timings, repo), []);
});

test("a corrupt or malformed timings file reads as empty", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  mkdirSync(resultsDir, { recursive: true });
  const path = join(resultsDir, "timings.json");

  writeFileSync(path, "{not json", "utf8");
  assert.deepEqual(readTimings(resultsDir), {});

  writeFileSync(path, "[]", "utf8");
  assert.deepEqual(readTimings(resultsDir), {});

  writeFileSync(
    path,
    JSON.stringify({
      "plugins/x/tests/not-a-number.test.mjs": { ms: "slow", sha256: "h", at: NOW },
      "plugins/x/tests/nonsense.test.mjs": "nonsense",
      "plugins/x/tests/good.test.mjs": { ms: 45_000, sha256: "h", at: NOW },
    }),
    "utf8",
  );
  assert.deepEqual(Object.keys(readTimings(resultsDir)), ["plugins/x/tests/good.test.mjs"]);
});

test("mergeTimings replaces the same key and keeps the rest, without mutating", () => {
  const base = { "plugins/a/tests/x.test.mjs": { ms: 1_000, sha256: "a", at: 1 } };
  const merged = mergeTimings(base, {
    "plugins/b/tests/y.test.mjs": { ms: 2_000, sha256: "b", at: 2 },
    "plugins\\a\\tests\\x.test.mjs": { ms: 3_000, sha256: "c", at: 3 },
  });

  assert.deepEqual(merged, {
    "plugins/a/tests/x.test.mjs": { ms: 3_000, sha256: "c", at: 3 },
    "plugins/b/tests/y.test.mjs": { ms: 2_000, sha256: "b", at: 2 },
  });
  assert.deepEqual(base, { "plugins/a/tests/x.test.mjs": { ms: 1_000, sha256: "a", at: 1 } });
  assert.equal(timingKey("plugins\\a\\tests\\x.test.mjs"), "plugins/a/tests/x.test.mjs");
});

test("recordTimings hashes the file now, stamps the clock, merges, and leaves no temp file", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  const a = "plugins/x/tests/a.test.mjs";
  const b = "plugins/x/tests/b.test.mjs";
  write(repo, a, "a\n");
  write(repo, b, "b\n");

  const first = recordTimings({ resultsDir, repoRoot: repo, entries: [{ file: a, ms: 45_000 }], _now: () => NOW });
  assert.equal(first.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(resultsDir, "timings.json"), "utf8")), {
    [a]: { ms: 45_000, sha256: shaOf(repo, a), at: NOW },
  });

  const second = recordTimings({ resultsDir, repoRoot: repo, entries: [{ file: b, ms: 31_000 }], _now: () => NOW + 1_000 });
  assert.equal(second.ok, true);
  assert.deepEqual(Object.keys(readTimings(resultsDir)).sort(), [a, b].sort(), "the second run must not drop the first");
  assert.deepEqual(readdirSync(resultsDir).sort(), ["timings.json"]);
});

test("an unwritable cache reports failure instead of throwing", (t) => {
  const repo = makeRepo(t);
  const blocker = join(repo, "not-a-dir");
  writeFileSync(blocker, "x", "utf8");

  const result = recordTimings({
    resultsDir: blocker,
    repoRoot: repo,
    entries: [{ file: "plugins/x/tests/a.test.mjs", ms: 45_000 }],
    _now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

// --- command entries (R11/R12): the raw reader, the writers, the playback ----

function writeTimings(resultsDir, object) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, "timings.json"), `${JSON.stringify(object, null, 2)}\n`, "utf8");
}

const COMMAND_ENTRY = {
  at: NOW - 3_600_000,
  sha: "tree-sha",
  dirty: false,
  tests: { "quick::one": { ms: 120 }, "slow::one": { ms: 31_000, nodeid: "tests/test_x.py::slow_one" } },
};

test("loadTimings returns the raw object, so command entries survive every read", (t) => {
  const resultsDir = join(makeRepo(t), "test-results");
  writeTimings(resultsDir, {
    "command:0": COMMAND_ENTRY,
    "plugins/x/tests/good.test.mjs": { ms: 45_000, sha256: "h", at: NOW },
  });

  assert.deepEqual(loadTimings(resultsDir), {
    "command:0": COMMAND_ENTRY,
    "plugins/x/tests/good.test.mjs": { ms: 45_000, sha256: "h", at: NOW },
  });
  // The file reader still drops what it cannot measure, command keys included.
  assert.deepEqual(Object.keys(readTimings(resultsDir)), ["plugins/x/tests/good.test.mjs"]);
});

test("recordTimings preserves a command entry, and neither writer drops the other shape", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  writeTimings(resultsDir, {
    "command:0": COMMAND_ENTRY,
    "plugins/x/tests/good.test.mjs": { ms: 45_000, sha256: "h", at: NOW },
  });

  const fileWrite = recordTimings({
    resultsDir, repoRoot: repo, entries: [{ file: "plugins/x/tests/good.test.mjs", ms: 31_000 }], _now: () => NOW,
  });
  assert.equal(fileWrite.ok, true);
  assert.deepEqual(loadTimings(resultsDir)["command:0"], COMMAND_ENTRY, "a file write clobbered the command entry");

  const commandWrite = recordCommandTimings({
    resultsDir, key: "command:0",
    events: [{ name: "quick::one", outcome: "pass", ms: 130 }],
    repoRoot: repo, _now: () => NOW,
    _spawnSync: () => ({ status: 0, stdout: "tree-sha\n" }),
  });
  assert.equal(commandWrite.ok, true);
  const raw = loadTimings(resultsDir);
  assert.deepEqual(raw["plugins/x/tests/good.test.mjs"], { ms: 45_000, sha256: "h", at: NOW }, "a command write clobbered the file entry");
});

test("the merge updates fresh names, adds new ones, keeps absent ones stamped", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  writeTimings(resultsDir, {
    "command:0": {
      at: NOW - 60_000,
      sha: "old-sha",
      dirty: true,
      tests: {
        "deselected::one": { ms: 31_000, nodeid: "tests/test_x.py::deselected" },
        "quick::one": { ms: 120 },
      },
    },
  });

  recordCommandTimings({
    resultsDir, key: "command:0",
    events: [{ name: "quick::one", outcome: "pass", ms: 130 }, { name: "new::one", outcome: "pass", ms: 42 }],
    repoRoot: repo, _now: () => NOW + 5_000,
    _spawnSync: (cmd, args) => ({
      status: 0,
      stdout: args[0] === "rev-parse" ? "new-sha\n" : "",
    }),
  });

  assert.deepEqual(loadTimings(resultsDir)["command:0"], {
    at: NOW + 5_000,
    sha: "new-sha",
    dirty: false,
    tests: {
      "deselected::one": { ms: 31_000, nodeid: "tests/test_x.py::deselected" },
      "quick::one": { ms: 130 },
      "new::one": { ms: 42 },
    },
  });
});

test("a bare-number test entry survives a rewrite and an un-timed event records nothing", (t) => {
  const repo = makeRepo(t);
  const resultsDir = join(repo, "test-results");
  writeTimings(resultsDir, { "command:0": { ...COMMAND_ENTRY, tests: { "bare::num": 31_000 } } });

  recordCommandTimings({
    resultsDir, key: "command:0",
    events: [{ name: "un::timed", outcome: "pass", ms: null }, { name: "quick::one", outcome: "fail", ms: 70 }],
    repoRoot: repo, _now: () => NOW,
    _spawnSync: () => ({ status: 0, stdout: "tree-sha\n" }),
  });

  assert.deepEqual(loadTimings(resultsDir)["command:0"].tests, {
    "bare::num": 31_000,
    "quick::one": { ms: 70 },
  });
});

test("a tree without git records nothing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fast-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const resultsDir = join(dir, "test-results");

  const result = recordCommandTimings({
    resultsDir, key: "command:0",
    events: [{ name: "a", outcome: "pass", ms: 120 }],
    repoRoot: dir, _now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(loadTimings(resultsDir), {}, "a stamp-less tree still wrote a record");
});

test("playback keeps exactly the stamped, long-running, nodeid-carrying tests", (t) => {
  const entry = {
    at: NOW - 3_600_000,
    sha: "tree-sha",
    dirty: false,
    tests: {
      "slow::one": { ms: 31_000, nodeid: "tests/test_x.py::slow_one" },
      "edge::zero": { ms: 30_000 },
      "quick::two": { ms: 500 },
      "stale::old": { ms: 31_000, nodeid: "tests/test_x.py::stale_old", sha: "a-different-tree" },
      "bare::num": 31_000,
      "aged::out": { ms: 31_000, nodeid: "tests/test_x.py::aged_out", at: NOW - 8 * DAY },
    },
  };

  assert.deepEqual(slowCommandTests(entry, { _now: () => NOW, sha: "tree-sha", dirty: false }), [
    { name: "slow::one", ms: 31_000, nodeid: "tests/test_x.py::slow_one" },
  ]);
});

test("an entry whose own stamp misses the tree deselects nothing", (t) => {
  const tests = { "slow::one": { ms: 31_000, nodeid: "tests/test_x.py::slow_one" } };
  for (const entry of [
    { at: NOW - 3_600_000, sha: "other", dirty: false, tests },
    { at: NOW - 3_600_000, sha: "tree-sha", dirty: true, tests },
    { at: NOW - 8 * DAY, sha: "tree-sha", dirty: false, tests },
  ]) {
    assert.deepEqual(slowCommandTests(entry, { _now: () => NOW, sha: "tree-sha", dirty: false }), [], JSON.stringify(entry));
  }
});

test("a missing, corrupt or shapeless entry selects nothing", (t) => {
  for (const entry of [null, undefined, 31000, "nope", [], { tests: "nope" }, { tests: null }]) {
    assert.deepEqual(slowCommandTests(entry, { _now: () => NOW, sha: "s", dirty: false }), [], JSON.stringify(entry ?? "null"));
  }
});
