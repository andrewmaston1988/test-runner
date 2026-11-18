// The import graph a diff-aware run selects on: a test is selected when a
// changed file is reachable from it. Over-selection costs seconds; a missed
// test costs a red PR, so anything the graph cannot see falls back to the suite.

import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { conftestsFor, pythonEdges } from "./python.mjs";

/** Where `--wsl` puts the host's copy of this package inside the mirror. */
export const MIRROR_PACKAGE = ".test-runner";

/** Never walked: a dependency tree, git's own storage, the mirror's package
 *  copy, whose tests are not the consumer's, and Python's dependency tree. A
 *  consumer adds its own (`skipDirs`) through `skipDirsFor`. */
export const SKIP_DIRS = new Set(["node_modules", ".git", MIRROR_PACKAGE, ".venv"]);

/** The built-in skips plus the config's. */
export function skipDirsFor(config) {
  return new Set([...SKIP_DIRS, ...((config && config.skipDirs) || [])]);
}

// `import x from "…"`, `import { a } from "…"`, `import "…"`. The optional
// middle group excludes parens so a dynamic `import("…")` is left to its own
// rule rather than captured with a garbage specifier.
const STATIC_IMPORT = /\bimport\s+(?:[^"'`()]*?\bfrom\s+)?["']([^"'\n]+)["']/g;
const EXPORT_FROM = /\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const URL_LITERAL = /\bnew\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g;
const ANY_LITERAL = /["']([^"'\n]+)["']/g;

const MODULE_SUFFIXES = [".mjs", ".js", ".json", "/index.mjs", "/index.js"];

// A test that walks a directory, or imports a name the graph cannot read, has
// no literal to follow, so the graph cannot see what it depends on. One token
// table, across the languages a consumer may mix.
// No `g` flag: a global regex carries `lastIndex` between calls.
export const DIR_WALK = /\b(?:readdir(?:Sync)?|opendir(?:Sync)?|glob(?:Sync)?|globby|rglob|scandir|iglob|walkdir|os\.walk|DirAccess|Get-ChildItem|import_module|__import__|spec_from_file_location|runpy\.run_path|importlib\.util\.find_spec|pkgutil\.walk_packages)\b/;

/** Whether a file's text walks directories, and so must run on any change in
 *  its package rather than only on what the graph reaches. */
export function isScanner(text) {
  return typeof text === "string" && DIR_WALK.test(text);
}

function walk(rel, out, repoRoot, _readdirSync, skipDirs) {
  let entries;
  try {
    entries = _readdirSync(join(repoRoot, rel), { withFileTypes: true });
  } catch {
    return; // a root that does not exist is an empty index, not an error
  }
  for (const entry of entries) {
    const child = rel === "" ? entry.name : posix.join(rel, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(child, out, repoRoot, _readdirSync, skipDirs);
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
}

/** Every file in the repository, repo-relative posix. The walker the indexes
 *  use, over the whole tree: a relative specifier may leave its package, and
 *  only this set can say whether the file it names exists. */
export function repoFiles({ repoRoot, skipDirs = SKIP_DIRS, _readdirSync = readdirSync } = {}) {
  const files = [];
  walk("", files, repoRoot, _readdirSync, skipDirs);
  return new Set(files);
}

/** Every file under `root`, plus the lookup tables the walker needs.
 *
 *  `root` is repo-relative posix ("" is the repo root); the walk never leaves
 *  it, so a package suite's basename matching cannot be pulled sideways into a
 *  sibling package's file of the same name. `repoFileSet` widens only specifier
 *  resolution -- not the basename table -- and `_texts` lets every suite's index
 *  share one parse of the same file. */
export function makeIndex({
  repoRoot,
  root = "",
  skipDirs = SKIP_DIRS,
  repoFileSet = null,
  pythonRoots = [""],
  _texts = new Map(),
  _readdirSync = readdirSync,
  _readFileSync = readFileSync,
} = {}) {
  const files = [];
  walk(root, files, repoRoot, _readdirSync, skipDirs);
  files.sort();
  const byBasename = new Map();
  for (const file of files) {
    const base = posix.basename(file);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(file);
  }
  const fileSet = new Set(files);
  return {
    repoRoot,
    root,
    files,
    fileSet,
    resolveSet: repoFileSet ?? fileSet,
    byBasename,
    pythonRoots,
    memo: new Map(),
    pyMemo: new Map(),
    edges: new Map(),
    texts: _texts,
    _readFileSync,
    /** File text, or null when it cannot be read. Cached: one closure per test
     *  file over the same module is the normal shape. */
    read(file) {
      if (this.texts.has(file)) return this.texts.get(file);
      let text = null;
      try {
        text = this._readFileSync(join(repoRoot, file), "utf8");
      } catch {
        text = null;
      }
      this.texts.set(file, text);
      return text;
    },
  };
}

/** Relative specifiers resolved against the importing file, extensionless ones
 *  tried with the suffixes ESM and Node resolution would add. */
function resolveModule(spec, fromFile, index) {
  if (!spec.startsWith(".")) return [];
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const candidate of [base, ...MODULE_SUFFIXES.map((suffix) => base + suffix)]) {
    if (index.resolveSet.has(candidate)) return [candidate];
  }
  return [];
}

/** Where `prefix` sits in the sorted file list: every file under a directory
 *  prefix starts here and runs contiguously, so the scan covers that block
 *  rather than the whole repository, once per literal. */
function lowerBound(files, prefix) {
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A `new URL("<rel>", import.meta.url)` literal: a file, or a named directory
 *  whose every file it names (`new URL("../templates", …)`). A literal ending
 *  in `.` or `..` is a locator for a computed root, not a named directory, so
 *  it adds no contents of its own. */
function resolveUrlLiteral(literal, fromFile, index) {
  const clean = literal.split("?")[0].split("#")[0];
  const out = resolveModule(clean, fromFile, index);
  const last = posix.basename(clean.replace(/\/+$/, ""));
  if (last === "" || last === "." || last === "..") return out;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), clean));
  const prefix = base === "." || base === "" ? null : `${base}/`;
  if (prefix === null) return out;
  for (let i = lowerBound(index.files, prefix); i < index.files.length; i++) {
    const file = index.files[i];
    if (!file.startsWith(prefix)) break;
    out.push(file);
  }
  return out;
}

/** Bare or path-shaped string literals that name an existing file. */
function basenameEdges(text, index) {
  const out = [];
  ANY_LITERAL.lastIndex = 0;
  let match;
  while ((match = ANY_LITERAL.exec(text)) !== null) {
    const literal = match[1];
    if (literal.length > 200 || /\s/.test(literal)) continue;
    const normalised = literal.replace(/\\/g, "/").replace(/^\.\//, "");
    const base = posix.basename(normalised);
    if (base === "" || base === "." || base === "..") continue;
    const hits = index.byBasename.get(base);
    if (!hits) continue;
    // Any literal whose basename names a file in the package is an edge, whatever
    // path prefix it carries. That is what catches `join(here, "..", "bin", "x.mjs")`.
    for (const file of hits) out.push(file);
  }
  return out;
}

/** Every file a JavaScript source names, by any of the four edge kinds. */
function jsEdges(file, text, index) {
  const out = new Set();
  for (const [pattern, resolve] of [
    [STATIC_IMPORT, (spec) => resolveModule(spec, file, index)],
    [EXPORT_FROM, (spec) => resolveModule(spec, file, index)],
    [DYNAMIC_IMPORT, (spec) => resolveModule(spec, file, index)],
    [URL_LITERAL, (literal) => resolveUrlLiteral(literal, file, index)],
  ]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      for (const target of resolve(match[1])) out.add(target);
    }
  }
  return out;
}

/** Every file one file names. The edge kind follows the extension: Python
 *  imports resolve against `pythonRoots`, not against the importer's directory. */
export function edgesOf(file, text, index) {
  const out = file.endsWith(".py") ? pythonEdges(file, text, index) : jsEdges(file, text, index);
  for (const target of basenameEdges(text, index)) out.add(target);
  out.delete(file);
  return out;
}

/** A file's direct edges, derived once per index: closures that share a module
 *  would otherwise re-parse it once each. */
function edgesFor(file, index) {
  let edges = index.edges.get(file);
  if (!edges) {
    const text = index.read(file);
    edges = text === null ? new Set() : edgesOf(file, text, index);
    index.edges.set(file, edges);
  }
  return edges;
}

/** Every file reachable from `file`, itself included. Memoised per file and
 *  cycle-safe, so a graph of modules importing each other costs one walk. */
export function closureOf(file, index) {
  const cached = index.memo.get(file);
  if (cached) return cached;
  const seen = new Set();
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of edgesFor(current, index)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  index.memo.set(file, seen);
  return seen;
}

/** Every file reachable from a Python test, plus what every conftest pytest
 *  loads for it reaches. A fixture-using test that imports nothing is selected
 *  only through this seed. Memoised per file in its own map: the plain closure
 *  is what the package branch asks for, and it must stay conftest-free there. */
export function pyClosure(file, index) {
  const cached = index.pyMemo.get(file);
  if (cached) return cached;
  const seen = new Set(closureOf(file, index));
  for (const conftest of conftestsFor(file, index)) {
    for (const target of closureOf(conftest, index)) seen.add(target);
  }
  index.pyMemo.set(file, seen);
  return seen;
}
