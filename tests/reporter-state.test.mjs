// The reporter's filesystem side effects: the in-flight record, the timings
// cache and its batching, and what survives a run killed at its cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { TIMINGS_FLUSH_MS, createReporter } from "../src/reporter.mjs";
import {
  complete,
  dequeue,
  drain,
  envFor,
  events,
  fakeClock,
  makeRoot,
  neverSleep,
  stderr,
  summary,
  until,
} from "./reporter-harness.mjs";

// --- Integration surface for the runner ------------------------------------

test("a file that crashes at load still prints, with its stderr as the failure evidence", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "crash.test.mjs");
  const reporter = createReporter({ env: envFor(root, { TEST_REPORTER: "agent" }), sleep: neverSleep });
  const source = events([
    dequeue(file),
    stderr(file, "Error: load crash\n"),
    stderr(file, "    at file:///x/crash.test.mjs:1:7\n"),
    complete(file, { passed: false, ms: 400 }),
    summary({ tests: 0, passed: 0, failed: 1, skipped: 0, todo: 0 }, 400),
  ]);
  const out = await drain(reporter, source);
  assert.match(out, /^✗ tests\/crash\.test\.mjs \(0 tests\) {2}0\.4s$/m);
  assert.match(out, /^FAIL tests\/crash\.test\.mjs$/m);
  assert.match(out, /Error: load crash/);
});

test("a file row named by a cwd-relative path is recognised as the file", async (t) => {
  const repoRoot = process.cwd();
  const file = "scripts/relative-name.test.mjs";
  const out = await drain(
    createReporter({
      env: { TEST_RUN_LABEL: "unit", TEST_REPO_ROOT: repoRoot, TEST_RESULTS_DIR: makeRoot(t) },
      sleep: neverSleep,
    }),
    events([dequeue(file), complete(file, { ms: 900 })]),
  );
  assert.match(out, /^✓ scripts\/relative-name\.test\.mjs \(0 tests\) {2}0\.9s$/m);
});

test("the in-flight record is written per pid on file start and cleared at the end", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "a.test.mjs");
  const flight = join(root, "test-results", `unit.${process.pid}.inflight.json`);
  const seen = [];

  const source = (async function* () {
    yield dequeue(file);
    seen.push(readFileSync(flight, "utf8"));
    yield complete(file, { ms: 500 });
  })();

  const out = await drain(createReporter({ env: envFor(root), sleep: neverSleep, now: () => 1000 }), source);
  assert.match(out, /✓ tests\/a\.test\.mjs/);
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0]), {
    pid: process.pid,
    label: "unit",
    files: [{ file: "tests/a.test.mjs", startedAt: 1000 }],
  });
  assert.ok(existsSync(flight));
  assert.deepEqual(JSON.parse(readFileSync(flight, "utf8")).files, []);
});

test("timings are keyed by the repo-relative path with the file's content hash", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "landed.test.mjs");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "// fixture\n", "utf8");
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");

  await drain(
    createReporter({ env: envFor(root), sleep: neverSleep, now: () => 42 }),
    events([dequeue(file), complete(file, { ms: 45000 })]),
  );
  const timings = JSON.parse(readFileSync(join(root, "test-results", "timings.json"), "utf8"));
  assert.deepEqual(timings["tests/landed.test.mjs"], { ms: 45000, sha256, at: 42 });
});

test("two finished files cost one batched write, not one per file", async (t) => {
  const root = makeRoot(t);
  const a = join(root, "tests", "a.test.mjs");
  const b = join(root, "tests", "b.test.mjs");
  mkdirSync(dirname(a), { recursive: true });
  writeFileSync(a, "// a\n", "utf8");
  writeFileSync(b, "// b\n", "utf8");
  let writes = 0;
  const fs = {
    ...nodeFs,
    renameSync: (from, to) => {
      if (String(to).endsWith("timings.json")) writes += 1;
      return nodeFs.renameSync(from, to);
    },
  };

  await drain(
    createReporter({ env: envFor(root), sleep: neverSleep, now: () => 7, fs }),
    events([dequeue(a), complete(a, { ms: 1200 }), dequeue(b), complete(b, { ms: 3400 })]),
  );

  const timings = JSON.parse(readFileSync(join(root, "test-results", "timings.json"), "utf8"));
  assert.deepEqual(Object.keys(timings).sort(), ["tests/a.test.mjs", "tests/b.test.mjs"]);
  assert.equal(writes, 1, "each finished file rewrote the whole timing cache");
});

// --- B1: a run killed at its cap -------------------------------------------

test("a run killed before its end has already persisted the timings of every file that finished", async (t) => {
  const root = makeRoot(t);
  const [done, slow] = ["done", "slow"].map((name) => join(root, "tests", `${name}.test.mjs`));
  mkdirSync(dirname(done), { recursive: true });
  writeFileSync(done, "// done\n", "utf8");

  const clock = fakeClock();
  let calls = 0;
  const rows = [dequeue(done), complete(done, { ms: 200 }), dequeue(slow)];
  const source = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      calls += 1;
      return calls <= rows.length ? Promise.resolve({ value: rows[calls - 1], done: false }) : new Promise(() => {});
    },
  };
  const iterator = createReporter({ env: envFor(root), now: clock.now, sleep: clock.sleep })(source);
  assert.match((await iterator.next()).value, /^✓ tests\/done\.test\.mjs/);
  const beat = iterator.next();
  await until(() => calls >= 4, "the still-running file");
  clock.advance(TIMINGS_FLUSH_MS + 5000);
  clock.fire();
  assert.match((await beat).value, /still running/);

  // Read while the run is open: a SIGKILL never reaches the end block.
  const written = JSON.parse(readFileSync(join(root, "test-results", "timings.json"), "utf8"));
  assert.deepEqual(Object.keys(written), ["tests/done.test.mjs"]);
  assert.equal(written["tests/done.test.mjs"].ms, 200);

  await iterator.return(); // the kill
});
