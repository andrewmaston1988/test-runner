// Glob expansion: what a run's globs match on disk. The walk starts from a
// glob's static prefix, so a suite's expansion never reaches the rest of the
// tree.

import * as nodeFs from "node:fs";
import { join, posix } from "node:path";

import { SKIP_DIRS } from "./graph.mjs";

// --- Glob expansion --------------------------------------------------------

/** `**` matches zero or more directories, `*` never crosses `/`. */
export function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/** One matcher for a list of globs: true when any of them matches `path`. */
export function anyGlob(globs) {
  const matchers = (globs || []).map(globToRegExp);
  return (path) => matchers.some((matcher) => matcher.test(path));
}

/** The leading path with no wildcard in it. Walking from here rather than from
 *  the run's cwd is what keeps a suite's expansion off the rest of the tree. */
export function staticPrefix(pattern) {
  const parts = pattern.split("/");
  const kept = [];
  for (const part of parts) {
    if (/[*?]/.test(part)) break;
    kept.push(part);
  }
  return kept.join("/");
}

/** Every file under `absDir`, repo-relative posix, refusing the directories
 *  `skipDirs` names. The orphan check walks the whole repository with it, so
 *  one walker decides what "a file in this repo" means for both. */
export function walkFrom(absDir, relBase, out, _readdirSync = nodeFs.readdirSync, skipDirs = SKIP_DIRS) {
  let entries;
  try {
    entries = _readdirSync(absDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walkFrom(join(absDir, entry.name), rel, out, _readdirSync, skipDirs);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return true;
}

/** A run's cwd as a repo-relative posix path, `""` for the repository root. */
export function runCwdRel(run) {
  return run.cwd === "." || run.cwd === "" ? "" : posix.normalize(run.cwd);
}

/** Repo-relative posix paths a run's globs match, sorted. Empty means the run
 *  is misconfigured: `node --test` with no file arguments discovers whatever
 *  happens to sit in its cwd, which is how a suite's own fixtures get executed. */
export function expandRun(run, { repoRoot, skipDirs = SKIP_DIRS, _readdirSync = nodeFs.readdirSync } = {}) {
  if (!run.globs) return [];
  const cwdAbs = join(repoRoot, run.cwd);
  const matchers = run.globs.map(globToRegExp);
  const exclusions = run.exclude || [];
  const relToCwd = [];
  // One walk per distinct prefix: `tests/**` and `tests/*.test.mjs` share a
  // prefix, and walking the tree twice would return the same files twice.
  const walked = new Set();
  for (const pattern of run.globs) {
    const prefix = staticPrefix(pattern);
    if (walked.has(prefix)) continue;
    walked.add(prefix);
    // A prefix that is not a directory is a literal file path.
    if (!walkFrom(join(cwdAbs, prefix), prefix, relToCwd, _readdirSync, skipDirs) && prefix !== "") {
      relToCwd.push(prefix);
    }
  }
  const cwdRel = runCwdRel(run);
  const found = new Set();
  for (const rel of relToCwd) {
    if (!matchers.some((matcher) => matcher.test(rel))) continue;
    if (exclusions.some((fragment) => rel.includes(fragment))) continue;
    found.add(cwdRel === "" ? rel : posix.join(cwdRel, rel));
  }
  return [...found].sort();
}
