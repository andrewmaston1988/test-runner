// One dispatch's temp root: every test process the runner starts sees TEMP,
// TMP and TMPDIR inside it, so the dirs a test makes land under one named
// parent instead of scattering through the OS temp dir. A passing run removes
// its root; a failing or timed-out one keeps it as evidence, and the next
// dispatch prunes the kept ones so they cannot grow without bound.

import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** All three on every platform. Cheap, and a WSL or Git Bash child reads
 *  whichever its own platform's runtime uses. */
const TEMP_VARS = ["TEMP", "TMP", "TMPDIR"];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Kept roots: the newest few failures per label are enough to compare, and a
 *  failure nobody looked at within a few days is not going to be. */
export const KEEP_PER_LABEL = 3;
export const MAX_AGE_DAYS = 3;

/** A root written to this recently may still belong to a live run; deleting it
 *  mid-run would take its evidence with it. */
export const MIN_AGE_HOURS = 24;

/** A root the runner made: its label, then `mkdtemp`'s six-character suffix. */
const CANDIDATE = /^(.+)-[A-Za-z0-9]{6}$/;

/** A process outliving its run on Windows can hold a file open; retry, then
 *  leave it for the next prune. */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

/** Labels carry `[`/`]` (from `suite[label]`); a directory name is easier to
 *  read beside the rest of `%TEMP%` without them. */
function safe(text) {
  return text.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** An empty root holds no evidence, so it is removed even after a failure. An
 *  unreadable one is kept rather than guessed at. */
function emptyRoot(fs, path) {
  try {
    return fs.readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/** A root counts as touched at the newest mtime among itself and its direct
 *  entries: a write deep inside moves only its own entry's mtime. */
function touchedMs(fs, path, mtimeMs) {
  let newest = mtimeMs;
  try {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const name = typeof entry === "string" ? entry : entry.name;
      try {
        newest = Math.max(newest, fs.statSync(join(path, name)).mtimeMs);
      } catch {}
    }
  } catch {}
  return newest;
}

/** The bytes a root holds, for the log line only. */
function sizeOf(fs, path) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const name = typeof entry === "string" ? entry : entry.name;
      const child = join(path, name);
      try {
        // lstat, not stat: a kept root can hold a junction, and following one
        // back up the tree would recurse without end before the prune runs.
        const stat = fs.lstatSync(child);
        total += stat.isDirectory() ? sizeOf(fs, child) : stat.size;
      } catch {}
    }
  } catch {}
  return total;
}

/** Remove kept roots under `parent` that are too old, or beyond the newest
 *  `KEEP_PER_LABEL` sharing their label. A root touched within
 *  `MIN_AGE_HOURS` is left alone and takes no slot. Best effort: a root that
 *  cannot be read is kept, one that cannot be removed is a log line. */
export function pruneKeptRoots({ parent, now = Date.now(), _fs = nodeFs, _log = () => {} }) {
  const groups = new Map();
  for (const entry of _fs.readdirSync(parent, { withFileTypes: true })) {
    const name = typeof entry === "string" ? entry : entry.name;
    const match = CANDIDATE.exec(name);
    if (!match) continue;
    const path = join(parent, name);
    let stat;
    try {
      stat = _fs.statSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const group = groups.get(match[1]) ?? [];
    group.push({ path, touched: touchedMs(_fs, path, stat.mtimeMs) });
    groups.set(match[1], group);
  }

  let removed = 0;
  let bytes = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => b.touched - a.touched);
    let kept = 0;
    for (const root of group) {
      const age = now - root.touched;
      if (age < MIN_AGE_HOURS * HOUR_MS) continue;
      if (kept < KEEP_PER_LABEL && age <= MAX_AGE_DAYS * DAY_MS) {
        kept++;
        continue;
      }
      const size = sizeOf(_fs, root.path);
      try {
        _fs.rmSync(root.path, RM_OPTIONS);
        bytes += size;
        removed++;
      } catch (err) {
        _log(`[test] could not prune temp root ${root.path} (${err.code})`);
      }
    }
  }
  if (removed > 0) {
    _log(`[test] pruned ${removed} kept temp roots (${Math.round(bytes / 1024 / 1024)} MB)`);
  }
}

/** Run `fn(tempEnv)` in a fresh `<tmpdir>/test-runner/<label>-XXXXXX`. A
 *  `runEnv` temp var opts out. Removed on a pass or when empty, kept and named
 *  otherwise; a root that cannot be made or removed is a log line, never a failure. */
export async function withTempRoot({
  label,
  runEnv = {},
  _fs = nodeFs,
  _tmpdir = tmpdir,
  _now = Date.now,
  _log = () => {},
}, fn) {
  if (TEMP_VARS.some((name) => runEnv[name] !== undefined)) return fn({});

  const parent = join(_tmpdir(), "test-runner");
  try {
    _fs.mkdirSync(parent, { recursive: true });
  } catch (err) {
    _log(`[test] ${label}: no temp root under ${parent} (${err.code})`);
    return fn({});
  }

  // Outside the root-making try: an error here must not cost the run its root.
  try {
    pruneKeptRoots({ parent, now: _now(), _fs, _log });
  } catch (err) {
    _log(`[test] ${label}: could not prune kept temp roots (${err.code ?? err.message})`);
  }

  let root;
  try {
    root = _fs.mkdtempSync(join(parent, `${safe(label)}-`));
  } catch (err) {
    _log(`[test] ${label}: no temp root under ${parent} (${err.code})`);
    return fn({});
  }
  const tempEnv = { TEMP: root, TMP: root, TMPDIR: root };

  let result;
  try {
    result = await fn(tempEnv);
  } catch (err) {
    // The throw is the caller's to report; the root it may have written to
    // stays where the evidence is.
    _log(`[test] ${label}: temp root kept at ${root}`);
    throw err;
  }

  if (result?.ok || emptyRoot(_fs, root)) {
    try {
      _fs.rmSync(root, RM_OPTIONS);
    } catch (err) {
      // A process outliving the run on Windows can hold a file open. One named
      // dir under the shared parent is bounded; a failed run is not.
      _log(`[test] ${label}: could not remove temp root ${root} (${err.code})`);
    }
    return result;
  }

  _log(`[test] ${label}: temp root kept at ${root}`);
  return result;
}
