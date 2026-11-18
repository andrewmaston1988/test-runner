// The command line: flags, the config, selection, and the exit code. Flags are
// in USAGE below; the exit code is 0 on every selected run passing, 1 when any
// fails, and 2 for a usage or config error, which prints without running.

import { spawn, spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ChangedSetError, changedSet, resolveBase } from "./changed.mjs";
import { CODES, paint, resolveColour } from "./colour.mjs";
import { installIfNeeded, killTree } from "./execute.mjs";
import { MIRROR_PACKAGE } from "./graph.mjs";
import { BUILTIN_FORMATS, CONFIG_NAME, ConfigError, configPathFor, loadConfigFile, normalizeConfig, validateConfig } from "./config.mjs";
import { orphanTests } from "./orphans.mjs";
import { resolveMode } from "./reporter.mjs";
import { countLine, hostPlatform, labelOf, needsBase, runSuites, summaryLine } from "./run.mjs";
import { select, wholeEntries } from "./select.mjs";

const USAGE = `usage: test-runner [--all] [--suite <name>] [--against <ref>] [--list] [--wsl]
       [--reporter=agent|default] [--fast] [--slow-ms <n>] [--if-selected] [--orphans]
       [--config <path>] [--platform windows]`;

function usage(message, _err) {
  _err(`[test] ${message}`);
  _err(USAGE);
  return 2;
}

/** This package's root: what `--wsl` copies into the mirror. */
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/** How many wide-run paths the default notice names before pointing at
 *  `--list`, which prints them all. */
const WIDE_LIMIT = 10;

/** `--name value` or `--name=value`; null when the value is missing. */
function valueOf(argv, i, name) {
  const arg = argv[i];
  if (arg === name) return { value: argv[i + 1] ?? null, next: i + 1 };
  return { value: arg.slice(name.length + 1) || null, next: i };
}

function parseArgs(argv) {
  const opts = {
    suiteName: null, all: false, listOnly: false, wsl: false, against: null,
    fast: false, ifSelected: false, orphansOnly: false, reporter: null, config: null, platform: null,
    slowMs: null, mirror: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--list") opts.listOnly = true;
    else if (arg === "--wsl") opts.wsl = true;
    else if (arg === "--fast") opts.fast = true;
    else if (arg === "--if-selected") opts.ifSelected = true;
    else if (arg === "--orphans") opts.orphansOnly = true;
    else if (arg === "--mirror") opts.mirror = true; // set by --wsl for the run inside the mirror
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--suite" || arg.startsWith("--suite=")) {
      const { value, next } = valueOf(argv, i, "--suite");
      if (!value) return { error: "--suite needs a suite name" };
      opts.suiteName = value;
      i = next;
    } else if (arg === "--against" || arg.startsWith("--against=")) {
      const { value, next } = valueOf(argv, i, "--against");
      if (!value) return { error: "--against needs a ref" };
      opts.against = value;
      i = next;
    } else if (arg === "--config" || arg.startsWith("--config=")) {
      const { value, next } = valueOf(argv, i, "--config");
      if (!value) return { error: "--config needs a path" };
      opts.config = value;
      i = next;
    } else if (arg === "--platform" || arg.startsWith("--platform=")) {
      const { value, next } = valueOf(argv, i, "--platform");
      if (value !== "windows") return { error: `--platform takes windows, not ${value ?? "nothing"}` };
      opts.platform = value;
      i = next;
    } else if (arg === "--slow-ms" || arg.startsWith("--slow-ms=")) {
      const { value, next } = valueOf(argv, i, "--slow-ms");
      const ms = Number(value);
      if (value === null || !/^\d+$/.test(value) || ms <= 0) {
        return { error: `--slow-ms needs a positive whole number of milliseconds, not ${value ?? "nothing"}` };
      }
      opts.slowMs = ms;
      i = next;
    } else if (arg === "--reporter" || arg.startsWith("--reporter=")) {
      const { value, next } = valueOf(argv, i, "--reporter");
      if (value !== "agent" && value !== "default") {
        return { error: `--reporter must be agent or default, not ${value ?? "nothing"}` };
      }
      opts.reporter = value;
      i = next;
    } else {
      return { error: `unknown argument ${arg}` };
    }
  }
  if (opts.all && opts.suiteName) return { error: "--suite and --all are exclusive" };
  if (opts.ifSelected && !opts.suiteName) return { error: "--if-selected needs --suite" };
  if (opts.wsl) {
    // WSL mode runs the whole regression by design; a selection flag alongside
    // it would be read as narrowing that run, so refuse rather than ignore it.
    const flags = [
      ["--list", opts.listOnly],
      ["--suite", Boolean(opts.suiteName)],
      ["--against", Boolean(opts.against)],
      ["--all", opts.all],
      ["--fast", opts.fast],
      ["--reporter", Boolean(opts.reporter)],
      ["--orphans", opts.orphansOnly],
      ["--platform", Boolean(opts.platform)],
    ];
    const conflict = flags.find(([, given]) => given);
    if (conflict) return { error: `--wsl cannot be combined with ${conflict[0]}` };
  }
  return { opts };
}

const dynamicImport = (specifier) => import(specifier);

/** A run's `.mjs` shim, imported once at config load: a missing, throwing or
 *  non-function-default module exits 2 here, before anything spawns. The
 *  loaded function is what `runSuites` hands `runCommand`. */
async function loadShim({ repoRoot, format, _import }) {
  let mod;
  try {
    mod = await _import(pathToFileURL(resolve(repoRoot, format)).href);
  } catch (err) {
    throw new ConfigError(`format ${JSON.stringify(format)}: the shim failed to load -- ${err.message}\n`
      + "  fix: repair the module, or point format at one of: tap, libtest, junit\n"
      + `  example: format: "shims/parse-go.mjs"`);
  }
  const parse = mod?.default;
  if (typeof parse !== "function") {
    throw new ConfigError(`format ${JSON.stringify(format)}: its default export is not a function\n`
      + "  fix: export default the parse function\n"
      + '  example: export default function parse({ stdout, stderr, exitCode, report }) { return { events: [] }; }');
  }
  return parse;
}

/** The config: injected (tests), or loaded from the repository. Each shim a
 *  run names imports here, so a bad module exits before anything runs. */
async function readConfig({ repoRoot, override, _config, _fs, _import = dynamicImport }) {
  const configPath = configPathFor({ repoRoot, override });
  const raw = _config ?? await loadConfigFile({ repoRoot, configPath, _exists: _fs.existsSync });
  try {
    validateConfig(raw);
  } catch (err) {
    if (err instanceof ConfigError) err.message = `${configPath}: ${err.message}`;
    throw err;
  }
  const config = normalizeConfig(raw, { configPath });
  const shims = {};
  for (const suite of config.suites) {
    for (const run of suite.runs) {
      if (run.format === undefined || BUILTIN_FORMATS.includes(run.format)) continue;
      if (shims[run.format] !== undefined) continue;
      shims[run.format] = await loadShim({ repoRoot, format: run.format, _import });
    }
  }
  return { config, shims };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const {
    cwd = process.cwd(),
    _spawn = spawn,
    _spawnSync = spawnSync,
    _platform = process.platform,
    _killTree = killTree,
    _fs = nodeFs,
    _now = Date.now,
    _config = undefined,
    _import,
    _env = process.env,
    stream = process.stdout,
    _log = (line) => process.stdout.write(`${line}\n`),
    _err = (line) => process.stderr.write(`${line}\n`),
    _writeOut = (text) => process.stdout.write(text),
    _writeErr = (text) => process.stderr.write(text),
  } = options;

  const parsed = parseArgs(argv);
  if (parsed.error) return usage(parsed.error, _err);
  const { opts } = parsed;
  if (opts.help) {
    _log(USAGE);
    return 0;
  }
  // The mirror runs this package from its own copy; anywhere else the flag's
  // npm ci would reinstall the host's dependencies, this package included.
  if (opts.mirror && basename(PACKAGE_DIR) !== MIRROR_PACKAGE) {
    return usage("--mirror is internal to --wsl, which passes it to the runner inside the mirror", _err);
  }
  // The Windows half of a Windows consumer's gate; on any other host it would
  // run nothing and report green.
  if (opts.platform === "windows" && hostPlatform(_platform) !== "windows") {
    return usage(`--platform windows runs only on a Windows host, not ${_platform}`, _err);
  }

  let repoRoot;
  try {
    const r = _spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    if (!r || r.error || r.status !== 0) throw new Error((r && r.stderr) || "not a git repository");
    repoRoot = r.stdout.trim();
  } catch (err) {
    return usage(`cannot read the repository root: ${err.message}`, _err);
  }

  let config;
  let shims;
  try {
    ({ config, shims } = await readConfig({ repoRoot, override: opts.config, _config, _fs, _import }));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    _err(`[test] ${err.message}`);
    return 2;
  }
  const suites = config.suites;
  const slowMs = opts.slowMs ?? config.slowMs;
  // Colour is decided once here and travels to the reporter child in
  // TEST_COLOUR: a child spawned into a pipe (or a WSL mirror) cannot decide it
  // for itself. The mirror's own run inherits the decision instead of repeating
  // it, because wsl.exe does not forward the TTY or the agent variables.
  const inherited = _env.TEST_COLOUR === "1" || _env.TEST_COLOUR === "0" ? _env.TEST_COLOUR === "1" : null;
  const mode = resolveMode(_env);
  // Agent mode comes from the flag or the environment, and the colour decision
  // takes it as its mode: a `--reporter=agent` run never colours unless the
  // user set FORCE_COLOR. Agent mode also decides whether command-run stderr
  // is teed or held.
  const agent = (opts.reporter ?? mode) === "agent";
  const colour = inherited ?? resolveColour({ env: _env, stream, mode: agent ? "agent" : mode });

  if (opts.wsl) {
    if (!config.wsl) return usage("--wsl needs a `wsl` block in the config naming the distro", _err);
    const { runWsl } = await import("./wsl.mjs");
    const configArgs = config.configPath === CONFIG_NAME ? [] : ["--config", config.configPath];
    return await runWsl({
      repoRoot,
      packageDir: PACKAGE_DIR,
      runnerArgs: ["--all", "--mirror", ...configArgs, ...(opts.slowMs === null ? [] : ["--slow-ms", String(opts.slowMs)])],
      wsl: config.wsl,
      colour,
      _spawnSync,
      _fs,
      log: (line) => _log(line),
      err: (text) => _err(text.replace(/\n$/, "")),
    });
  }

  if (opts.mirror) {
    // The rsync never carries node_modules, so the mirror installs its own
    // Linux dependencies once per lockfile. The runner itself came from the
    // host's copy, so this install cannot replace the code that is running.
    const installed = installIfNeeded({ cwd: repoRoot, install: ["npm", "ci"], _fs, _spawnSync, _platform });
    if (installed.error) {
      _err(`[test] mirror: ${installed.error}`);
      return 2;
    }
    if (installed.installed) _log("[test] mirror: installed (lockfile changed)");
  }

  const orphanOptions = { repoRoot, notRun: config.notRun, skipDirs: config.skipDirs };
  if (opts.orphansOnly) {
    const found = orphanTests(suites, orphanOptions);
    for (const file of found) _log(file);
    return found.length === 0 ? 0 : 1;
  }

  const orphans = orphanTests(suites, orphanOptions);
  if (orphans.length > 0) {
    _err(`[test] orphan test file(s) no suite runs: ${orphans.join(", ")}`);
  }

  let chosen;
  if (opts.suiteName) {
    const suite = suites.find((s) => s.name === opts.suiteName);
    if (!suite) return usage(`unknown suite ${opts.suiteName} (known: ${suites.map((s) => s.name).join(", ")})`, _err);
    chosen = [suite];
  } else chosen = suites;

  let entries;
  let selected = null;
  let base = null;
  let whole = Boolean(opts.all || opts.suiteName) && !opts.ifSelected;
  if (whole) {
    entries = wholeEntries(chosen, { repoRoot, config });
  } else {
    let changed;
    try {
      base = resolveBase({ repoRoot, against: opts.against, candidates: config.base, _spawnSync });
      changed = changedSet({ repoRoot, base, _spawnSync });
    } catch (err) {
      if (!(err instanceof ChangedSetError)) throw err;
      return usage(err.message, _err);
    }
    const result = select({ suites: chosen, changed, repoRoot, config, _spawnSync });
    entries = result.entries;
    if (opts.ifSelected) {
      // A `windows` entry is added to every diff, so it is not evidence that
      // this diff touches the suite. CI then runs the suite whole: the import
      // graph chooses which suites, never which files.
      const touched = entries.filter((entry) => entry.why !== "windows");
      const suiteFiles = wholeEntries(chosen, { repoRoot, config });
      if (touched.length > 0) {
        entries = suiteFiles;
      } else if (suiteFiles.length > 0) {
        _log(`[test] ${opts.suiteName}: not selected by this diff`);
        return 0;
      } else {
        // The suite's globs match nothing, so "unselected" would be a permanent
        // green. Leave the expansion empty and let the no-files failure report it.
        entries = [];
        whole = true;
      }
    } else {
      if (result.docsOnly) {
        _err(`[test] docs-only: ${changed.length} changed file(s) select no test; nothing to run for them`);
      }
      if (result.unowned.length > 0) {
        _err(`[test] unowned: ${result.unowned.length} changed file(s) no suite owns: ${result.unowned.join(", ")}`);
      }
      for (const { suite, runIndex, error } of result.degraded) {
        // Unknown suite/run is impossible here: select saw chosen.
        const owner = chosen.find((entry) => entry.name === suite);
        _err(`[test] ${labelOf(owner, owner.runs[runIndex])}: cargo metadata failed (${error}); selecting the run whole`);
      }
      // A wide run costs wall-clock for a reason the user cannot see, so it is
      // announced even without --list. `--list` prints them all: the entries
      // cannot show them, because a suite's files keep only the first reason.
      const shown = opts.listOnly ? result.wide : result.wide.slice(0, WIDE_LIMIT);
      for (const { path, suites } of shown) {
        _err(paint(colour, CODES.yellow,
          `[test] wide run: the blast radius of '${path}' could not be determined, so ${suites.join(", ")} run whole`));
      }
      if (!opts.listOnly && result.wide.length > WIDE_LIMIT) {
        _err(paint(colour, CODES.yellow,
          `[test] wide run: and ${result.wide.length - WIDE_LIMIT} more (see --list)`));
      }
      selected = new Set(entries.map((entry) => `${entry.suite}\0${entry.file}`));
    }
  }

  if (opts.listOnly) {
    for (const entry of entries) _log(`${entry.suite} ${entry.file} ${entry.why}`);
    return 0;
  }
  // An empty diff selection is a pass. An empty whole-suite expansion is not:
  // it would report success having run nothing, so it falls through to
  // `runSuites` and the no-files failure that names the glob.
  if (!whole && entries.length === 0) {
    _log("[test] nothing selected");
    return 0;
  }
  // `{base}` in a command run needs a ref even when no diff was measured.
  if (base === null && needsBase(chosen)) {
    try {
      base = resolveBase({ repoRoot, against: opts.against, candidates: config.base, _spawnSync });
    } catch (err) {
      if (!(err instanceof ChangedSetError)) throw err;
      return usage(`a command run names {base}: ${err.message}`, _err);
    }
  }

  const results = await runSuites(chosen, {
    selected,
    fast: opts.fast,
    reporter: opts.reporter,
    agent,
    colour,
    slowMs,
    config,
    shims,
    platformMode: opts.platform === "windows" ? "windows" : "plain",
    diffBase: base,
    repoRoot,
    resultsDir: join(repoRoot, "test-results"),
    _spawn,
    _spawnSync,
    _platform,
    _killTree,
    _fs,
    _log,
    _writeOut,
    _writeErr,
    _now,
  });
  if (results.length === 0) {
    _log("[test] nothing to run");
    return 0;
  }
  for (const result of results) _log(summaryLine(result, colour));
  const failed = results.filter((result) => !result.ok);
  _log(countLine(results, colour));
  return failed.length === 0 ? 0 : 1;
}
