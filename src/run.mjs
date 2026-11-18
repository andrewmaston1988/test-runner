// Running suites: one `node --test` per run, the platform filter, and the
// tree kill's timeout. Which files run is decided before this module is
// reached; a command run is handed to command.mjs.

import { spawn, spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { CODES, paint } from "./colour.mjs";
import { COMMAND_HEARTBEAT_MS, runCommand } from "./command.mjs";
import { DEFAULT_SLOW_MS } from "./config.mjs";
import { install, inFlightFiles, killTree, labelOf, settle } from "./execute.mjs";
import { fastSkipArgs } from "./formats.mjs";
import { loadTimings, slowCommandTests, slowFiles, treeState } from "./fast.mjs";
import { skipDirsFor } from "./graph.mjs";
import { WIN_TEST, commandKey, expandRun } from "./select.mjs";
import { argvLimit, commandSpawn } from "./spawn-command.mjs";
import { withTempRoot } from "./temp-root.mjs";

export { labelOf };

// --- Platform --------------------------------------------------------------


/** The config's name for this host, or null on a host with no pinned runs. */
export function hostPlatform(_platform = process.platform) {
  if (_platform === "win32") return "windows";
  if (_platform === "linux") return "linux";
  return null;
}

/** Whether a run or file pinned to `platform` executes in this invocation. A
 *  plain run takes `any` plus the host's own; `--platform windows` takes only
 *  `windows`. So on Windows, `--platform windows` plus `--wsl` (a plain run on
 *  Linux) execute every run exactly once between them. */
export function platformAllows(platform, { mode = "plain", host }) {
  if (mode === "windows") return platform === "windows";
  return platform === "any" || platform === host;
}

/** A `*.win.test.mjs` is pinned to Windows whatever its run says. */
export function filePlatform(file, run) {
  return WIN_TEST.test(file) ? "windows" : run.platform ?? "any";
}

/** A file URL, so the reporter loads from any working directory and any
 *  checkout -- including the WSL mirror. */
const REPORTER_URL = new URL("./reporter.mjs", import.meta.url).href;

// --- Summary ---------------------------------------------------------------

/** One run's outcome. Green or red on `ok`; a skip is neither. */
export function summaryLine(result, colour = false) {
  const detail = result.reason ? ` -- ${result.reason}` : "";
  const line = `[test] ${result.label}: ${result.status.toUpperCase()}${detail} in ${(result.durationMs / 1000).toFixed(1)}s`;
  if (result.status === "skipped") return line;
  return paint(colour, result.ok ? CODES.green : CODES.red, line);
}

/** The last line of a run, green only when every run passed. */
export function countLine(results, colour = false) {
  const failed = results.filter((result) => !result.ok).length;
  const line = `[test] ${results.length - failed}/${results.length} run(s) passed`;
  return paint(colour, failed === 0 ? CODES.green : CODES.red, line);
}

// --- Running ---------------------------------------------------------------

async function runOne({ suite, run, files, repoRoot, resultsDir, reporter, colour, slowMs, tempEnv, _spawn, _spawnSync, _platform, _killTree, _fs, _log, _now }) {
  const cwdAbs = join(repoRoot, run.cwd);
  const label = labelOf(suite, run);
  const base = { suite: suite.name, label, files };
  if (!run.runner) {
    try {
      _fs.unlinkSync(join(resultsDir, `${label}.log`)); // a killed run must not be pointed at the last run's log
    } catch {
      // Nothing to clear.
    }
  }
  const started = _now();
  const reporterEnv = {
    TEST_RUN_LABEL: label,
    TEST_REPO_ROOT: repoRoot,
    TEST_RESULTS_DIR: resultsDir,
    // The reporter child renders rows; only it is told how they look. A
    // command run's output is the user's own and must stay untouched.
    TEST_COLOUR: colour ? "1" : "0",
    SLOW_MS: String(slowMs),
    ...(reporter ? { TEST_REPORTER: reporter } : {}),
  };

  const failedInstall = install({ run, cwdAbs, base, started, _fs, _spawnSync, _platform, _log, _now });
  if (failedInstall) return failedInstall;

  const cwdBase = run.cwd === "." || run.cwd === "" ? "." : run.cwd;

  // A runner run is the consumer's own command with the selected files appended.
  // It gets neither `--test` nor the reporter: its output is not node's, and a
  // process it starts must see the environment as the user configured it.
  if (run.runner) {
    const argv = [...run.runner, ...files.map((file) => posix.relative(cwdBase, file))];
    const limit = argvLimit(argv, { platform: _platform });
    const over = argv.join(" ").length > limit;
    if (over) {
      _log(`[test] ${label}: ${files.length} selected file(s) need more than the ${limit} argv characters `
        + `${run.runner[0]} allows; running it with no file list`);
    }
    const { file, args, options } = commandSpawn(over ? run.runner : argv, { platform: _platform });
    let child;
    try {
      child = _spawn(file, args, {
        cwd: cwdAbs,
        env: { ...process.env, ...tempEnv, ...(run.env || {}) },
        stdio: "inherit",
        detached: _platform !== "win32",
        windowsHide: true,
        ...options,
      });
    } catch (err) {
      return { ...base, ok: false, status: "fail", reason: err.message, durationMs: _now() - started };
    }
    return settle(child, { run, started, base, _killTree, _platform, _spawnSync, _now });
  }

  const args = [];
  if (run.envFile) args.push(`--env-file=${run.envFile}`);
  args.push("--test", `--test-reporter=${REPORTER_URL}`, "--test-reporter-destination=stdout",
    ...files.map((file) => posix.relative(cwdBase, file)));

  let child;
  try {
    child = _spawn(process.execPath, args, {
      cwd: cwdAbs,
      env: { ...process.env, ...tempEnv, ...(run.env || {}), ...reporterEnv },
      stdio: "inherit",
      detached: _platform !== "win32", // its own process group, so killTree can reach it
      windowsHide: true,
    });
  } catch (err) {
    return { ...base, ok: false, status: "fail", reason: err.message, durationMs: _now() - started };
  }

  const inFlight = join(resultsDir, `${label}.${child.pid}.inflight.json`);
  return settle(child, {
    run, started, base, _killTree, _platform, _spawnSync, _now,
    stillRunning: () => inFlightFiles(inFlight, { _now, _fs }),
    onSettle: () => {
      try {
        _fs.unlinkSync(inFlight); // the record is for a timeout, not the next run
      } catch {
        // Never written, or already cleared by a reporter that exited cleanly.
      }
    },
  });
}

/** True when an argument of any of these suites' command runs names `{base}`:
 *  the caller must then resolve a base even for a whole-suite run. */
export function needsBase(suites) {
  return suites.some((suite) => suite.runs.some((run) => run.command && run.command.some((arg) => arg.includes("{base}"))));
}

/** Run every suite (all its runs) or only the selected files and commands.
 *
 *  `selected` is a set of `<suite>\0<file>` keys (`<suite>\0command:<id>` for a
 *  command run); null means run every suite whole. A run with nothing selected
 *  is skipped in diff mode -- it is not a failure -- but a whole-suite run whose
 *  globs match no file always fails. `platformMode` and the host decide which
 *  runs and files execute here; the rest are named as skipped. */
export async function runSuites(suites, {
  selected = null,
  fast = false,
  reporter = null,
  agent = false,
  colour = false,
  slowMs = DEFAULT_SLOW_MS,
  config = {},
  shims = {},
  platformMode = "plain",
  diffBase = null,
  repoRoot,
  resultsDir = null,
  _spawn = spawn,
  _spawnSync = spawnSync,
  _platform = process.platform,
  _killTree = killTree,
  _fs = nodeFs,
  _log = () => {},
  _writeOut = (text) => process.stdout.write(text),
  _writeErr = (text) => process.stderr.write(text),
  _now = Date.now,
  _heartbeatMs = COMMAND_HEARTBEAT_MS,
  _pollMs,
  _readdirSync = nodeFs.readdirSync,
  _tmpdir = tmpdir,
} = {}) {
  const resultsDirPath = resultsDir ?? join(repoRoot, "test-results");
  // The raw cache: file entries drive this loop's file skips (a command run's
  // entry carries no ms, so the same guards drop it there), and a run's own
  // command entry is read on demand below. Both shapes must survive the read.
  const timings = fast ? loadTimings(resultsDirPath) : {};
  const skip = fast
    ? new Set(slowFiles(timings, { repoRoot, _now }).map((entry) => entry.file))
    : new Set();
  if (fast && Object.keys(timings).length === 0) {
    _log("[test] --fast: no timings recorded yet; running everything");
  }
  const host = hostPlatform(_platform);
  const allows = (platform) => platformAllows(platform, { mode: platformMode, host });
  const where = platformMode === "windows" ? "--platform windows" : `this ${host ?? _platform} host`;
  // The stamps a command playthrough refuses on: computed once, at the first
  // --fast command run that asks. Null outside git -- a record made without a
  // tree must never deselect against one it has not seen.
  let tree;
  const treeOf = () => (tree === undefined ? (tree = treeState(repoRoot, { _spawnSync })) : tree);
  const shared = {
    repoRoot, colour, slowMs, agent, shims,
    _spawn, _spawnSync, _platform, _killTree, _fs, _log, _writeOut, _writeErr, _now, _heartbeatMs, _pollMs,
  };

  const skipDirs = skipDirsFor(config);
  const results = [];
  for (const suite of suites) {
    for (const [index, run] of suite.runs.entries()) {
      const label = labelOf(suite, run);
      const platform = run.platform ?? "any";
      if (run.command) {
        let crates = null;
        if (selected) {
          const base = `${suite.name}\0${commandKey(run, index)}`;
          if (!selected.has(base)) {
            // Crate keys carry the run's selection when the whole key is absent:
            // each becomes one -p of the shared invocation.
            const names = new Set();
            for (const key of selected) {
              if (key.startsWith(`${base}#`)) names.add(key.slice(base.length + 1));
            }
            if (names.size === 0) {
              _log(`[test] ${label}: skipped (nothing selected)`);
              continue;
            }
            crates = [...names];
          }
        }
        if (!allows(platform)) {
          if (platform !== "any") _log(`[test] ${label}: skipped on ${where} (platform: ${platform})`);
          continue;
        }
        let commandSkipArgs = [];
        if (fast && run.format) {
          const tree = treeOf();
          const commandSkip = fastSkipArgs(run, slowCommandTests(timings[commandKey(run, index)], {
            _now, sha: tree ? tree.sha : null, dirty: tree ? tree.dirty : false,
          }));
          if (commandSkip.warn) {
            _log(`[test] ${label}: --fast: ${run.format} has no skip args, running whole`);
          } else if (commandSkip.names.length > 0) {
            _log(`[test] ${label}: --fast skipping ${commandSkip.names.length} measured-slow test(s): ${commandSkip.names.join(", ")}`);
          }
          commandSkipArgs = commandSkip.args;
        }
        results.push(await withTempRoot({ label, runEnv: run.env, _fs, _tmpdir, _log }, (tempEnv) =>
          runCommand({ suite, run, diffBase, resultsDir: resultsDirPath, key: commandKey(run, index), fast, skipArgs: commandSkipArgs, crates, tempEnv, ...shared })));
        const commandLog = join(resultsDirPath, `${label}.log`);
        if (_fs.existsSync(commandLog)) _log(`[test] ${label} log: ${commandLog}`);
        continue;
      }

      const expanded = expandRun(run, { repoRoot, skipDirs, _readdirSync });
      const chosenFiles = selected
        ? expanded.filter((file) => selected.has(`${suite.name}\0${file}`))
        : expanded;
      const hereFiles = chosenFiles.filter((file) => allows(filePlatform(file, run)));
      const elsewhere = chosenFiles.length - hereFiles.length;
      if (elsewhere > 0 && platform !== "any" && !allows(platform)) {
        _log(`[test] ${label}: skipped on ${where} (platform: ${platform})`);
      } else if (elsewhere > 0 && platformMode === "plain") {
        _log(`[test] ${label}: skipped ${elsewhere} windows-only file(s) on ${where}`);
      }
      const files = hereFiles.filter((file) => !skip.has(file));
      const fastSkipped = hereFiles.length - files.length;
      if (fastSkipped > 0) {
        const names = hereFiles.filter((file) => skip.has(file));
        _log(`[test] ${label}: --fast skipped ${fastSkipped} measured-slow file(s): ${names.join(", ")}`);
      }
      if (files.length === 0) {
        if (fastSkipped > 0) {
          results.push({
            suite: suite.name,
            label,
            ok: true,
            status: "skipped",
            reason: `--fast skipped ${fastSkipped} measured-slow file(s)`,
            files,
            durationMs: 0,
          });
          continue;
        }
        if (selected) {
          if (chosenFiles.length === 0) _log(`[test] ${label}: skipped (nothing selected)`);
          continue;
        }
        // Only a run whose globs match nothing at all is misconfigured; one
        // whose files all belong to another platform is simply not run here.
        if (expanded.length > 0) continue;
        results.push({
          suite: suite.name,
          label,
          ok: false,
          status: "no-files",
          reason: `no file matched ${run.globs.join(" ")}`,
          files,
          durationMs: 0,
        });
        continue;
      }
      results.push(await withTempRoot({ label, runEnv: run.env, _fs, _tmpdir, _log }, (tempEnv) =>
        runOne({ suite, run, files, resultsDir: resultsDirPath, reporter, tempEnv, ...shared })));
      const logPath = join(resultsDirPath, `${label}.log`);
      if (_fs.existsSync(logPath)) _log(`[test] ${label} log: ${logPath}`);
    }
  }
  return results;
}
