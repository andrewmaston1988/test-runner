// The consumer's config: `test-runner.config.mjs` at the repository root,
// default-exporting a plain object. Every suite, path, base branch and distro
// the runner uses comes from here -- the package carries no consumer's names.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_NAME = "test-runner.config.mjs";

/** Base-ref candidates for a diff run, tried in order. */
export const DEFAULT_BASE = ["origin/main", "main", "origin/master", "master"];

/** A change to one of these inside a package runs that package's suites whole:
 *  the import graph cannot see what a manifest or lockfile changes. */
export const DEFAULT_FALLBACK = ["**/package.json", "**/package-lock.json"];

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The config could not be found, loaded or validated. Exit 2. */
export class ConfigError extends Error {}

const TOP_KEYS = ["suites", "base", "selectAll", "repoSuite", "packages", "fallback", "skipDirs", "notRun", "wsl"];
const SUITE_KEYS = ["name", "runs"];
const RUN_KEYS = ["label", "cwd", "globs", "command", "exclude", "env", "envFile", "install", "timeoutMs", "platform", "paths"];
const WSL_KEYS = ["distro", "setup", "keep", "path", "requires"];
export const PLATFORMS = ["any", "windows", "linux"];

const GLOB_RUN = '{ globs: ["tests/*.test.mjs"], timeoutMs: 600000 }';
const COMMAND_RUN = '{ command: ["cargo", "test"], paths: ["crates/**"], platform: "linux" }';

/** Every validation error names the field, what is wrong, the fix, and a
 *  correct example -- one round trip should reach a valid config. */
function invalid(field, problem, fix, example = null) {
  return new ConfigError(`${field}: ${problem}. ${fix}${example ? `\n  example: ${example}` : ""}`);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");

function checkKeys(value, allowed, field, example) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalid(`${field}.${key}`, "is not a known field", `Use one of: ${allowed.join(", ")}`, example);
    }
  }
}

function checkStrings(value, field, example, { nonEmpty = false } = {}) {
  if (value === undefined) return;
  if (!isStringArray(value) || (nonEmpty && value.length === 0)) {
    throw invalid(field, "must be an array of non-empty strings", `Give ${nonEmpty ? "at least one string" : "strings"}`, example);
  }
}

/** A run's `cwd`: relative, inside the repository. */
function checkCwd(cwd, field) {
  if (cwd === undefined) return;
  const bad = typeof cwd !== "string" || isAbsolute(cwd) || /^[A-Za-z]:/.test(cwd)
    || cwd.split(/[\\/]/).includes("..");
  if (bad) {
    throw invalid(field, "must be a path relative to the repository root, without ..", 'Write it from the root, e.g. "." or "packages/api"');
  }
}

function checkRun(run, field) {
  if (!isObject(run)) throw invalid(field, "must be an object", "Write the run as an object", GLOB_RUN);
  checkKeys(run, RUN_KEYS, field, GLOB_RUN);
  const hasGlobs = run.globs !== undefined;
  const hasCommand = run.command !== undefined;
  if (hasGlobs === hasCommand) {
    const problem = hasGlobs ? 'has both "globs" and "command"' : 'has neither "globs" nor "command"';
    throw invalid(field, problem, 'Give exactly one: "globs" runs node --test over files, "command" runs an argv', `${GLOB_RUN} or ${COMMAND_RUN}`);
  }
  if (hasGlobs) checkStrings(run.globs, `${field}.globs`, GLOB_RUN, { nonEmpty: true });
  if (hasCommand) checkStrings(run.command, `${field}.command`, COMMAND_RUN, { nonEmpty: true });
  for (const key of ["exclude", "envFile"]) {
    if (hasCommand && run[key] !== undefined) {
      throw invalid(`${field}.${key}`, "applies only to a globs run", `Remove "${key}" from this command run`);
    }
  }
  if (hasGlobs && run.paths !== undefined) {
    throw invalid(`${field}.paths`, "applies only to a command run", 'Remove "paths": a globs run is selected through the import graph');
  }
  checkStrings(run.exclude, `${field}.exclude`, '["fixtures"]');
  checkStrings(run.paths, `${field}.paths`, COMMAND_RUN);
  checkCwd(run.cwd, `${field}.cwd`);
  if (run.label !== undefined && (typeof run.label !== "string" || !/^[A-Za-z0-9._-]+$/.test(run.label))) {
    throw invalid(`${field}.label`, "must be letters, digits, dot, dash or underscore", 'Name it like "core"');
  }
  if (run.envFile !== undefined && (typeof run.envFile !== "string" || run.envFile === "")) {
    throw invalid(`${field}.envFile`, "must be a path string", 'Write it relative to the run\'s cwd, e.g. ".env.test"');
  }
  if (run.env !== undefined && !(isObject(run.env) && Object.values(run.env).every((v) => typeof v === "string"))) {
    throw invalid(`${field}.env`, "must be an object of string values", 'Quote every value, e.g. { CI: "1" }');
  }
  if (run.timeoutMs !== undefined && !(Number.isInteger(run.timeoutMs) && run.timeoutMs > 0)) {
    throw invalid(`${field}.timeoutMs`, "must be a positive whole number of milliseconds", "e.g. 600000 for ten minutes");
  }
  if (run.platform !== undefined && !PLATFORMS.includes(run.platform)) {
    throw invalid(`${field}.platform`, `is ${JSON.stringify(run.platform)}`, `Use one of: ${PLATFORMS.join(", ")}`, COMMAND_RUN);
  }
  if (run.install !== undefined) {
    checkStrings(run.install, `${field}.install`, '["npm", "ci"]', { nonEmpty: true });
    // The runner itself came from the root's install; reinstalling there
    // would replace the code that is running.
    const cwd = run.cwd === undefined ? "." : run.cwd.replace(/[\\/]+$/, "");
    if (cwd === "." || cwd === "" || cwd === "./") {
      throw invalid(`${field}.install`, "cannot install at the repository root", "Install the root yourself before running the tests; install applies to a subdirectory cwd, e.g. { cwd: \"packages/api\", install: [\"npm\", \"ci\"] }");
    }
  }
}

function checkSuite(suite, field, names) {
  const example = `{ name: "unit", runs: [${GLOB_RUN}] }`;
  if (!isObject(suite)) throw invalid(field, "must be an object", "Write the suite as an object", example);
  checkKeys(suite, SUITE_KEYS, field, example);
  if (typeof suite.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suite.name)) {
    throw invalid(`${field}.name`, "must be a name of letters, digits, dot, dash or underscore", 'Name it like "unit"', example);
  }
  if (names.has(suite.name)) throw invalid(`${field}.name`, `"${suite.name}" is used twice`, "Give every suite its own name");
  names.add(suite.name);
  if (!Array.isArray(suite.runs) || suite.runs.length === 0) {
    throw invalid(`${field}.runs`, "must be a non-empty array of runs", "Give the suite at least one run", example);
  }
  const labels = new Set();
  suite.runs.forEach((run, i) => {
    checkRun(run, `${field}.runs[${i}]`);
    // The label names the run's log and timings, so two equal labels would
    // overwrite each other's record.
    const label = run.label ?? "";
    if (labels.has(label)) {
      throw invalid(`${field}.runs[${i}].label`, `${label ? `"${label}"` : "no label"} is shared with another run`, "Give each run of a suite its own label");
    }
    labels.add(label);
  });
}

function checkWsl(wsl) {
  const example = '{ distro: "ubuntu", path: ["~/.cargo/bin"], requires: ["cargo", "node", "rsync"] }';
  if (!isObject(wsl)) throw invalid("wsl", "must be an object", "Name the distro", example);
  checkKeys(wsl, WSL_KEYS, "wsl", example);
  if (typeof wsl.distro !== "string" || wsl.distro === "") {
    throw invalid("wsl.distro", "is missing", "Name the WSL distro the mirror runs in, as `wsl.exe -l -q` lists it", example);
  }
  if (wsl.setup !== undefined && typeof wsl.setup !== "string") {
    throw invalid("wsl.setup", "must be a string", "Write where the distro's setup is documented");
  }
  for (const key of ["keep", "path", "requires"]) checkStrings(wsl[key], `wsl.${key}`, example);
}

/** Throws a ConfigError naming the first problem; returns nothing when `raw`
 *  is valid. Unknown fields are errors, so a typo never silently does nothing. */
export function validateConfig(raw) {
  const example = `export default { suites: [{ name: "unit", runs: [${GLOB_RUN}] }] };`;
  if (!isObject(raw)) throw invalid("config", "must be an object", "Default-export a plain object", example);
  checkKeys(raw, TOP_KEYS, "config", example);
  if (!Array.isArray(raw.suites)) throw invalid("suites", "is missing", "List the suites", example);
  const names = new Set();
  raw.suites.forEach((suite, i) => checkSuite(suite, `suites[${i}]`, names));
  checkStrings(raw.base, "base", '["origin/main", "main"]', { nonEmpty: true });
  for (const key of ["selectAll", "packages", "fallback", "skipDirs"]) checkStrings(raw[key], key, '["scripts/**"]');
  if (raw.repoSuite !== undefined && !(typeof raw.repoSuite === "string" && names.has(raw.repoSuite))) {
    throw invalid("repoSuite", `${JSON.stringify(raw.repoSuite)} names no suite`, `Use one of: ${[...names].join(", ") || "(no suites)"}`);
  }
  if (raw.notRun !== undefined) {
    const ok = Array.isArray(raw.notRun)
      && raw.notRun.every((entry) => isObject(entry) && typeof entry.path === "string" && typeof entry.reason === "string");
    if (!ok) {
      throw invalid("notRun", "must be an array of { path, reason }", "Record why each test is deliberately not run", '[{ path: "tests/manual.test.mjs", reason: "needs a device" }]');
    }
  }
  if (raw.wsl !== undefined) checkWsl(raw.wsl);
}

/** `raw` with every optional field defaulted. Validation is `validateConfig`'s
 *  job; this only fills gaps, so it never throws on a well-formed object. */
export function normalizeConfig(raw, { configPath = CONFIG_NAME } = {}) {
  const wsl = raw.wsl
    ? {
      distro: raw.wsl.distro,
      setup: raw.wsl.setup ?? "",
      keep: raw.wsl.keep ?? [],
      path: raw.wsl.path ?? [],
      requires: raw.wsl.requires ?? [],
    }
    : null;
  return {
    base: raw.base ?? DEFAULT_BASE,
    selectAll: raw.selectAll ?? [],
    repoSuite: raw.repoSuite ?? null,
    packages: raw.packages ?? [],
    fallback: raw.fallback ?? DEFAULT_FALLBACK,
    skipDirs: raw.skipDirs ?? [],
    notRun: raw.notRun ?? [],
    wsl,
    configPath,
    suites: (raw.suites ?? []).map((suite) => ({
      ...suite,
      runs: suite.runs.map((run) => ({
        cwd: ".",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        platform: "any",
        ...run,
      })),
    })),
  };
}

/** The config file's repo-relative posix path: `--config` wins, else the root
 *  file. A path outside the repository is refused -- the always-select-all rule
 *  for the config file needs it to be a path a diff can name. */
export function configPathFor({ repoRoot, override = null }) {
  if (!override) return CONFIG_NAME;
  const abs = isAbsolute(override) ? override : join(repoRoot, override);
  const rel = relative(repoRoot, abs).split("\\").join("/");
  if (rel === "" || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    throw new ConfigError(`--config ${override} is outside the repository at ${repoRoot}`);
  }
  return rel;
}

/** Import the config file and return its default export. A missing file names
 *  the location and the fix; a file that throws on import names the error. */
export async function loadConfigFile({
  repoRoot,
  configPath,
  _exists = existsSync,
  _import = (url) => import(url),
}) {
  const abs = join(repoRoot, configPath);
  if (!_exists(abs)) {
    throw new ConfigError(
      `no config at ${configPath}. Create it at the repository root, for example:\n\n`
      + "  export default {\n"
      + "    suites: [\n"
      + '      { name: "unit", runs: [{ globs: ["tests/*.test.mjs"] }] },\n'
      + "    ],\n"
      + "  };\n",
    );
  }
  let mod;
  try {
    mod = await _import(pathToFileURL(abs).href);
  } catch (err) {
    throw new ConfigError(`${configPath} failed to load: ${err && err.message ? err.message : err}`);
  }
  if (!mod || mod.default === undefined) {
    throw new ConfigError(`${configPath} has no default export. Write \`export default { suites: [...] };\``);
  }
  return mod.default;
}
