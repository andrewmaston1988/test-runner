// Running suites: installs, one `node --test` per run, timeouts and the tree
// kill. Which files run is decided before this module is reached.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join, posix } from "node:path";

import { readTimings, slowFiles } from "./fast.mjs";
import { skipDirsFor } from "./graph.mjs";
import { expandRun } from "./select.mjs";

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

async function runOne({ suite, run, files, repoRoot, resultsDir, reporter, _spawn, _spawnSync, _platform, _killTree, _fs, _log, _now }) {
  const cwdAbs = join(repoRoot, run.cwd);
  const label = `${suite.name}${run.label ? `[${run.label}]` : ""}`;
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

  if (run.install) {
    const installed = installIfNeeded({ cwd: cwdAbs, install: run.install, _fs, _spawnSync, _platform });
    if (installed.error) {
      return { suite: suite.name, label, ok: false, status: "fail", reason: installed.error, files, durationMs: _now() - started };
    }
    if (installed.installed) _log(`[test] ${label}: installed (lockfile changed)`);
  }

  const args = [];
  if (run.envFile) args.push(`--env-file=${run.envFile}`);
  const base = run.cwd === "." || run.cwd === "" ? "." : run.cwd;
  args.push("--test", `--test-reporter=${REPORTER_URL}`, "--test-reporter-destination=stdout",
    ...files.map((file) => posix.relative(base, file)));

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
    return { suite: suite.name, label, ok: false, status: "fail", reason: err.message, files, durationMs: _now() - started };
  }

  const inFlight = join(resultsDir, `${label}.${child.pid}.inflight.json`);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        _fs.unlinkSync(inFlight); // the record is for a timeout, not the next run
      } catch {
        // Never written, or already cleared by a reporter that exited cleanly.
      }
      resolve({ suite: suite.name, label, files, durationMs: _now() - started, ...result });
    };
    timer = setTimeout(() => {
      const still = inFlightFiles(inFlight, { now: _now, _fs });
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

/** Run every suite (all its runs) or only the selected files.
 *
 *  `selected` is a set of `<suite>\0<file>` keys; null means run every suite
 *  whole. A run with nothing selected is skipped in diff mode -- it is not a
 *  failure -- but a whole-suite run whose globs match no file always fails. */
export async function runSuites(suites, {
  selected = null,
  fast = false,
  reporter = null,
  config = {},
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

  const skipDirs = skipDirsFor(config);
  const results = [];
  for (const suite of suites) {
    for (const run of suite.runs) {
      const expanded = expandRun(run, { repoRoot, skipDirs, _readdirSync });
      const chosenFiles = selected
        ? expanded.filter((file) => selected.has(`${suite.name}\0${file}`))
        : expanded;
      const files = chosenFiles.filter((file) => !skip.has(file));
      const label = `${suite.name}${run.label ? `[${run.label}]` : ""}`;
      const fastSkipped = chosenFiles.length - files.length;
      if (fastSkipped > 0) {
        const names = chosenFiles.filter((file) => skip.has(file));
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
          _log(`[test] ${label}: skipped (nothing selected)`);
          continue;
        }
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
      results.push(await runOne({
        suite, run, files, repoRoot, resultsDir: resultsDirPath, reporter,
        _spawn, _spawnSync, _platform, _killTree, _fs, _log, _now,
      }));
      const logPath = join(resultsDirPath, `${label}.log`);
      if (_fs.existsSync(logPath)) _log(`[test] ${label} log: ${logPath}`);
    }
  }
  return results;
}
