// Selection: a file belongs to a suite when its globs expand to it, and a
// changed path is owned by the suite whose package or home dir holds it.
// `--all`, `--suite` and a diff all name files through `expandRun`.

import * as nodeFs from "node:fs";
import { spawnSync } from "node:child_process";

import { cargoSelection } from "./crates.mjs";
import { CONFIG_NAME } from "./config.mjs";
import { closureOf, isScanner, makeIndex, pyClosure, repoFiles, skipDirsFor } from "./graph.mjs";
import { pythonRootsFor, readPythonPath } from "./python.mjs";
import { anyGlob, expandRun, runCwdRel } from "./select-glob.mjs";
import { commandKey, crateKey, packageOf, suiteFiles, suiteHomeDirs, suitePackages, suiteRoot } from "./select-suite.mjs";

// The module's public surface: callers keep naming a run's files through
// `select.mjs`, whatever file the helper lives in.
export { anyGlob, expandRun, globToRegExp, walkFrom } from "./select-glob.mjs";
export { commandKey, crateKey, packageOf, suiteHomeDirs, suitePackages, suiteRoot } from "./select-suite.mjs";

/** A test pinned to Windows whatever its run's `platform` says. */
export const WIN_TEST = /\.win\.test\.mjs$/;


// --- Selection -------------------------------------------------------------

/** Whether a suite selects by declared `paths` alone: the import graph, the
 *  Python reach, the sibling sweep and the scanner rule are all switched off. */
const pathsMode = (suite) => suite.select === "paths";

/** Selects every file of `suites` whose closure reaches `path`, and returns the
 *  suites it reached. The closure is the caller's: the module import graph for
 *  JavaScript, pytest's own for a Python file, which pytest selects as a unit. */
function sweepReach({ suites, path, indexFor, filesFor, closure, add }) {
  const hit = new Set();
  for (const suite of suites) {
    const index = indexFor(suite);
    for (const file of filesFor(suite)) {
      if (closure(file, index).has(path)) {
        add(suite, file, `changed: ${path}`);
        hit.add(suite.name);
      }
    }
  }
  return hit;
}

/** The suites outside `skip` whose tests reach `path`. A package's own suites
 *  were just walked by the closure rule; a sibling package's importer is the one
 *  a package-scoped walk cannot see, and `skip` is what keeps it from being
 *  walked twice. Command-only suites have no closure to walk. */
function reachableFrom({ suites, path, skip, indexFor, filesFor, add }) {
  const candidates = suites.filter((suite) => !skip.includes(suite) && suite.runs.some((run) => run.globs));
  return sweepReach({ suites: candidates, path, indexFor, filesFor, closure: closureOf, add }).size > 0;
}

/** Which test files a changed set selects, and why: `changed: <path>` (the
 *  graph reached it), `fallback: <path>` (a whole suite, the change could not be
 *  attributed) or `windows` (a `*.win.test.mjs`, which always runs on Windows).
 *  `unowned` lists the non-Markdown changes nothing claimed, so none is ever
 *  dropped as docs-only; a root-homed suite or `repoSuite` takes them instead. */
export function select({
  suites,
  changed,
  repoRoot,
  config = {},
  _readdirSync = nodeFs.readdirSync,
  _readFileSync = nodeFs.readFileSync,
  _spawnSync = spawnSync,
} = {}) {
  const skipDirs = skipDirsFor(config);
  // The roots pytest itself puts on `sys.path`, read once: every suite's index
  // resolves an absolute Python import against them.
  const pythonPath = readPythonPath({ repoRoot, _readFileSync });
  const isPackage = anyGlob(config.packages);
  const isFallback = anyGlob(config.fallback);
  const selectAllGlob = anyGlob(config.selectAll);
  // The config decides what every run does, and the root lockfile pins the
  // runner's own version: neither change can be scoped.
  const isSelectAll = (path) => path === (config.configPath ?? CONFIG_NAME) || path === "package-lock.json"
    || selectAllGlob(path);
  // The cargo graphs and their degrades are one shared state per diff: two
  // runs on the same cwd read metadata once, whatever their suites.
  const cargo = cargoSelection({ repoRoot, glob: anyGlob, _spawnSync, _readFileSync, _readdirSync });
  // Every run a changed path can select through its own declaration: a globs
  // run's `paths` (or a command run's, which also ranks the run as a unit) and
  // a pathless command run, selected by any change. `matches` is null exactly
  // for that last shape, which selects but claims nothing; a cargo run adds
  // the claim object that gates and maps each path to crates.
  const pathRuns = suites.flatMap((suite) => suite.runs.flatMap((run, index) => {
    if (!run.paths && !run.command) return [];
    return [{
      suite, run, index,
      matches: run.paths ? anyGlob(run.paths) : null,
      cargoClaim: run.cargo ? cargo.claim(run, suite.name, index) : null,
    }];
  }));
  const runFiles = new Map();
  const filesOfRun = (suite, run, index) => {
    const key = `${suite.name}\0${index}`;
    if (!runFiles.has(key)) runFiles.set(key, expandRun(run, { repoRoot, skipDirs, _readdirSync }));
    return runFiles.get(key);
  };

  const indexes = new Map();
  const filesCache = new Map();
  // One parse shared by every suite's index: the sweep walks the same modules
  // once per suite, and a specifier may leave its package, so the repo walk is
  // built once and reused.
  const texts = new Map();
  let repoFileSet = null;
  const indexFor = (suite) => {
    if (!indexes.has(suite.name)) {
      if (repoFileSet === null) repoFileSet = repoFiles({ repoRoot, skipDirs, _readdirSync });
      const cwds = suite.runs.filter((run) => run.globs).map(runCwdRel);
      indexes.set(suite.name, makeIndex({
        repoRoot, root: suiteRoot(suite, isPackage), skipDirs, repoFileSet, _texts: texts,
        pythonRoots: pythonRootsFor({ pythonPath, cwds }),
        _readdirSync, _readFileSync,
      }));
    }
    return indexes.get(suite.name);
  };
  const filesFor = (suite) => {
    if (!filesCache.has(suite.name)) filesCache.set(suite.name, suiteFiles(suite, repoRoot, skipDirs, _readdirSync));
    return filesCache.get(suite.name);
  };
  // A Python test is selected as a unit: pytest cannot address one function
  // from the outside, so the sweep works on files.
  const pyFilesFor = (suite) => filesFor(suite).filter((file) => file.endsWith(".py"));
  const pySuites = suites.filter((suite) => pyFilesFor(suite).length > 0);
  // The walker verdict is a property of the file, so it is computed once per
  // suite per diff rather than once per changed path.
  const scannersCache = new Map();
  const scannersFor = (suite) => {
    if (!scannersCache.has(suite.name)) {
      const index = indexFor(suite);
      scannersCache.set(suite.name, filesFor(suite).filter((file) => isScanner(index.read(file))));
    }
    return scannersCache.get(suite.name);
  };

  const why = new Map();
  const add = (suite, file, reason) => {
    const key = `${suite.name}\0${file}`;
    if (!why.has(key)) why.set(key, reason);
  };
  const addWhole = (suite, reason) => {
    for (const file of filesFor(suite)) add(suite, file, reason);
  };
  // A wide run is a suite running whole because nothing attributed the change
  // to a test. Collected once per changed path with the suites it ran whole:
  // the entries keep only the first reason per file, so they cannot carry it.
  const wideOf = new Map();
  const noteWide = (suite, path) => {
    if (!wideOf.has(path)) wideOf.set(path, []);
    const names = wideOf.get(path);
    if (!names.includes(suite.name)) names.push(suite.name);
  };
  const addWide = (suite, path) => {
    addWhole(suite, `fallback: ${path}`);
    noteWide(suite, path);
  };

  /** Selects every Python test whose seeded closure reaches `path`, and returns
   *  the suites it reached. The seed is why a test importing nothing is still
   *  selected when its conftest imports the change. A paths-mode suite never
   *  takes an import edge. */
  const pythonReach = (path) => sweepReach({
    suites: pySuites.filter((suite) => !pathsMode(suite)),
    path, indexFor, filesFor: pyFilesFor, closure: pyClosure, add,
  });
  /** A whole-suite fallback, gated per suite: one suite reaching the change says
   *  nothing about whether another can, and a suite holding a scanner cannot be
   *  narrowed at all because the graph cannot see what that test imports. */
  const wholeFor = (suite, path, reached) => {
    if (!reached.has(suite.name) || scannersFor(suite).length > 0) addWide(suite, path);
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
    // Claim state is per changed path: one change's declared `paths` says
    // nothing about whether the next change in the same diff is attributed.
    // `attributed` is a separate set: a cargo run maps a path to crates without
    // claiming it by declaration, and the path must not also be unowned.
    const claimedBy = new Set();
    const attributed = new Set();
    for (const { suite, run, index, matches, cargoClaim } of pathRuns) {
      if (matches && !matches(path)) continue;
      if (cargoClaim) {
        if (!matches && !cargoClaim.matches(path)) continue; // the derived claim gate
        const names = cargoClaim.map(path);
        const reason = matches ? `paths: ${path}` : `changed: ${path}`;
        if (names === "whole" || names.length === 0) {
          add(suite, commandKey(run, index), reason);
        } else {
          attributed.add(suite.name);
          for (const name of names) {
            add(suite, crateKey(run, index, name), reason);
            cargo.record(suite.name, index, name);
          }
        }
      } else if (run.command) {
        add(suite, commandKey(run, index), matches ? `paths: ${path}` : `changed: ${path}`);
      } else for (const file of filesOfRun(suite, run, index)) add(suite, file, `paths: ${path}`);
      if (matches) claimedBy.add(suite.name); // only a declared `paths` match claims
    }
    const pyReached = pythonReach(path);
    // `pythonpath` moves every Python import, so a change to the manifest cannot
    // be attributed and runs each Python suite whole. A suite with no Python
    // files is untouched: for it the file is an ordinary unreached change.
    if (path === "pyproject.toml" && pySuites.length > 0) {
      for (const suite of pySuites) addWide(suite, path);
      continue;
    }
    const pkg = packageOf(path, isPackage);
    const covering = pkg ? byPackage.get(pkg) || [] : [];
    const owners = [];
    for (const [dir, owned] of byHome) {
      if (dir !== "" && (path === dir || path.startsWith(`${dir}/`))) owners.push(...owned);
    }
    // A suite homed at the root owns only what nothing more specific owns.
    if (owners.length === 0 && covering.length === 0 && claimedBy.size === 0) owners.push(...(byHome.get("") || []));

    if (covering.length > 0) {
      if (isFallback(path)) {
        for (const suite of covering) addWide(suite, path);
      } else {
        const reached = sweepReach({
          suites: covering.filter((suite) => !pathsMode(suite)),
          path, indexFor, filesFor, closure: closureOf, add,
        }).size > 0;
        // A sibling package's test may import the changed module; that edge is
        // outside the covering suites' package-scoped walk, so it is swept for
        // whatever those suites did not already select. A paths-mode suite
        // takes no graph entry, so it is not swept either.
        let swept = false;
        if (pkg !== null && !isFallback(path) && !path.endsWith(".md")) {
          swept = reachableFrom({
            suites: suites.filter((suite) => !pathsMode(suite)),
            path, skip: covering, indexFor, filesFor, add,
          });
        }
        // A test that walks a directory reads whatever it finds, so any change
        // in its package can affect it -- whether or not the graph reached that
        // change through some other test. Markdown is excluded by scope.
        if (!path.endsWith(".md")) {
          for (const suite of covering) {
            if (pathsMode(suite)) continue;
            for (const file of scannersFor(suite)) add(suite, file, `scanner: ${path}`);
          }
        }
        // A non-Markdown file in no closure is invisible to the graph, so the
        // package's whole suite runs -- unless a declared `paths` glob has
        // already said what the change affects, or a test did reach it. A
        // Markdown file is assumed doc-only. A paths-mode suite ignores both
        // `reached` and `swept`: nothing was allowed to determine anything.
        if (!path.endsWith(".md")) {
          for (const suite of covering) {
            if (claimedBy.has(suite.name)) continue;
            if (pathsMode(suite)) addWide(suite, path);
            else if (!reached && !swept) wholeFor(suite, path, pyReached);
          }
        }
      }
    } else if (owners.length > 0) {
      // Outside a package there is no import graph, so a change under a suite's
      // own home runs that suite whole, as an unreached package file does.
      if (!path.endsWith(".md")) {
        for (const suite of owners) {
          if (claimedBy.has(suite.name)) continue;
          if (pathsMode(suite)) addWide(suite, path);
          else wholeFor(suite, path, pyReached);
        }
      }
    } else if (claimedBy.size === 0 && attributed.size === 0 && pyReached.size === 0 && !path.endsWith(".md")) {
      // Owned by nothing else: the repo suite takes it, or it is reported, so
      // a change no suite names is never dropped as docs-only. A path a cargo
      // run mapped to crates is attributed already, not unowned.
      if (repoSuite) addWide(repoSuite, path);
      else unowned.push(path);
    }
  }

  for (const suite of suites) {
    for (const file of filesFor(suite)) {
      if (WIN_TEST.test(file)) add(suite, file, "windows");
    }
  }

  const entries = [];
  for (const suite of suites) {
    for (const file of filesFor(suite)) {
      const reason = why.get(`${suite.name}\0${file}`);
      if (reason) entries.push({ suite: suite.name, file, why: reason });
    }
    // A cargo run's crate keys never sit in its file set, so the recorded
    // crate names are what enumerates them here (first-wins reason included).
    suite.runs.forEach((run, index) => {
      const names = cargo.names(suite.name, index);
      if (!names) return;
      for (const name of names) {
        const file = crateKey(run, index, name);
        const reason = why.get(`${suite.name}\0${file}`);
        if (reason) entries.push({ suite: suite.name, file, why: reason });
      }
    });
  }
  const docsOnly = changed.length > 0 && unowned.length === 0 && entries.every((entry) => entry.why === "windows");
  const wide = [...wideOf].map(([path, suites]) => ({ path, suites }));
  return { entries, docsOnly, unowned, degraded: cargo.records, wide };
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
