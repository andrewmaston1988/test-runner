// The child a run becomes: its install, its settle, its timeout and the tree
// kill. Which child to spawn, and with what argv, is decided by the caller.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";

import { commandSpawn } from "./spawn-command.mjs";

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
  const { file, args, options } = commandSpawn(install, { platform: _platform });
  const result = _spawnSync(file, args, { ...options, cwd, stdio: "inherit" });
  if (!result || result.error || result.status !== 0) {
    return { installed: false, error: `install failed (${install.join(" ")})` };
  }
  _fs.mkdirSync(join(cwd, "node_modules"), { recursive: true });
  _fs.writeFileSync(record, hash);
  return { installed: true };
}

// --- Running ---------------------------------------------------------------

/** The run's install, when it has one: a failure result to report, else null. */
export function install({ run, cwdAbs, base, started, _fs, _spawnSync, _platform, _log, _now }) {
  if (!run.install) return null;
  const installed = installIfNeeded({ cwd: cwdAbs, install: run.install, _fs, _spawnSync, _platform });
  if (installed.error) {
    return { ...base, ok: false, status: "fail", reason: installed.error, durationMs: _now() - started };
  }
  if (installed.installed) _log(`[test] ${base.label}: installed (lockfile changed)`);
  return null;
}

/** A timed-out run is killed as a TREE: the test process spawns children of its
 *  own, and killing only the parent leaves them holding the pipe. */
export function killTree(pid, { _platform = process.platform, _spawnSync = spawnSync, _kill = process.kill } = {}) {
  if (!pid) return;
  if (_platform === "win32") {
    _spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    _kill(-pid, "SIGKILL"); // the spawn's own process group
  } catch {
    // Already gone: nothing to kill, and nothing worth reporting.
  }
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
export function inFlightFiles(path, { _now = Date.now, _fs = nodeFs } = {}) {
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
      ? `${entry.file} (${elapsedText(Math.max(0, _now() - entry.startedAt))})`
      : entry.file));
}

/** Wait for `child` to close, killing its tree at the run's timeout. `onSettle`
 *  runs once either way, before the result resolves; `stillRunning` names what a
 *  killed run had in flight. */
export function settle(child, { run, started, base, _killTree, _platform, _spawnSync, _now, onSettle = () => {}, stillRunning = () => [] }) {
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
      _killTree(child.pid, { _platform, _spawnSync });
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

export function labelOf(suite, run) {
  return `${suite.name}${run.label ? `[${run.label}]` : ""}`;
}
