// Running suites: installs, one `node --test` per run, timeouts and the tree
// kill. Which files run is decided before this module is reached.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join, posix } from "node:path";

import { readTimings, slowFiles } from "./fast.mjs";
import { skipDirsFor } from "./graph.mjs";
import { commandKey, expandRun } from "./select.mjs";
import { commandSpawn } from "./spawn-command.mjs";

// --- Platform --------------------------------------------------------------

const WIN_TEST = /\.win\.test\.mjs$/;

/** The config's name for this host, or null on a host with no pinned runs. */
export function hostPlatform(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
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

function labelOf(suite, run) {
  return `${suite.name}${run.label ? `[${run.label}]` : ""}`;
}

/** A file URL, so the reporter loads from any working directory and any
 *  checkout -- including the WSL mirror. */
const REPORTER_URL = new URL("./reporter.mjs", import.meta.url).href;

// --- Install ---------------------------------------------------------------

/** `npm ci` once per lockfile hash. The record lives inside `node_modules`,
 *  which the WSL mirror's rsync excludes, so a `--delete` sync leaves it. */
export function installIfNeeded({
  cwd,
  install,
  _fs = nodeFs,
  _spawnSync = spawnSync,
  _platform = process.platform,
} = {}) {
  const lockfile = join(cwd, "package-lock.json");
  if (!_fs.existsSync(lockfile)) return { installed: false };
  const hash = createHash("sha256").update(_fs.readFileSync(lockfile)).digest("hex");
  const record = join(cwd, "node_modules", ".test-install-hash");
  if (_fs.existsSync(record)) {
    let recorded = "";
    try {
      recorded = String(_fs.readFileSync(record, "utf8")).trim();
    } catch {
      recorded = "";
    }
    if (recorded === hash) return { installed: false };
  }
  const [command, ...args] = install;
  const result = _spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: _platform === "win32", // npm is npm.cmd here, which spawn cannot exec directly
  });
  if (!result || result.error || result.status !== 0) {
    return { installed: false, error: `install failed (${install.join(" ")})` };
  }
  _fs.mkdirSync(join(cwd, "node_modules"), { recursive: true });
  _fs.writeFileSync(record, hash);
  return { installed: true };
}

// --- Running ---------------------------------------------------------------

/** A timed-out run is killed as a TREE: the test process spawns children of its
 *  own, and killing only the parent leaves them holding the pipe. */
export function killTree(pid, { platform = process.platform, _spawnSync = spawnSync, _kill = process.kill } = {}) {
  if (!pid) return;
  if (platform === "win32") {
    _spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    _kill(-pid, "SIGKILL"); // the spawn's own process group
  } catch {
    // Already gone: nothing to kill, and nothing worth reporting.
  }
}

export function summaryLine(result) {
  const detail = result.reason ? ` -- ${result.reason}` : "";
  return `[test] ${result.label}: ${result.status.toUpperCase()}${detail} in ${(result.durationMs / 1000).toFixed(1)}s`;
}

/** `14m02s`, so a timeout reason reads as the elapsed time the file had been
 *  running rather than a raw millisecond count. */
function elapsedText(ms) {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** The files a killed run still had in flight, from the reporter's record. A
 *  killed child cannot report, so this file is the only evidence of what was
 *  still running. A missing or half-written record reads as empty. */
export function inFlightFiles(path, { now = Date.now, _fs = nodeFs } = {}) {
  let payload;
  try {
    payload = JSON.parse(String(_fs.readFileSync(path, "utf8")));
  } catch {
    return [];
  }
  const entries = Array.isArray(payload && payload.files) ? payload.files : [];
  return entries
    .filter((entry) => entry && typeof entry.file === "string")
    .map((entry) => (Number.isFinite(entry.startedAt)
      ? `${entry.file} (${elapsedText(Math.max(0, now() - entry.startedAt))})`
      : entry.file));
}

/** Wait for `child` to close, killing its tree at the run's timeout. `onSettle`
 *  runs once either way, before the result resolves; `stillRunning` names what a
 *  killed run had in flight. */
function settle(child, { run, started, base, _killTree, _platform, _spawnSync, _now, onSettle = () => {}, stillRunning = () => [] }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      onSettle();
      resolve({ ...base, durationMs: _now() - started, ...result });
    };
    timer = setTimeout(() => {
      const still = stillRunning();
      _killTree(child.pid, { platform: _platform, _spawnSync });
      const detail = still.length > 0 ? `; still running: ${still.join(", ")}` : "";
      finish({ ok: false, status: "timeout", reason: `no exit within ${run.timeoutMs}ms${detail}`, exitCode: null });
    }, run.timeoutMs);
    child.once("close", (code) => {
      if (settled) return;
      finish(code === 0
        ? { ok: true, status: "pass", exitCode: 0 }
        : { ok: false, status: "fail", exitCode: code, reason: `exit ${code}` });
    });
    child.once("error", (err) => finish({ ok: false, status: "fail", reason: err.message, exitCode: null }));
  });
}

/** The run's install, when it has one: a failure result to report, else null. */
function install({ run, cwdAbs, base, started, _fs, _spawnSync, _platform, _log, _now }) {
  if (!run.install) return null;
  const installed = installIfNeeded({ cwd: cwdAbs, install: run.install, _fs, _spawnSync, _platform });
  if (installed.error) {
    return { ...base, ok: false, status: "fail", reason: installed.error, durationMs: _now() - started };
  }
  if (installed.installed) _log(`[test] ${base.label}: installed (lockfile changed)`);
  return null;
}

async function runOne({ suite, run, files, repoRoot, resultsDir, reporter, _spawn, _spawnSync, _platform, _killTree, _fs, _log, _now }) {
  const cwdAbs = join(repoRoot, run.cwd);
  const label = labelOf(suite, run);
  const base = { suite: suite.name, label, files };
  const logPath = join(resultsDir, `${label}.log`);
  try {
    _fs.unlinkSync(logPath); // a killed run must not be pointed at the last run's log
  } catch {
    // Nothing to clear.
  }
  const started = _now();
  const reporterEnv = {
    TEST_RUN_LABEL: label,
    TEST_REPO_ROOT: repoRoot,
    TEST_RESULTS_DIR: resultsDir,
    ...(reporter ? { TEST_REPORTER: reporter } : {}),
  };

  const failedInstall = install({ run, cwdAbs, base, started, _fs, _spawnSync, _platform, _log, _now });
  if (failedInstall) return failedInstall;

  const args = [];
  if (run.envFile) args.push(`--env-file=${run.envFile}`);
  const cwdBase = run.cwd === "." || run.cwd === "" ? "." : run.cwd;
  args.push("--test", `--test-reporter=${REPORTER_URL}`, "--test-reporter-destination=stdout",
    ...files.map((file) => posix.relative(cwdBase, file)));

  let child;
  try {
    child = _spawn(process.execPath, args, {
      cwd: cwdAbs,
      env: { ...process.env, ...(run.env || {}), ...reporterEnv },
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
    stillRunning: () => inFlightFiles(inFlight, { now: _now, _fs }),
    onSettle: () => {
      try {
        _fs.unlinkSync(inFlight); // the record is for a timeout, not the next run
      } catch {
        // Never written, or already cleared by a reporter that exited cleanly.
      }
    },
  });
}

/** A command run: its argv with no shell, `{base}` replaced by the diff base. */
async function runCommand({ suite, run, repoRoot, diffBase, _spawn, _spawnSync, _platform, _killTree, _fs, _log, _now }) {
  const cwdAbs = join(repoRoot, run.cwd);
  const label = labelOf(suite, run);
  const base = { suite: suite.name, label, files: [] };
  const started = _now();

  const failedInstall = install({ run, cwdAbs, base, started, _fs, _spawnSync, _platform, _log, _now });
  if (failedInstall) return failedInstall;

  const argv = run.command.map((arg) => arg.split("{base}").join(diffBase ?? "{base}"));
  const { file, args, options } = commandSpawn(argv, { platform: _platform });
  _log(`[test] ${label}: ${argv.join(" ")}`);
  let child;
  try {
    child = _spawn(file, args, {
      cwd: cwdAbs,
      env: { ...process.env, ...(run.env || {}) },
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
  config = {},
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
  _now = Date.now,
  _readdirSync = nodeFs.readdirSync,
} = {}) {
  const resultsDirPath = resultsDir ?? join(repoRoot, "test-results");
  const timings = fast ? readTimings(resultsDirPath) : {};
  const skip = fast
    ? new Set(slowFiles(timings, { repoRoot, now: _now }).map((entry) => entry.file))
    : new Set();
  if (fast && Object.keys(timings).length === 0) {
    _log("[test] --fast: no timings recorded yet; running everything");
  }
  const host = hostPlatform(_platform);
  const allows = (platform) => platformAllows(platform, { mode: platformMode, host });
  const where = platformMode === "windows" ? "--platform windows" : `this ${host ?? _platform} host`;
  const shared = { repoRoot, _spawn, _spawnSync, _platform, _killTree, _fs, _log, _now };

  const skipDirs = skipDirsFor(config);
  const results = [];
  for (const suite of suites) {
    for (const [index, run] of suite.runs.entries()) {
      const label = labelOf(suite, run);
      const platform = run.platform ?? "any";
      if (run.command) {
        if (selected && !selected.has(`${suite.name}\0${commandKey(run, index)}`)) {
          _log(`[test] ${label}: skipped (nothing selected)`);
          continue;
        }
        if (!allows(platform)) {
          if (platform !== "any") _log(`[test] ${label}: skipped on ${where} (platform: ${platform})`);
          continue;
        }
        results.push(await runCommand({ suite, run, diffBase, ...shared }));
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
      results.push(await runOne({ suite, run, files, resultsDir: resultsDirPath, reporter, ...shared }));
      const logPath = join(resultsDirPath, `${label}.log`);
      if (_fs.existsSync(logPath)) _log(`[test] ${label} log: ${logPath}`);
    }
  }
  return results;
}
