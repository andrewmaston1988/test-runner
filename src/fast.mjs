// What `--fast` may skip, from what this machine last measured.
//
// A recorded duration is a licence to skip only while it still describes the
// run that would happen now: the file's bytes are the same, the measurement is
// recent, and it was genuinely slow. Any doubt runs the file and re-measures.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";

export const SLOW_FILE_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_AGE_MS = 7 * DAY_MS;
const TIMINGS_NAME = "timings.json";

/** Timings key. Repo-relative, posix, so two suites never collide over a
 *  shared basename and a worktree keys like its main checkout. */
export function timingKey(file) {
  return String(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function timingsPath(resultsDir) {
  return join(resultsDir, TIMINGS_NAME);
}

function fileHash(repoRoot, file, _readFileSync) {
  try {
    return createHash("sha256").update(_readFileSync(join(repoRoot, file))).digest("hex");
  } catch {
    return null; // a deleted or unreadable file was never measured as it is now
  }
}

/** The raw cache: every entry under both shapes -- file entries keyed by path
 *  and command-run entries keyed `command:<label|index>`. A missing, corrupt
 *  or non-object cache reads as {} and must never fail a run: this is the only
 *  read path the writers use, because the shape filter below would silently
 *  drop the other writer's entries and a rewrite would erase them. */
export function loadTimings(resultsDir, { _readFileSync = nodeFs.readFileSync } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(_readFileSync(timingsPath(resultsDir), "utf8")));
  } catch {
    return {};
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/** The file entries, alone: only what a globs run can skip for. A command run's
 *  entry carries no `ms`, so the same shape check drops it here. */
export function readTimings(resultsDir, { _readFileSync = nodeFs.readFileSync } = {}) {
  const parsed = loadTimings(resultsDir, { _readFileSync });
  const out = {};
  for (const [rawFile, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object") continue;
    const ms = Number(entry.ms);
    const at = Number(entry.at);
    if (!Number.isFinite(ms) || !Number.isFinite(at)) continue;
    out[timingKey(rawFile)] = { ms, sha256: String(entry.sha256 ?? ""), at };
  }
  return out;
}

/** The atomic write both writers share: concurrent runs can lose one sample,
 *  but the file is never half-written. */
function writeCache(path, timings, _fs) {
  const tmp = `${path}.${process.pid}.tmp`;
  _fs.mkdirSync(dirname(path), { recursive: true });
  _fs.writeFileSync(tmp, `${JSON.stringify(timings, null, 2)}\n`);
  _fs.renameSync(tmp, path);
}

export function mergeTimings(timings, updates) {
  const out = { ...timings };
  for (const [file, entry] of Object.entries(updates)) out[timingKey(file)] = entry;
  return out;
}

/** Hash each finished file as it is now, stamp the clock, and merge into the
 *  cache. Concurrent runs can lose one sample; tmp+rename means the file is
 *  never half-written. Returns `{ ok }` rather than throwing: the cache is an
 *  optimisation, never a reason for a test run to fail. */
export function recordTimings({
  resultsDir,
  repoRoot,
  entries,
  _now = Date.now,
  _fs = nodeFs,
} = {}) {
  // The raw cache, not the file-shape reader: measured entries merge into what
  // is already there, command-run entries included.
  const timings = loadTimings(resultsDir, { _readFileSync: _fs.readFileSync });
  const at = _now();
  for (const { file, ms } of entries) {
    if (!Number.isFinite(ms) || ms < 0) continue;
    const sha256 = fileHash(repoRoot, file, _fs.readFileSync);
    if (sha256 === null) continue;
    timings[timingKey(file)] = { ms, sha256, at };
  }
  try {
    writeCache(timingsPath(resultsDir), timings, _fs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The files `--fast` skips: recorded over the bar, measured within the age
 *  limit, and byte-identical to what ran. Sorted, so the skip list reads the
 *  same on every run. A command run's entry carries no `ms`, so the first
 *  guard drops it -- command entries leave this filter by shape. */
export function slowFiles(timings, { repoRoot, _now = Date.now, _readFileSync = nodeFs.readFileSync } = {}) {
  const out = [];
  for (const [file, entry] of Object.entries(timings)) {
    if (!(entry.ms > SLOW_FILE_MS)) continue;
    if (!(_now() - entry.at < MAX_AGE_MS)) continue;
    if (entry.sha256 !== fileHash(repoRoot, file, _readFileSync)) continue;
    out.push({ file, ms: entry.ms });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// --- Command runs (R11/R12) -------------------------------------------------

/** The tree a command recording must be stamped with: HEAD sha and dirty flag.
 *  Null outside git -- a stampless entry would deselect against any later
 *  tree, so nothing records and nothing plays back without one. */
export function treeState(cwd, { _spawnSync = spawnSync } = {}) {
  const sha = _spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const status = _spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (!sha || sha.error || sha.status !== 0 || !status || status.error || status.status !== 0) return null;
  return { sha: String(sha.stdout).trim(), dirty: String(status.stdout).trim() !== "" };
}

/** The per-test guards a `--fast` playthrough keeps: one entry, one bar, one
 *  age, one nodeid question -- so slowFiles and slowCommandTests agree on what
 *  "measured slow" means. */
function measuredSlow(ms, at, { _now }) {
  return ms > SLOW_FILE_MS && at > _now() - MAX_AGE_MS;
}

/** The long-running tests of one command run's entry: over the same bar, aged
 *  the same way, stamped with the tree this run would change, and carrying a
 *  nodeid a `--deselect` can name. Bare-number entries (the pre-nodeid shape)
 *  count as measurements but deselect nothing. A test's own `sha`/`dirty`/`at`
 *  override the entry stamp when present. Sorted, ms first, like slowFiles. */
export function slowCommandTests(entry, { _now = Date.now, sha = null, dirty = false } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  if (entry.sha !== sha || Boolean(entry.dirty) !== Boolean(dirty)) return [];
  const at = Number(entry.at);
  if (typeof at !== "number" || !Number.isFinite(at) || !measuredSlow(Number.MAX_VALUE, at, { _now })) return [];
  const tests = entry.tests && typeof entry.tests === "object" && !Array.isArray(entry.tests) ? entry.tests : {};
  const out = [];
  for (const [name, value] of Object.entries(tests)) {
    const test = typeof value === "number" ? { ms: value } : value;
    if (!test || typeof test !== "object" || Array.isArray(test)) continue;
    const ms = Number(test.ms);
    if (!(typeof ms === "number" && Number.isFinite(ms) && measuredSlow(ms, Number.MAX_VALUE, { _now }))) continue;
    if (test.sha !== undefined && test.sha !== sha) continue;
    if (test.dirty !== undefined && Boolean(test.dirty) !== Boolean(dirty)) continue;
    if (test.at !== undefined) {
      const ownAt = Number(test.at);
      if (!(typeof ownAt === "number" && Number.isFinite(ownAt) && measuredSlow(Number.MAX_VALUE, ownAt, { _now }))) continue;
    }
    if (typeof test.nodeid !== "string" || test.nodeid === "") continue;
    out.push({ name, ms, nodeid: test.nodeid });
  }
  return out.sort((a, b) => b.ms - a.ms || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Stamp the tree, merge this run's timed events into the run's entry, and
 *  write atomically -- the same merge-or-oscillate rule the reporter's failing
 *  file re-measures by: fresh events update or add their names, names absent
 *  from this run's events keep theirs, because the deselected tests of the
 *  next `--fast` run produce no events this side can see. Both entry shapes
 *  pass through untouched. Returns `{ ok }`; like the file writer, an
 *  optimisation is never a reason for a run to fail. */
export function recordCommandTimings({
  resultsDir,
  key,
  events,
  repoRoot,
  _now = Date.now,
  _fs = nodeFs,
  _spawnSync = spawnSync,
} = {}) {
  const tree = treeState(repoRoot, { _spawnSync });
  if (!tree) return { ok: false, error: "no git tree to stamp" };
  const timings = loadTimings(resultsDir, { _readFileSync: _fs.readFileSync });
  const prior = timings[key];
  const tests = prior && typeof prior === "object" && !Array.isArray(prior)
    && prior.tests && typeof prior.tests === "object" && !Array.isArray(prior.tests)
    ? { ...prior.tests }
    : {};
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.name !== "string" || event.name === "") continue;
    // Only a real number measures: ms === null is un-timed, and Number(null)
    // is a finite 0 that would record a fictitious measurement.
    if (typeof event.ms !== "number" || !Number.isFinite(event.ms)) continue; // un-timed records nothing
    const test = { ms: event.ms };
    if (typeof event.nodeid === "string" && event.nodeid !== "") test.nodeid = event.nodeid;
    tests[event.name] = test;
  }
  timings[key] = { at: _now(), sha: tree.sha, dirty: tree.dirty, tests };
  try {
    writeCache(timingsPath(resultsDir), timings, _fs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
