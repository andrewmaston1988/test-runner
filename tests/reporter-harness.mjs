// The reporter tests' shared harness: fake roots and envs, the event fixtures
// Node's stream emits, and the drains a fake clock settles. It lives beside the
// tests rather than in helpers.mjs because only the reporter tests need any of
// it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Harness ---------------------------------------------------------------

export function makeRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "reporter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

/** A clean env: inheriting process.env would make every run "agent mode"
 *  because this suite itself runs under one. */
export function envFor(root, extra = {}) {
  return {
    TEST_RUN_LABEL: "unit",
    TEST_REPO_ROOT: root,
    TEST_RESULTS_DIR: join(root, "test-results"),
    ...extra,
  };
}

export const neverSleep = () => new Promise(() => {});

/** A file row is named with the path as it was passed on the command line; the
 *  fixtures pass absolute paths, so that is what Node reports. */
export function dequeue(file) {
  return { type: "test:dequeue", data: { file, name: file, nesting: 0, type: "test" } };
}

export function complete(file, { passed = true, ms = 100 } = {}) {
  return {
    type: "test:complete",
    data: { file, name: file, nesting: 0, details: { duration_ms: ms, passed, type: "test" } },
  };
}

/** The file-level test:pass/fail: also emitted, but relayed in FILE order
 *  after the live complete, which is what the streaming test must not use. */
export function fileResult(file, { passed = true, ms = 100 } = {}) {
  return {
    type: passed ? "test:pass" : "test:fail",
    data: { file, name: file, nesting: 0, details: { duration_ms: ms, type: "test" } },
  };
}

export function start(file, name, nesting) {
  return { type: "test:start", data: { file, name, nesting } };
}

export function leaf(kind, file, name, nesting, ms, error) {
  const details = { type: "test", duration_ms: ms };
  if (error) details.error = error;
  return { type: kind, data: { file, name, nesting, details } };
}

export function summary(counts, durationMs) {
  return { type: "test:summary", data: { counts, duration_ms: durationMs } };
}

/** A describe node's own complete: `details.type === "suite"`. */
export function suite(kind, file, name, nesting, ms) {
  return { type: kind, data: { file, name, nesting, details: { type: "suite", duration_ms: ms } } };
}

/** A skipped or todo leaf: Node puts `skip`/`todo` on the event, not details. */
export function skippedLeaf(file, name, nesting, key = "skip") {
  return { type: "test:pass", data: { file, name, nesting, [key]: true, details: { type: "test", duration_ms: 0 } } };
}

export function stderr(file, message) {
  return { type: "test:stderr", data: { file, message } };
}

export function events(list) {
  return (async function* source() {
    for (const event of list) yield event;
  })();
}

export async function drain(reporter, source) {
  const chunks = [];
  for await (const chunk of reporter(source)) chunks.push(chunk);
  return chunks.join("");
}

export async function until(predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function withDeadline(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms)),
  ]);
}

/** Sleeps that only the test settles, so "past 60 s" is a clock advance. */
export function fakeClock() {
  let time = 0;
  const sleepers = [];
  const sleep = (ms, signal) => new Promise((resolve) => {
    const entry = { ms, resolve, aborted: false };
    sleepers.push(entry);
    if (signal) {
      signal.addEventListener("abort", () => {
        entry.aborted = true;
        resolve();
      }, { once: true });
    }
  });
  return {
    now: () => time,
    sleep,
    sleepers,
    advance: (ms) => {
      time += ms;
    },
    fire: () => sleepers.forEach((entry) => entry.resolve()),
  };
}

export function lines(out) {
  return out.split("\n");
}
