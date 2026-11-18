// The consumer's config: `test-runner.config.mjs` at the repository root,
// default-exporting a plain object. Every suite, path, base branch and distro
// the runner uses comes from here -- the package carries no consumer's names.

import { existsSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_NAME = "test-runner.config.mjs";

/** Base-ref candidates for a diff run, tried in order. */
export const DEFAULT_BASE = ["origin/main", "main", "origin/master", "master"];

/** A change to one of these inside a package runs that package's suites whole:
 *  the import graph cannot see what a manifest or lockfile changes. */
export const DEFAULT_FALLBACK = ["**/package.json", "**/package-lock.json"];

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** A test row's time turns yellow here, and the slowest-tests list lists it: one
 *  meaning of "slow", and this is its only home. */
export const DEFAULT_SLOW_MS = 300;

/** The config could not be found, loaded or validated. Exit 2. */
export class ConfigError extends Error {}

const TOP_KEYS = ["suites", "base", "selectAll", "repoSuite", "packages", "fallback", "skipDirs", "notRun", "wsl", "slowMs"];
const SUITE_KEYS = ["name", "runs", "select"];
/** How a suite's globs runs are selected: the import graph, or declared
 *  `paths` only. The field sits on the suite because entries are keyed by
 *  suite and file, so a run-scoped switch cannot be expressed. */
export const SELECT_MODES = ["graph", "paths"];
const RUN_KEYS = ["label", "cwd", "globs", "command", "cargo", "exclude", "env", "envFile", "install", "timeoutMs", "platform", "paths", "format", "fastSkip", "runner"];
const WSL_KEYS = ["distro", "setup", "keep", "path", "requires"];
export const PLATFORMS = ["any", "windows", "linux"];

/** The built-in command-run output formats; anything else is a shim path. */
export const BUILTIN_FORMATS = ["tap", "libtest", "junit"];

const GLOB_RUN = '{ globs: ["tests/*.test.mjs"], timeoutMs: 600000 }';
const RUNNER_RUN = '{ globs: ["tests/**/test_*.py"], runner: ["python", "-m", "pytest"] }';
const COMMAND_RUN = '{ command: ["cargo", "test"], cargo: true, format: "libtest", platform: "linux" }';
const JUNIT_RUN = '{ command: ["pytest", "--junitxml={report}"], format: "junit", platform: "windows" }';
const SHIM_RUN = '{ command: ["go", "test", "./..."], format: "scripts/parse-go.mjs" }';
const FORMAT_EXAMPLE = `${COMMAND_RUN} or ${SHIM_RUN}`;

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
  // Changed paths are posix; a backslash cwd would never match one.
  if (cwd.includes("\\")) {
    throw invalid(field, "contains a backslash", 'Use forward slashes, e.g. "packages/api"');
  }
}

/** A command run's `format`: one of the built-ins, or a repository-relative
 *  `.mjs` shim path -- no backslash, no `..`, inside the repository. */
function isFormat(value) {
  if (typeof value !== "string") return false;
  if (BUILTIN_FORMATS.includes(value)) return true;
  return value.endsWith(".mjs") && !isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && !value.includes("\\") && !value.split("/").includes("..") && value !== ".mjs";
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
  checkStrings(run.runner, `${field}.runner`, RUNNER_RUN, { nonEmpty: true });
  for (const key of ["exclude", "envFile", "runner"]) {
    if (hasCommand && run[key] !== undefined) {
      throw invalid(`${field}.${key}`, "applies only to a globs run", `Remove "${key}" from this command run`);
    }
  }
  if (run.runner !== undefined && run.envFile !== undefined) {
    throw invalid(`${field}.runner`, "is set alongside envFile",
      'envFile is node\'s --env-file; put the variables in "env" instead', RUNNER_RUN);
  }
  if (run.format !== undefined) {
    if (hasGlobs) {
      throw invalid(`${field}.format`, "applies only to a command run", 'Remove "format": a globs run reports whatever node --test prints', COMMAND_RUN);
    }
    if (!isFormat(run.format)) {
      throw invalid(`${field}.format`, `is ${JSON.stringify(run.format)}`,
        "Use one of: tap, libtest, junit -- or a file relative to the repository root ending .mjs (no .., forward slashes) whose default export parses the output",
        FORMAT_EXAMPLE);
    }
  }
  if (run.fastSkip !== undefined) {
    if (hasGlobs) {
      throw invalid(`${field}.fastSkip`, "applies only to a command run", 'Remove "fastSkip": a globs run drops files through --fast itself', COMMAND_RUN);
    }
    if (typeof run.fastSkip !== "boolean") {
      throw invalid(`${field}.fastSkip`, `is ${JSON.stringify(run.fastSkip)}`,
        "default off; true opts this run into --fast skip args", COMMAND_RUN);
    }
  }
  if (run.cargo !== undefined) {
    if (hasGlobs) {
      throw invalid(`${field}.cargo`, "applies only to a command run", 'Remove "cargo": a globs run selects per-file through the import graph itself', COMMAND_RUN);
    }
    if (typeof run.cargo !== "boolean") {
      throw invalid(`${field}.cargo`, `is ${JSON.stringify(run.cargo)}`,
        "must be true or false; true selects the -p list per changed crate through `cargo metadata`", COMMAND_RUN);
    }
  }
  if (hasCommand && (run.command ?? []).some((arg) => arg.includes("{report}"))) {
    if (run.format === undefined) {
      throw invalid(`${field}.command`, "names {report} but the run declares no format",
        "Add format: junit or a .mjs shim that reads the report, or keep the report path in the argv yourself", JUNIT_RUN);
    }
    if (BUILTIN_FORMATS.includes(run.format) && run.format !== "junit") {
      throw invalid(`${field}.command`, "names {report}",
        `{report} applies only to a junit or shim run; ${JSON.stringify(run.format)} parses stdout`, JUNIT_RUN);
    }
  }
  checkStrings(run.exclude, `${field}.exclude`, '["fixtures"]');
  // `paths` is how both kinds declare what selects them: an example the author
  // can paste into a run of their own kind.
  checkStrings(run.paths, `${field}.paths`, hasCommand ? COMMAND_RUN : GLOB_RUN, { nonEmpty: true });
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
    if (posix.normalize(`./${run.cwd ?? "."}/`) === "./") {
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
  checkSelect(suite, field);
}

/** `select: "paths"` switches the import graph off, so it needs something to
 *  select by: at least one globs run, and a non-empty `paths` on every one. */
function checkSelect(suite, field) {
  if (suite.select === undefined) return;
  const example = `{ name: "unit", select: "paths", runs: [{ globs: ["tests/*.test.mjs"], paths: ["src/**"] }] }`;
  if (!SELECT_MODES.includes(suite.select)) {
    throw invalid(`${field}.select`, `is ${JSON.stringify(suite.select)}`,
      `Use one of: ${SELECT_MODES.join(", ")}`, example);
  }
  if (suite.select !== "paths") return;
  if (!suite.runs.some((run) => run.globs)) {
    throw invalid(`${field}.select`, 'is "paths" but the suite has no globs run',
      'Remove "select": it applies only to globs runs, and a command run is already selected by its own paths', example);
  }
  suite.runs.forEach((run, i) => {
    if (run.globs && (run.paths === undefined || run.paths.length === 0)) {
      throw invalid(`${field}.runs[${i}].paths`, 'is missing in a suite with select: "paths"',
        'Give every globs run the globs whose changes select it whole, or set select: "graph"', example);
    }
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
  const examples = { selectAll: '[".github/workflows/**"]', packages: '["packages/*"]', fallback: '["**/package.json"]', skipDirs: '["fixtures-big"]' };
  for (const [key, keyExample] of Object.entries(examples)) checkStrings(raw[key], key, keyExample);
  if (raw.slowMs !== undefined && !(Number.isInteger(raw.slowMs) && raw.slowMs > 0)) {
    throw invalid("slowMs", "must be a positive whole number of milliseconds", 'Write the threshold a test row turns yellow at', "slowMs: 300");
  }
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
    slowMs: raw.slowMs ?? DEFAULT_SLOW_MS,
    wsl,
    configPath,
    suites: (raw.suites ?? []).map((suite) => ({
      ...suite,
      select: suite.select ?? "graph",
      runs: suite.runs.map((run) => ({
        ...run,
        cwd: run.cwd ?? ".",
        timeoutMs: run.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        platform: run.platform ?? "any",
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
