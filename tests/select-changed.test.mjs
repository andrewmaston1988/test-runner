// The changed set and the base it is measured from: what a diff contains, and
// which ref it is diffed against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { changedSet, resolveBase } from "../src/changed.mjs";
import { BIN, MARKETPLACE, commitAll, git, makeRepo, write } from "./helpers.mjs";

const BASE = MARKETPLACE.base;

// --- the changed set and its base ------------------------------------------

test("committed, unstaged and untracked changes all enter the changed set", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  write(repo, ".gitignore", "ignored.txt\n");
  commitAll(repo, "seed");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "committed.mjs");
  commitAll(repo, "committed change");
  write(repo, "unstaged.mjs");
  write(repo, "untracked.mjs");
  write(repo, "ignored.txt");
  const changed = changedSet({ repoRoot: repo, base: resolveBase({ repoRoot: repo, candidates: BASE }) });
  for (const path of ["committed.mjs", "unstaged.mjs", "untracked.mjs"]) {
    assert.ok(changed.includes(path), `${path} missing from ${changed.join(",")}`);
  }
  assert.ok(!changed.includes("ignored.txt"), "an ignored file is not a change");
});

test("master is the base when there is no origin, and the merge-base is used", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "work.mjs");
  commitAll(repo, "feature work");
  // master moves on: its own commit must not read as this branch's change.
  git(repo, "checkout", "-q", "master");
  write(repo, "elsewhere.mjs");
  commitAll(repo, "master moves");
  git(repo, "checkout", "-q", "feature");
  const changed = changedSet({ repoRoot: repo, base: resolveBase({ repoRoot: repo, candidates: BASE }) });
  assert.ok(changed.includes("work.mjs"), changed.join(","));
  assert.ok(!changed.includes("elsewhere.mjs"), "master's own commit is not this branch's diff");
});

test("no base candidate and no --against exits 2 naming --against", (t) => {
  const repo = makeRepo(t, "trunk");
  write(repo, "seed.mjs");
  write(repo, "test-runner.config.mjs", "export default { suites: [] };\n");
  commitAll(repo, "seed");

  const r = spawnSync(process.execPath, [BIN, "--list"], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--against/);
});

test("--against overrides the branch base and an unknown ref fails closed", (t) => {
  const repo = makeRepo(t);
  write(repo, "seed.mjs");
  commitAll(repo, "seed");
  const base = git(repo, "rev-parse", "HEAD").trim();

  assert.equal(resolveBase({ repoRoot: repo, against: base, candidates: BASE }), base);
  assert.throws(() => resolveBase({ repoRoot: repo, against: "no-such-ref", candidates: BASE }), /not a ref/);
});
