// Coverage and diff selection: a file belongs to a suite when its globs expand
// to it, and a changed path is owned by the suite whose package or home dir
// holds it. `--all`, `--suite` and a diff all name files through `expandRun`.

import * as nodeFs from "node:fs";
import { join, posix } from "node:path";

import { CONFIG_NAME } from "./config.mjs";
import { SKIP_DIRS, closureOf, makeIndex, skipDirsFor } from "./graph.mjs";

export { SKIP_DIRS };

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
function staticPrefix(pattern) {
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

function runCwdRel(run) {
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
  for (const pattern of run.globs) {
    const prefix = staticPrefix(pattern);
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

// --- Suite shape -----------------------------------------------------------

/** The repo-relative directory a glob's static part names, cwd included. */
function globHome(run, glob) {
  return posix.join(runCwdRel(run) || ".", staticPrefix(glob)).replace(/^\.\/?/, "");
}

/** The shortest leading directory of `path` that a `packages` glob matches, or
 *  null. `packages: ["packages/*"]` makes `packages/api` the package of
 *  everything below it. */
export function packageOf(path, isPackage) {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (isPackage(candidate)) return candidate;
  }
  return null;
}

/** The packages a suite's glob runs cover, read off their globs and cwd. */
export function suitePackages(suite, isPackage) {
  const out = new Set();
  for (const run of suite.runs) {
    for (const glob of run.globs || []) {
      const pkg = packageOf(globHome(run, glob), isPackage);
      if (pkg) out.add(pkg);
    }
  }
  return out;
}

/** The directories outside every package a suite's runs live in: the glob's
 *  static prefix with its trailing `tests` dropped, so a `bakeoff/.../tests`
 *  run owns its protocol directory. Package globs keep the import-closure rule. */
export function suiteHomeDirs(suite, isPackage) {
  const out = new Set();
  for (const run of suite.runs) {
    for (const glob of run.globs || []) {
      const parts = globHome(run, glob).split("/").filter(Boolean);
      if (parts[parts.length - 1] === "tests") parts.pop();
      if (parts.length === 0) continue;
      const home = parts.join("/");
      if (packageOf(home, isPackage)) continue;
      out.add(home);
    }
  }
  return out;
}

/** The directory a suite's graph may look inside. A package suite cannot see a
 *  sibling package: two files of the same basename in different packages must
 *  never be confused for each other. */
export function suiteRoot(suite, isPackage) {
  const packages = suitePackages(suite, isPackage);
  if (packages.size === 1) return [...packages][0];
  const first = suite.runs.find((run) => run.globs);
  return first ? globHome(first, first.globs[0]) : "";
}

/** A command run's selection key, standing where a glob run has file paths:
 *  `command:<label>`, or `command:<index>` for an unlabelled run. */
export function commandKey(run, index) {
  return `command:${run.label ?? index}`;
}

/** A suite's glob files, sorted, then its command runs' keys in run order. */
function suiteFiles(suite, repoRoot, skipDirs, _readdirSync) {
  const out = new Set();
  for (const run of suite.runs) {
    for (const file of expandRun(run, { repoRoot, skipDirs, _readdirSync })) out.add(file);
  }
  const commands = suite.runs.flatMap((run, index) => (run.command ? [commandKey(run, index)] : []));
  return [...[...out].sort(), ...commands];
}

// --- Selection -------------------------------------------------------------

/** Which test files a changed set selects, and why.
 *
 *  `why` is `changed: <path>` for a file the graph reached, `fallback: <path>`
 *  for a whole suite a change could not be attributed to, and `windows` for a
 *  `*.win.test.mjs`, which always runs on a Windows machine. A command run is
 *  selected as a unit: by a change its `paths` match, by any change when it has
 *  none, and by a select-all change. `config` supplies `packages`, `fallback`,
 *  `selectAll`, `repoSuite`, `skipDirs` and `configPath`.
 *
 *  `unowned` lists the non-Markdown changes nothing claimed. With a `repoSuite`
 *  that suite takes them instead, so either way none is dropped as docs-only. */
export function select({
  suites,
  changed,
  repoRoot,
  config = {},
  _readdirSync = nodeFs.readdirSync,
  _readFileSync = nodeFs.readFileSync,
} = {}) {
  const skipDirs = skipDirsFor(config);
  const isPackage = anyGlob(config.packages);
  const isFallback = anyGlob(config.fallback);
  const selectAllGlob = anyGlob(config.selectAll);
  // The config decides what every run does, and the root lockfile pins the
  // runner's own version: neither change can be scoped.
  const isSelectAll = (path) => path === (config.configPath ?? CONFIG_NAME) || path === "package-lock.json"
    || selectAllGlob(path);
  const commandRuns = suites.flatMap((suite) => suite.runs.flatMap((run, index) => (run.command
    ? [{ suite, key: commandKey(run, index), matches: run.paths ? anyGlob(run.paths) : null }]
    : [])));

  const indexes = new Map();
  const filesCache = new Map();
  const indexFor = (suite) => {
    if (!indexes.has(suite.name)) {
      indexes.set(suite.name, makeIndex({
        repoRoot, root: suiteRoot(suite, isPackage), skipDirs, _readdirSync, _readFileSync,
      }));
    }
    return indexes.get(suite.name);
  };
  const filesFor = (suite) => {
    if (!filesCache.has(suite.name)) filesCache.set(suite.name, suiteFiles(suite, repoRoot, skipDirs, _readdirSync));
    return filesCache.get(suite.name);
  };

  const why = new Map();
  const add = (suite, file, reason) => {
    const key = `${suite.name}\0${file}`;
    if (!why.has(key)) why.set(key, reason);
  };
  const addWhole = (suite, reason) => {
    for (const file of filesFor(suite)) add(suite, file, reason);
  };

  const byPackage = new Map();
  for (const suite of suites) {
    for (const pkg of suitePackages(suite, isPackage)) {
      if (!byPackage.has(pkg)) byPackage.set(pkg, []);
      byPackage.get(pkg).push(suite);
    }
  }
  const byHome = new Map();
  for (const suite of suites) {
    for (const dir of suiteHomeDirs(suite, isPackage)) {
      if (!byHome.has(dir)) byHome.set(dir, []);
      byHome.get(dir).push(suite);
    }
  }
  const repoSuite = suites.find((suite) => suite.name === config.repoSuite) || null;

  const unowned = [];
  for (const path of changed) {
    if (isSelectAll(path)) {
      for (const suite of suites) addWhole(suite, `fallback: ${path}`);
      continue;
    }
    let claimed = false; // by a command run's `paths`
    for (const { suite, key, matches } of commandRuns) {
      if (!matches) add(suite, key, `changed: ${path}`);
      else if (matches(path)) {
        add(suite, key, `changed: ${path}`);
        claimed = true;
      }
    }
    const pkg = packageOf(path, isPackage);
    const covering = pkg ? byPackage.get(pkg) || [] : [];
    const owners = [];
    for (const [dir, owned] of byHome) {
      if (path === dir || path.startsWith(`${dir}/`)) owners.push(...owned);
    }

    if (covering.length > 0) {
      if (isFallback(path)) {
        for (const suite of covering) addWhole(suite, `fallback: ${path}`);
      } else {
        let reached = false;
        for (const suite of covering) {
          const index = indexFor(suite);
          for (const file of filesFor(suite)) {
            if (closureOf(file, index).has(path)) {
              add(suite, file, `changed: ${path}`);
              reached = true;
            }
          }
        }
        // A non-Markdown file in no closure is invisible to the graph, so the
        // package's whole suite runs. A Markdown file is assumed doc-only.
        if (!reached && !path.endsWith(".md")) {
          for (const suite of covering) addWhole(suite, `fallback: ${path}`);
        }
      }
    } else if (owners.length > 0) {
      // Outside a package there is no import graph, so a change under a suite's
      // own home runs that suite whole, as an unreached package file does.
      if (!path.endsWith(".md")) {
        for (const suite of owners) addWhole(suite, `fallback: ${path}`);
      }
    } else if (!claimed && !path.endsWith(".md")) {
      // Owned by nothing else: the repo suite takes it, or it is reported, so
      // a change no suite names is never dropped as docs-only.
      if (repoSuite) addWhole(repoSuite, `fallback: ${path}`);
      else unowned.push(path);
    }
  }

  for (const suite of suites) {
    for (const file of filesFor(suite)) {
      if (file.endsWith(".win.test.mjs")) add(suite, file, "windows");
    }
  }

  const entries = [];
  for (const suite of suites) {
    for (const file of filesFor(suite)) {
      const reason = why.get(`${suite.name}\0${file}`);
      if (reason) entries.push({ suite: suite.name, file, why: reason });
    }
  }
  const docsOnly = changed.length > 0 && unowned.length === 0 && entries.every((entry) => entry.why === "windows");
  return { entries, docsOnly, unowned };
}

/** Every file of every suite, as `--all` and `--suite` see them. */
export function wholeEntries(suites, { repoRoot, config = {}, _readdirSync } = {}) {
  const skipDirs = skipDirsFor(config);
  const entries = [];
  for (const suite of suites) {
    for (const file of suiteFiles(suite, repoRoot, skipDirs, _readdirSync)) {
      entries.push({ suite: suite.name, file, why: "suite" });
    }
  }
  return entries;
}
