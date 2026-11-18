// Suite shape: which packages, home directories and root a suite's runs cover,
// and the selection keys a command or cargo run stands behind.

import { posix } from "node:path";

import { expandRun, runCwdRel, staticPrefix } from "./select-glob.mjs";

/** The repo-relative directory a glob's static part names, cwd included. */
function globHome(run, glob) {
  return posix.join(runCwdRel(run) || ".", staticPrefix(glob)).replace(/^\.(\/|$)/, "");
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
 *  static prefix with its trailing `tests` dropped, so a `tools/map/tests` run
 *  owns `tools/map`. A root `tests/` glob yields `""`, the repository root.
 *  Package globs keep the import-closure rule. */
export function suiteHomeDirs(suite, isPackage) {
  const out = new Set();
  for (const run of suite.runs) {
    for (const glob of run.globs || []) {
      const parts = globHome(run, glob).split("/").filter(Boolean);
      if (parts[parts.length - 1] === "tests") parts.pop();
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

/** A cargo run's per-crate key, one `-p` package of the run's shared
 *  invocation: `command:<base>#<crate>`. The crates are enumerated through the
 *  cargo selection's record, not the run's file set. */
export function crateKey(run, index, name) {
  return `${commandKey(run, index)}#${name}`;
}

/** A suite's glob files, sorted, then its command runs' keys in run order. */
export function suiteFiles(suite, repoRoot, skipDirs, _readdirSync) {
  const out = new Set();
  for (const run of suite.runs) {
    for (const file of expandRun(run, { repoRoot, skipDirs, _readdirSync })) out.add(file);
  }
  const commands = suite.runs.flatMap((run, index) => (run.command ? [commandKey(run, index)] : []));
  return [...[...out].sort(), ...commands];
}
