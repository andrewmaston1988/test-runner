// Python imports, resolved the way pytest resolves them: absolute names
// against the repository root and each `pythonpath` entry, relative dots from
// the importing file's own directory. `from a.b import c` names both the
// package and the submodule, because either may be what `c` is.

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

// Line-anchored, so a commented `# from x import y` cannot match even before
// the comment strip. The parenthesised arm crosses newlines; the bare arm stops
// at the end of the statement.
const FROM_IMPORT = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)/gm;
const PLAIN_IMPORT = /^[ \t]*import[ \t]+([^\n;]+)/gm;
// The literal `importlib.import_module("a.b")` form. A variable name is left
// unextracted, and makes its suite a scanner (see DIR_WALK in graph.mjs).
const IMPORT_CALL = /\b(?:import_module|__import__)\s*\(\s*["']([\w.]+)["']/g;

/** The names a `from x import (a, b as c)` statement brings in. Parens are
 *  stripped, `as` aliases discarded, and only identifier-shaped tokens kept, so
 *  a star or a stray bracket never becomes a module. */
export function importedNames(text) {
  return String(text)
    .trim()
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .split(",")
    .map((item) => item.trim().split(/\s+as\s+/)[0].trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name));
}

/** The dotted module names a plain `import a.b, c as d` statement brings in. */
function plainNames(text) {
  return String(text)
    .split(",")
    .map((item) => item.trim().split(/\s+as\s+/)[0].trim())
    .filter((name) => /^[A-Za-z_][\w.]*$/.test(name));
}

function modulePath(name) {
  return String(name).split(".").filter(Boolean).join("/");
}

/** One level of climbing per dot past the first, from the importing file's
 *  directory: `..` in `a/b/mod.py` resolves in `a/`. */
function climb(dir, levels) {
  let out = dir;
  for (let i = 0; i < levels; i++) {
    if (out === "" || out === ".") return "";
    out = posix.dirname(out);
  }
  return out === "." ? "" : out;
}

/** The files a module path could be: the module, its package, and every
 *  ancestor package's `__init__.py` -- all of which Python executes. */
function candidates(modulePath, index) {
  const out = [];
  const path = modulePath.replace(/^\.\//, "").replace(/\/+$/, "");
  if (path === "" || path === ".") return out;
  if (index.resolveSet.has(`${path}.py`)) out.push(`${path}.py`);
  if (index.resolveSet.has(`${path}/__init__.py`)) out.push(`${path}/__init__.py`);
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const init = `${parts.slice(0, i).join("/")}/__init__.py`;
    if (index.resolveSet.has(init)) out.push(init);
  }
  return out;
}

/** Every file keyed by each path suffix it ends with, built once per index.
 *  The fallback arm asks the repository once per index, not once per import. */
function suffixEntries(index) {
  if (!index.suffixEntries) {
    const map = new Map();
    for (const file of index.resolveSet) {
      const parts = String(file).split("/");
      for (let i = 0; i < parts.length; i++) {
        const suffix = parts.slice(i).join("/");
        if (!map.has(suffix)) map.set(suffix, []);
        map.get(suffix).push(file);
      }
    }
    index.suffixEntries = map;
  }
  return index.suffixEntries;
}

/** `candidates()` for a name no configured root resolved: the same three arms
 *  matched as path suffixes. A repository file whose tail is the module path is
 *  the module Python would import had its directory been on `sys.path`. */
function suffixCandidates(modulePath, index) {
  const path = String(modulePath).replace(/^\.\//, "").replace(/\/+$/, "");
  if (path === "" || path === ".") return [];
  const map = suffixEntries(index);
  const arms = [`${path}.py`, `${path}/__init__.py`];
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) arms.push(`${parts.slice(0, i).join("/")}/__init__.py`);
  const out = [];
  for (const arm of arms) {
    for (const file of map.get(arm) || []) {
      if (!out.includes(file)) out.push(file);
    }
  }
  return out;
}

/** The exact resolution, or -- when no configured root resolved the name -- the
 *  suffix fallback. Relative imports never fall back: their target is
 *  deterministic, so a suffix match there would be a false edge. */
function resolveName(name, index, relative) {
  const exact = candidates(name, index);
  if (exact.length > 0 || relative) return exact;
  return suffixCandidates(name, index);
}

/** Every file a Python source names. The caller (`edgesOf`) adds the basename
 *  literals and removes the file itself. */
export function pythonEdges(file, text, index) {
  const out = new Set();
  // A trailing comment must not swallow the statement after it, and Python has
  // no `;` inside an import, so a split recovers two statements on one line.
  const source = String(text).replace(/#.*$/gm, "").split(";").join("\n");
  const roots = index.pythonRoots || [""];

  FROM_IMPORT.lastIndex = 0;
  let match;
  while ((match = FROM_IMPORT.exec(source)) !== null) {
    const spec = match[1] || "";
    const module = spec.replace(/^\.+/, "");
    const dots = spec.length - module.length;
    const rest = modulePath(module);
    const names = importedNames(match[2] || "");
    const bases = dots > 0
      ? [posix.join(climb(posix.dirname(file), dots - 1), rest)]
      : roots.map((root) => posix.join(root || ".", rest));
    for (const base of bases) {
      for (const target of resolveName(base, index, dots > 0)) out.add(target);
      for (const name of names) {
        for (const target of resolveName(posix.join(base, name), index, dots > 0)) out.add(target);
      }
    }
  }

  PLAIN_IMPORT.lastIndex = 0;
  while ((match = PLAIN_IMPORT.exec(source)) !== null) {
    for (const name of plainNames(match[1] || "")) {
      const rest = modulePath(name);
      for (const root of roots) {
        for (const target of resolveName(posix.join(root || ".", rest), index, false)) out.add(target);
      }
    }
  }

  IMPORT_CALL.lastIndex = 0;
  while ((match = IMPORT_CALL.exec(source)) !== null) {
    const rest = modulePath(match[1]);
    for (const root of roots) {
      for (const target of resolveName(posix.join(root || ".", rest), index, false)) out.add(target);
    }
  }
  return out;
}

/** Every `conftest.py` pytest loads for `file`: its directory's, then each
 *  ancestor's up to the repository root. A conftest's own imports reach every
 *  test under it, which is how a fixture-using test that imports nothing is
 *  selected. */
export function conftestsFor(file, index) {
  const dirs = [];
  let dir = posix.dirname(file);
  if (dir === ".") dir = "";
  while (true) {
    dirs.push(dir);
    if (dir === "") break;
    dir = posix.dirname(dir);
    if (dir === ".") dir = "";
  }
  return dirs
    .map((d) => (d === "" ? "conftest.py" : posix.join(d, "conftest.py")))
    .filter((candidate) => index.resolveSet.has(candidate));
}

function bracketDepth(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth;
}

/** The `pythonpath` entries under `[tool.pytest.ini_options]`, repo-relative.
 *  A plain line scanner, not a TOML reader: the package imports only Node
 *  builtins, and the section has to be respected or a key in another table (or
 *  in a comment) becomes a root that resolves into the wrong file. */
export function readPythonPath({ repoRoot, _readFileSync = readFileSync } = {}) {
  let text;
  try {
    text = _readFileSync(join(repoRoot, "pyproject.toml"), "utf8");
  } catch {
    return [];
  }
  const lines = String(text).split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      inSection = header[1].trim() === "tool.pytest.ini_options";
      continue;
    }
    if (!inSection) continue;
    const key = /^\s*pythonpath\s*=\s*(.*)$/.exec(line);
    if (!key) continue;
    const start = key[1].indexOf("[");
    if (start === -1) return [];
    let chunk = key[1].slice(start);
    for (let j = i + 1; bracketDepth(chunk) > 0 && j < lines.length; j++) {
      if (/^\s*#/.test(lines[j])) continue;
      chunk += `\n${lines[j]}`;
    }
    if (bracketDepth(chunk) !== 0) return [];
    return [...chunk.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
  }
  return [];
}

/** The roots an absolute Python import may resolve against: the repository
 *  root first, then `pythonpath`, then each run's cwd. Posix, no trailing
 *  slash, deduplicated. Joined with `posix.join`, never by concatenation. */
export function pythonRootsFor({ pythonPath = [], cwds = [] } = {}) {
  const roots = [];
  const add = (entry) => {
    let normalised = String(entry ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalised === ".") normalised = "";
    normalised = normalised.replace(/^\.\//, "");
    if (!roots.includes(normalised)) roots.push(normalised);
  };
  add("");
  for (const entry of [...pythonPath, ...cwds]) add(entry);
  return roots;
}
