// Command runs: an argv with no shell, its streams captured when it has a
// format, and the rows the parser builds from them. The child's exit code
// alone stays the verdict; rows follow it, never the other way round.

import { join } from "node:path";

import { withCrateArgs } from "./crates.mjs";
import { recordCommandTimings } from "./fast.mjs";
import { parseOutput } from "./formats.mjs";
import { STDERR_TAIL_LINES } from "./reporter.mjs";
import { slowLines, testRows, totalsLines } from "./render.mjs";
import { commandSpawn } from "./spawn-command.mjs";
import { install, labelOf, settle } from "./execute.mjs";

export const COMMAND_HEARTBEAT_MS = 60_000;

/** One parsed event becomes one row entry: `passed` from the outcome, a skip's
 *  todo bit kept distinct, a failure's detail carried for agent mode. */
function entryOf(event) {
  const entry = {
    name: event.name,
    chain: event.chain ?? [],
    ms: event.ms,
    passed: event.outcome === "pass",
  };
  if (event.outcome === "skip") entry.skip = event.todo ? "todo" : "skip";
  if (event.outcome === "fail" && event.detail) entry.detail = event.detail;
  return entry;
}

/** A command run: its argv with no shell, `{base}` replaced by the base. A
 *  cargo run's selected `crates` build the `-p` list (workspace selectors
 *  stripped, inserted before the first `--`). A run with a `format` also
 *  captures both streams: stdout is the parser's input and the log's body and
 *  is never echoed to the console; stderr is teed through `_writeErr` unless
 *  agent mode holds it for a bounded tail after a failing run; the events the
 *  parser finds render as rows, a slow list and a totals line. The child's
 *  exit code alone stays the verdict: rows follow it, never the other way
 *  round. */
export async function runCommand({
  suite, run, repoRoot, resultsDir, diffBase, key, fast, skipArgs, crates, agent, colour, slowMs, shims = {},
  _spawn, _spawnSync, _platform, _killTree, _fs, _log, _writeOut, _writeErr, _now, _heartbeatMs, _pollMs,
}) {
  const cwdAbs = join(repoRoot, run.cwd);
  const label = labelOf(suite, run);
  const base = { suite: suite.name, label, files: [] };
  const started = _now();

  const failedInstall = install({ run, cwdAbs, base, started, _fs, _spawnSync, _platform, _log, _now });
  if (failedInstall) return failedInstall;

  // The `{report}` token names the run's results dir, not the run's cwd: a new
  // file beside the cwd would enter the untracked-file changed set and flip
  // every later diff selection whose closure depends on it.
  const reportToken = run.command.some((arg) => arg.includes("{report}"));
  const reportPath = join(resultsDir, `${label}.report.xml`);

  // The -p splice happens before the fast-skip args so the deselects keep
  // appending last, where their CLI accepts them.
  const argv = withCrateArgs(run.command.map((arg) => arg
    .split("{base}").join(diffBase ?? "{base}")
    .split("{report}").join(reportPath)), crates);
  if (skipArgs) argv.push(...skipArgs); // the producer's own deselects, last, where its CLI accepts them
  const { file, args, options } = commandSpawn(argv, { platform: _platform });
  _log(`[test] ${label}: ${argv.join(" ")}`);
  const capture = run.format !== undefined;
  const logPath = join(resultsDir, `${label}.log`);
  if (capture) {
    try {
      _fs.unlinkSync(logPath); // a producer writing nothing must not be parsed from the last run's log
    } catch {
      // Nothing to clear.
    }
    if (reportToken) {
      // The producer writes into the dir, so it exists before the spawn; the
      // file itself only unlinked -- a producer writing nothing must never be
      // parsed from the last run's report.
      _fs.mkdirSync(resultsDir, { recursive: true });
      try {
        _fs.unlinkSync(reportPath);
      } catch {
        // Nothing to clear.
      }
    }
  }

  let child;
  try {
    child = _spawn(file, args, {
      cwd: cwdAbs,
      env: { ...process.env, ...(run.env || {}) },
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
      detached: _platform !== "win32",
      windowsHide: true,
      ...options,
    });
  } catch (err) {
    return { ...base, ok: false, status: "fail", reason: err.message, durationMs: _now() - started };
  }

  let stdoutText = "";
  const stderrChunks = [];
  if (capture) {
    child.stdout?.on("data", (chunk) => { stdoutText += String(chunk); });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
      if (!agent) _writeErr(String(chunk));
    });
  }

  // A command run inherits its stdout, so nothing ticks while it works. The
  // poll loop is real, the clock injectable: a test steps `_now` forward and
  // the beats print from it until the child settles. A wakeup is only ever
  // needed a quarter-interval early, floored at 250ms -- a 60s heartbeat must
  // not wake the process 20 times a second to look at a clock it can predict.
  const heartbeatMs = _heartbeatMs ?? COMMAND_HEARTBEAT_MS;
  const pollMs = _pollMs ?? Math.max(250, Math.floor(heartbeatMs / 4));
  let nextBeat = started + heartbeatMs;
  let beatTimer = null;
  let settled = false;
  const poll = () => {
    if (settled) return;
    const at = _now();
    while (at >= nextBeat) {
      _writeOut(`… still running (${Math.round((nextBeat - started) / 1000)}s): ${label}\n`);
      nextBeat += heartbeatMs;
    }
    beatTimer = setTimeout(poll, pollMs);
  };
  poll();

  const result = await settle(child, {
    run, started, base, _killTree, _platform, _spawnSync, _now,
    onSettle: () => {
      settled = true;
      if (beatTimer) clearTimeout(beatTimer);
      beatTimer = null;
    },
  });

  const stderrText = stderrChunks.join("");
  if (capture) {
    // The reporter child creates the results dir for globs runs; a command run
    // has no reporter, so the log's own write creates it here.
    _fs.mkdirSync(resultsDir, { recursive: true });
    // stdout verbatim; the separator line starts at column 0, so a stdout
    // ending mid-line gains one newline.
    const glue = stdoutText.endsWith("\n") || stdoutText === "" ? "" : "\n";
    _fs.writeFileSync(logPath, stderrText ? `${stdoutText}${glue}--- stderr ---\n${stderrText}` : stdoutText);
    // A `{report}` run parses the file the producer wrote -- when it wrote one;
    // stdout is the fallback the producer's console chatter supplies. Keeping
    // the file after the run is the default: the path stays raw evidence,
    // gitignored beside the log.
    let report = null;
    if (reportToken) {
      try {
        report = { path: reportPath, text: String(_fs.readFileSync(reportPath, "utf8")) };
      } catch {
        report = null; // never appeared: stdout is the input
      }
    }
    // A `.mjs` shim is the parser when the run named one: called with exactly
    // the captured shape, expecting `{ events: [...] }`. A throwing shim is
    // the zero-events notice -- the verdict stays the child's exit code.
    const shim = shims[run.format];
    let events;
    if (shim) {
      try {
        const parsed = await shim({ stdout: stdoutText, stderr: stderrText, exitCode: result.exitCode, report });
        events = Array.isArray(parsed?.events)
          ? parsed.events.filter((event) => event && typeof event === "object" && typeof event.name === "string")
          : [];
      } catch {
        events = [];
      }
    } else {
      events = parseOutput(run.format, { stdout: stdoutText, stderr: stderrText, exitCode: result.exitCode, report });
    }
    if (events.length === 0) {
      _writeErr(`[test] ${label}: no tests recognised in the output (format: ${run.format}); raw output in ${logPath}\n`);
    } else {
      const record = { passed: result.ok, ms: result.durationMs, nodes: events.map(entryOf) };
      for (const line of testRows(record, { colour, agent, slowMs })) _log(line);
      // Agent mode is failed rows plus the stderr tail, as the reporter's own
      // gating is: neither the slowest list nor the totals line prints.
      if (!agent) {
        const slow = events
          .filter((event) => event.ms !== null && event.ms >= slowMs)
          .map((event) => ({ chain: event.chain ?? [], name: event.name, ms: event.ms }));
        for (const line of slowLines(slow, slowMs)) _log(line);
        const counts = { tests: events.length, passed: 0, failed: 0, skipped: 0, todo: 0 };
        for (const event of events) {
          if (event.outcome === "pass") counts.passed++;
          else if (event.outcome === "fail") counts.failed++;
          else if (event.todo) counts.todo++;
          else counts.skipped++;
        }
        for (const line of totalsLines({ ...counts, duration_ms: result.durationMs }, { colour })) _log(line);
      }
      // The timings record rides a passing parsed run: a failing run's
      // measurement half-captures a tree the next --fast would trust, and the
      // deselected tests of that next run produce no events this one sees, so
      // the entry merges (recordCommandTimings) instead of overwriting. A tree
      // without git or an unwritable cache records nothing -- the record is an
      // optimisation, never a verdict, and the run stands on its exit code.
      if (fast && key && result.ok) recordCommandTimings({ resultsDir, key, events, repoRoot, _now, _fs, _spawnSync });
    }
  }
  if (agent && !result.ok && stderrText) {
    const lines = stderrText.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines.slice(-STDERR_TAIL_LINES)) _writeErr(`${line}\n`);
  }
  return result;
}
