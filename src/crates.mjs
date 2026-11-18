// The cargo workspace graph a `cargo: true` command run selects on: the
// members, their path-dependency edges and embedded files, the per-path crate
// mapping, the claim globs derived from the graph, and the argv shape the -p
// list builds. One `cargo metadata --no-deps` spawn replaces any TOML parsing
// -- a workspace where a member's Cargo.toml is valid TOML but not valid
// metadata JSON would parse differently than cargo does. A failed read
// degrades to whole-run selection, never a crash of the diff.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { repoRelative } from "./paths.mjs";

/** Exactly one metadata question per workspace read. */
const METADATA_ARGV = ["metadata", "--no-deps", "--format-version", "1"];
// The metadata payload is the whole workspace description; Node's 1 MiB
// default truncates a few hundred members into unparsable JSON.
const METADATA_MAX_BUFFER = 64 * 1024 * 1024;

/** Files at the workspace root whose change selects the run whole: the two
 *  manifests, and the toolchain / cargo config files that invalidate every
 *  build artifact. Member-level Cargo.toml files are crate files, not these. */
const WORKSPACE_FILES = new Set([
  "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain", ".cargo/config.toml",
]);

/** Windows drive paths are not posix-absolute but still outside a posix
 *  relative set kept this way. */
const posixAbsolute = (path) => posix.isAbsolute(path) || /^[A-Za-z]:/.test(path);

/** Resolve a Rust source literal against the directory it appears in; drop
 *  targets that escape the repository or are absolute. */
function resolveTarget(fromDir, literal) {
  const target = posix.normalize(posix.join(fromDir, String(literal).replace(/\\/g, "/")));
  if (target === ".." || target.startsWith("../") || posixAbsolute(target)) return null;
  return target;
}

const SOURCE_SKIPS = new Set(["node_modules", ".git", ".test-runner", "target"]);

function rsSources(absDir, relBase, out, _readdirSync) {
  let entries;
  try {
    entries = _readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SOURCE_SKIPS.has(entry.name)) rsSources(join(absDir, entry.name), rel, out, _readdirSync);
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      out.push(rel);
    }
  }
}

const INCLUDE_TARGET = /\binclude_(?:str|bytes)!\s*\(\s*"([^"\n]+)"/g;
// Only in build.rs: a single-string `join()`/`push()` is CARGO_MANIFEST_DIR-
// relative and resolvable. Anything string-concatenated is a known gap.
const BUILD_JOIN = /\.(?:join|push)\(\s*"([^"\n]+)"\s*\)/g;

const readSource = (repoRoot, rel, _readFileSync) => {
  try {
    return _readFileSync(join(repoRoot, rel), "utf8");
  } catch {
    return null;
  }
};

/** Literal `include_str!`/`include_bytes!` targets in `.rs` sources, resolved
 *  against the containing file's directory; `build.rs` additionally resolves
 *  single-string `join()`/`push()` literals against the crate's manifest dir
 *  (where CARGO_MANIFEST_DIR points). Paths built up at runtime are a known
 *  limitation: they contribute nothing rather than over-selecting. */
function collectIncludes(graph, repoRoot, _readdirSync, _readFileSync) {
  const includes = [];
  for (const member of graph.members) {
    if (posixAbsolute(member.dir)) continue; // an outside-repo member's targets resolve outside too
    const sources = [];
    rsSources(join(repoRoot, member.dir), member.dir, sources, _readdirSync);
    for (const rel of sources) {
      const text = readSource(repoRoot, rel, _readFileSync);
      if (typeof text !== "string") continue;
      const fromDir = posix.dirname(rel);
      for (const match of text.matchAll(INCLUDE_TARGET)) {
        const target = resolveTarget(fromDir, match[1]);
        if (target) includes.push([target, member.name]);
      }
      if (posix.basename(rel) === "build.rs") {
        for (const match of text.matchAll(BUILD_JOIN)) {
          const target = resolveTarget(member.dir, match[1]);
          if (target) includes.push([target, member.name]);
        }
      }
    }
  }
  return includes;
}

/** One `cargo metadata --no-deps` read for the workspace holding `cwdAbs`,
 *  turned into the graph the cargo selection shares. A failed read returns
 *  `{ ok: false, error }`; the run then degrades whole. */
export function readCargoGraph({
  cwdAbs,
  repoRoot,
  _spawnSync = spawnSync,
  _readFileSync = readFileSync,
  _readdirSync = readdirSync,
} = {}) {
  let raw;
  try {
    raw = _spawnSync("cargo", METADATA_ARGV, {
      cwd: cwdAbs,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: METADATA_MAX_BUFFER,
    });
  } catch (err) {
    return { ok: false, error: `spawn failed: ${err.message}` };
  }
  if (!raw || raw.error) return { ok: false, error: `spawn failed: ${raw?.error?.message ?? "no result"}` };
  if (raw.status !== 0) {
    const stderr = String(raw.stderr ?? "").trim();
    return { ok: false, error: `exit ${raw.status}${stderr ? `: ${stderr}` : ""}` };
  }
  let metadata;
  try {
    metadata = JSON.parse(String(raw.stdout ?? ""));
  } catch (err) {
    return { ok: false, error: `unparsable JSON: ${err.message}` };
  }
  if (!metadata || typeof metadata !== "object" || typeof metadata.workspace_root !== "string"
    || !Array.isArray(metadata.packages)) {
    return { ok: false, error: "unexpected metadata shape" };
  }
  const wr = repoRelative(repoRoot, metadata.workspace_root);
  if (wr === ".." || wr.startsWith("../") || posixAbsolute(wr)) {
    return { ok: false, error: `workspace root outside the repository: ${wr}` };
  }
  const toRel = (abs) => repoRelative(repoRoot, abs);
  const members = [];
  for (const pkg of metadata.packages) {
    if (!pkg || typeof pkg.name !== "string" || typeof pkg.manifest_path !== "string") continue;
    members.push({ name: pkg.name, dir: toRel(dirname(pkg.manifest_path)) });
  }
  const edges = [];
  for (const pkg of metadata.packages) {
    if (!pkg || typeof pkg.manifest_path !== "string") continue;
    const from = toRel(dirname(pkg.manifest_path));
    for (const dep of pkg.dependencies ?? []) {
      // A registry dep carries source, not path; path's presence is the only
      // proof of a path edge the metadata needs to offer. cargo's `path` is
      // already the dependency's directory, not its manifest.
      if (!dep || typeof dep.path !== "string") continue;
      edges.push([from, toRel(dep.path), dep.kind === "dev" ? "dev" : null]);
    }
  }
  const graph = { wr, rootMember: members.find((m) => m.dir === wr)?.name ?? null, members, edges, includes: [] };
  graph.includes = collectIncludes(graph, repoRoot, _readdirSync, _readFileSync);
  return { ok: true, graph };
}

const segmentMatch = (path, dir) => path === dir || path.startsWith(`${dir}/`);

const memberByName = (graph, name) => graph.members.find((m) => m.name === name) ?? null;

const memberByPath = (graph, path) =>
  graph.members.filter((m) => segmentMatch(path, m.dir)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;

/** Path-dependency target dirs no member occupies, longest first. */
function virtualDirs(graph) {
  return [...new Set(
    graph.edges
      .filter(([, to]) => !graph.members.some((m) => m.dir === to))
      .map(([, to]) => to),
  )].sort((a, b) => b.length - a.length);
}

/** Dependent-member names of a directory: the reverse transitive closure over
 *  the dir-level edges -- every edge kind counts -- with the directory's own
 *  member included. */
function dependentNames(graph, startDir) {
  const reverse = new Map();
  for (const [from, to] of graph.edges) {
    if (!reverse.has(to)) reverse.set(to, new Set());
    reverse.get(to).add(from);
  }
  const seen = new Set([startDir]);
  for (const dir of seen) {
    for (const from of reverse.get(dir) ?? []) seen.add(from);
  }
  return [...new Set(graph.members.filter((m) => seen.has(m.dir)).map((m) => m.name))].sort();
}

/** The crate names one changed repo-relative posix path selects: the base
 *  crate plus its dependents, or "whole" for the workspace's own manifests
 *  and compile-config files, or [] when nothing attributes it (the run then
 *  selects whole). Include targets union their readers in. */
export function cratesForPath(graph, path) {
  const rel = graph.wr === "" ? path
    : path === graph.wr ? ""
      : path.startsWith(`${graph.wr}/`) ? path.slice(graph.wr.length + 1)
        : null;
  if (rel !== null && WORKSPACE_FILES.has(rel)) return "whole";
  const readers = graph.includes.filter(([target]) => target === path).map(([, reader]) => reader);
  if (readers.length > 0) {
    const owner = memberByPath(graph, path);
    const names = new Set(owner ? dependentNames(graph, owner.dir) : []);
    for (const reader of readers) {
      const member = memberByName(graph, reader);
      if (member) for (const name of dependentNames(graph, member.dir)) names.add(name);
    }
    return [...names].sort();
  }
  for (const dir of virtualDirs(graph)) {
    if (segmentMatch(path, dir)) return dependentNames(graph, dir);
  }
  const owner = memberByPath(graph, path);
  if (owner) return dependentNames(graph, owner.dir);
  const root = graph.rootMember ? memberByName(graph, graph.rootMember) : null;
  return root ? dependentNames(graph, root.dir) : [];
}

/** The claim gate for a run that declares no `paths`: every member's
 *  directory, the workspace manifests and compile-config files, non-member
 *  path-dep dirs in the repository, and the parent dirs of include targets
 *  that sit outside every crate dir. A failed read never reaches here -- the
 *  degraded claim matches everything instead. */
export function deriveCargoGlobs(graph) {
  const prefix = graph.wr === "" ? "" : `${graph.wr}/`;
  const globs = [];
  for (const member of graph.members) {
    if (posixAbsolute(member.dir)) continue;
    // A root member's empty dir is dead as a glob (`./**` matches nothing);
    // the catch-all is the literal `**`, which does.
    globs.push(member.dir === graph.wr
      ? (graph.wr === "" ? "**" : `${graph.wr}/**`)
      : `${member.dir}/**`);
  }
  globs.push(
    `${prefix}Cargo.toml`,
    `${prefix}Cargo.lock`,
    `${prefix}rust-toolchain.toml`,
    `${prefix}rust-toolchain`,
    `${prefix}.cargo/config.toml`,
  );
  const virtuals = virtualDirs(graph);
  for (const dir of virtuals) {
    if (!posixAbsolute(dir)) globs.push(`${dir}/**`);
  }
  for (const [target] of graph.includes) {
    if (posixAbsolute(target) || memberByPath(graph, target)) continue;
    if (virtuals.some((dir) => segmentMatch(target, dir))) continue;
    const parent = posix.dirname(target);
    if (parent === "" || parent === ".") continue;
    globs.push(`${parent}/**`);
  }
  return [...new Set(globs)];
}

/** Splice the sorted `-p` list into a cargo command: the workspace selectors
 *  come out, the packages go in before the first `--` (so test binary args
 *  stay after it), and with no crates the argv is untouched -- whole mode
 *  keeps `--workspace`. */
export function withCrateArgs(argv, crates) {
  if (!crates || crates.length === 0) return argv;
  const stripped = argv.filter((arg) => arg !== "--workspace" && arg !== "--all");
  const dash = stripped.indexOf("--");
  const packages = [...new Set(crates)].sort().flatMap((name) => ["-p", name]);
  return dash === -1
    ? [...stripped, ...packages]
    : [...stripped.slice(0, dash), ...packages, ...stripped.slice(dash)];
}

/** The cargo selection state one `select()` call shares: the graph cache
 *  keyed by run.cwd (a failed read is cached too; a second degrade never
 *  re-spawns), the degrade records, and the crate names recorded per suite
 *  run so the entries loop can enumerate them even though a run's crate keys
 *  are not in its file set. `claim` gates and maps one changed path;
 *  `glob` is the caller's matcher (the repo has exactly one). */
export function cargoSelection({
  repoRoot,
  glob,
  _spawnSync,
  _readFileSync,
  _readdirSync,
} = {}) {
  const graphCache = new Map();
  const crateKeys = new Map();
  const degraded = [];
  const seenDegrades = new Set();
  const recordDegrade = (suite, runIndex, error) => {
    const key = `${suite}\0${runIndex}`;
    if (seenDegrades.has(key)) return;
    seenDegrades.add(key);
    degraded.push({ suite, runIndex, error });
  };
  return {
    claim(run, suite, runIndex) {
      const gates = new Map();
      const graphOf = () => {
        if (!graphCache.has(run.cwd)) {
          graphCache.set(run.cwd, readCargoGraph({
            cwdAbs: join(repoRoot, run.cwd), repoRoot, _spawnSync, _readFileSync, _readdirSync,
          }));
        }
        return graphCache.get(run.cwd);
      };
      return {
        matches(path) {
          // The derived gate serves pathless runs only: a declared `paths`
          // matcher gates in select's per-path loop and never builds the graph.
          const read = graphOf();
          if (!read.ok) return true; // degrade: a failed graph cannot gate
          if (!gates.has(run.cwd)) gates.set(run.cwd, glob(deriveCargoGlobs(read.graph)));
          return gates.get(run.cwd)(path);
        },
        map(path) {
          const read = graphOf();
          if (!read.ok) {
            recordDegrade(suite, runIndex, read.error);
            return "whole";
          }
          return cratesForPath(read.graph, path);
        },
      };
    },
    record(suite, index, name) {
      const key = `${suite}\0${index}`;
      if (!crateKeys.has(key)) crateKeys.set(key, []);
      const names = crateKeys.get(key);
      if (!names.includes(name)) names.push(name);
    },
    names(suite, index) {
      return crateKeys.get(`${suite}\0${index}`) ?? null;
    },
    records: degraded,
  };
}
