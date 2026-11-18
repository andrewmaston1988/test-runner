// The node --test reporter that makes a run's silence meaningful.
//
// Node relays per-test events in FILE order, so only the file-level complete is
// live: the line prints there, and a heartbeat covers everything else.

import * as nodeFs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recordTimings } from "./fast.mjs";
import { codeFrameFor, errorText, fileRows, indentBlock, slowLines, slowMsFrom, totalsLines } from "./render.mjs";
import { repoRelative, toPosix } from "./paths.mjs";

export const HEARTBEAT_MS = 60_000;
// A run killed at its cap never reaches the end-of-run write, so completed
// timings are also flushed on this cadence: a kill loses at most the last minute.
export const TIMINGS_FLUSH_MS = 60_000;
export const STDERR_TAIL_LINES = 20;

// std-env's agent variables (plus CLAUDECODE, which it also checks). Its PATH,
// EDITOR and TERM_PROGRAM heuristics are deliberately not copied: a path match
// is not a variable and would flip an ordinary developer run into agent mode.
const AGENT_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "REPL_ID",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "OPENCODE",
  "AUGMENT_AGENT",
  "GOOSE_PROVIDER",
  "JUNIE_DATA",
  "JUNIE_SHIM_PATH",
  "COPILOT_AGENT",
  "COPILOT_CLI",
  "CURSOR_AGENT",
];

/** Vitest's rule: an explicit AI_AGENT, or an agent's own variable, means the
 *  reader is a program. A reporter flag beats both. */
export function resolveMode(env) {
  if (env.TEST_REPORTER === "agent" || env.TEST_REPORTER === "default") return env.TEST_REPORTER;
  if (env.AI_AGENT !== undefined && env.AI_AGENT !== "") return "agent";
  return AGENT_VARS.some((name) => env[name]) ? "agent" : "default";
}

/** Resolves on the timer OR on abort, so a closed generator never leaves the
 *  loop waiting on a heartbeat that will not fire. The listener is dropped on
 *  either path: one that accumulates would trip Node's listener warning. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

// --- Paths -----------------------------------------------------------------

function absPath(file, cwd) {
  if (file.startsWith("file://")) {
    try {
      return fileURLToPath(file);
    } catch {
      return file;
    }
  }
  return isAbsolute(file) ? file : join(cwd, file);
}

/** Repo-relative posix path, or the absolute path when the file sits outside
 *  the repository (a fixture in a temp directory, say). */
function repoRel(file, { repoRoot, cwd }) {
  const abs = absPath(file, cwd);
  if (!repoRoot) return toPosix(abs);
  return repoRelative(repoRoot, abs);
}

function display(file, { repoRoot, cwd }) {
  return repoRel(file, { repoRoot, cwd });
}

// --- Rows ------------------------------------------------------------------

/** Node names a file-level row with the path exactly as it was passed on the
 *  command line -- `tests/a.test.mjs`, or the whole path when absolute -- so the
 *  row is identified by resolving that name back onto the file. */
function isFileLevel(data, cwd) {
  if (!Boolean(data) || data.nesting !== 0) return false;
  if (typeof data.name !== "string" || typeof data.file !== "string") return false;
  const abs = absPath(data.file, cwd);
  return resolve(cwd, data.name) === resolve(abs);
}

// --- Reporter --------------------------------------------------------------

/** Injected `now`, `sleep`, `env` and `fs` are what let a test advance the
 *  clock instead of waiting a real minute. */
export function createReporter({ now = Date.now, sleep = abortableSleep, env = process.env, fs = nodeFs } = {}) {
  const mode = resolveMode(env);
  // The parent resolves both once; a bare `node --test` run falls back here.
  const colour = env.TEST_COLOUR === "1";
  const slowMs = slowMsFrom(env.SLOW_MS);
  // TEST_RUN_LABEL names the log, timings and in-flight records; TEST_RESULTS_DIR
  // holds them; TEST_REPO_ROOT is what their paths are relative to.
  const label = env.TEST_RUN_LABEL || "test";
  const cwd = process.cwd();
  const repoRoot = env.TEST_REPO_ROOT || "";
  const resultsDir = env.TEST_RESULTS_DIR || join(repoRoot || cwd, "test-results");
  const paths = { repoRoot, cwd };

  function writeAtomic(path, text) {
    try {
      fs.mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, path);
    } catch {
      // Reporting state must never fail a run: a read-only results directory
      // costs the log, not the tests.
    }
  }

  async function* run(source, abort) {
    const startedAt = now();
    const running = new Map();      // repo-relative path -> start ms
    const files = new Map();        // repo-relative path -> { passed, ms, error, tests }
    const chains = new Map();       // repo-relative path -> ancestor names by nesting
    const failures = new Map();     // repo-relative path -> leaf failures
    const stderr = new Map();       // repo-relative path -> last lines
    const failedFiles = [];         // completion order
    const measured = [];            // { file, ms } of passing files, flushed in batches
    const slow = [];
    let totals = null;
    let flushed = 0;                // measured entries already persisted
    let lastFlush = startedAt;

    const inFlightPath = () => join(resultsDir, `${label}.${process.pid}.inflight.json`);

    /** One timings writer: recordTimings merges the batch into the cache. */
    function flushTimings() {
      if (measured.length === flushed) return;
      const entries = measured.slice(flushed);
      flushed = measured.length;
      lastFlush = now();
      recordTimings({ resultsDir, repoRoot, entries, _now: now, _fs: fs });
    }

    function maybeFlushTimings() {
      if (measured.length > flushed && now() - lastFlush >= TIMINGS_FLUSH_MS) flushTimings();
    }

    function writeInFlight() {
      const payload = {
        pid: process.pid,
        label,
        files: [...running].map(([file, startedAtMs]) => ({ file, startedAt: startedAtMs })),
      };
      writeAtomic(inFlightPath(), `${JSON.stringify(payload)}\n`);
    }

    function fileRecord(key) {
      if (!files.has(key)) files.set(key, { passed: true, ms: 0, error: null, nodes: [] });
      return files.get(key);
    }

    /** Insert by nesting, as skills does: Node relays a suite after its own
     *  children, so the tail the new node replaces is its subtree. */
    function addNode(key, node) {
      const record = fileRecord(key);
      const queue = record.nodes;
      node.children = queue.filter((item) => item.nesting > node.nesting);
      record.nodes = [...queue.filter((item) => item.nesting <= node.nesting), node];
    }

    function failureBlock(key) {
      const lines = [];
      const leaf = failures.get(key) || [];
      if (leaf.length === 0) {
        // A file that crashed at load has no leaf failure; its file-level error
        // and stderr are the only evidence there is.
        lines.push(`FAIL ${key}`);
        const text = errorText(fileRecord(key).error);
        if (text) lines.push(...indentBlock(text));
      }
      for (const entry of leaf) {
        lines.push(`FAIL ${[key, ...entry.chain, entry.name].join(" > ")}`);
        const text = errorText(entry.error);
        if (text) lines.push(...indentBlock(text));
        lines.push(...codeFrameFor({ key, abs: absPath(entry.abs, cwd), error: entry.error, fs }));
      }
      const tail = stderr.get(key) || [];
      if (tail.length > 0) lines.push(`--- ${key} stderr (last ${tail.length} lines) ---`, ...tail);
      return lines;
    }

    function endLines() {
      const lines = [];
      const failed = [...failedFiles];
      for (const key of failures.keys()) if (!failed.includes(key)) failed.push(key);
      for (const key of failed) {
        if (lines.length > 0) lines.push("");
        lines.push(...failureBlock(key));
      }
      if (mode === "default") {
        const slowBlock = slowLines(slow, slowMs);
        const totalBlock = totalsLines(totals, { colour, slowMs });
        if (slowBlock.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(...slowBlock);
        }
        if (totalBlock.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(...totalBlock);
        }
      }
      return lines;
    }

    function logText() {
      const lines = [];
      // Colour off and full detail: the log row is the stdout row minus ANSI.
      for (const [key, record] of files) lines.push(...fileRows(key, record, { colour: false, slowMs }));
      const slowBlock = slowLines(slow, slowMs);
      const totalBlock = totalsLines(totals, { colour: false });
      if (slowBlock.length > 0) lines.push("", ...slowBlock);
      if (totalBlock.length > 0) lines.push("", ...totalBlock);
      return `${lines.join("\n")}\n`;
    }

    function heartbeat() {
      if (running.size === 0) return null;
      const at = now();
      const elapsed = Math.round((at - startedAt) / 1000);
      const names = [...running].map(([file, since]) => `${file} (${Math.round((at - since) / 1000)}s)`);
      return `… still running (${elapsed}s): ${names.join(", ")}\n`;
    }

    function handle(event) {
      const data = event && event.data;
      if (!data) return null;
      const file = typeof data.file === "string" ? data.file : "";
      switch (event.type) {
        case "test:dequeue": {
          if (!isFileLevel(data, cwd)) return null;
          const key = display(file, paths);
          running.set(key, now());
          writeInFlight();
          return null;
        }
        case "test:complete": {
          if (!isFileLevel(data, cwd)) return null; // nested completes duplicate test:pass/fail
          const key = display(file, paths);
          const details = data.details || {};
          const passed = details.passed !== false;
          const ms = typeof details.duration_ms === "number"
            ? details.duration_ms
            : now() - (running.get(key) ?? startedAt);
          running.delete(key);
          const record = fileRecord(key);
          record.passed = passed;
          record.ms = ms;
          record.error = details.error || null;
          writeInFlight();
          // Failing files are not measured: --fast must never skip a file that
          // is currently failing.
          if (passed) measured.push({ file: key, ms });
          else failedFiles.push(key);
          if (mode !== "default" && passed) return null;
          return `${fileRows(key, record, { colour, slowMs }).join("\n")}\n`;
        }
        case "test:start": {
          const key = display(file, paths);
          const chain = chains.get(key) || [];
          chain[data.nesting] = data.name;
          chain.length = data.nesting + 1;
          chains.set(key, chain);
          return null;
        }
        case "test:pass":
        case "test:fail": {
          if (isFileLevel(data, cwd)) return null;
          const details = data.details || {};
          if (details.type !== "test" && details.type !== "suite") return null;
          const key = display(file, paths);
          const chain = (chains.get(key) || []).slice(0, data.nesting);
          const ms = typeof details.duration_ms === "number" ? details.duration_ms : 0;
          const passed = event.type === "test:pass";
          const suite = details.type === "suite";
          // Skips are only counted by Node: the mark is ours to draw.
          const skipped = data.skip !== undefined || data.todo !== undefined;
          addNode(key, { name: data.name, nesting: data.nesting, chain, ms, passed, skipped, suite });
          if (!suite && ms >= slowMs) slow.push({ file: key, chain, name: data.name, ms });
          if (!passed && details.error?.failureType !== "subtestsFailed") {
            if (!failures.has(key)) failures.set(key, []);
            failures.get(key).push({ abs: file, chain, name: data.name, error: details.error });
          }
          return null;
        }
        case "test:stderr": {
          if (typeof data.file !== "string") return null;
          const key = display(data.file, paths);
          const incoming = String(data.message ?? "").split(/\r?\n/);
          if (incoming[incoming.length - 1] === "") incoming.pop();
          const tail = stderr.get(key) || [];
          tail.push(...incoming);
          if (tail.length > STDERR_TAIL_LINES) tail.splice(0, tail.length - STDERR_TAIL_LINES);
          stderr.set(key, tail);
          return null;
        }
        case "test:summary": {
          if (data.file === undefined) totals = data; // the final aggregate only
          return null;
        }
        default:
          return null;
      }
    }

    const iterator = source[Symbol.asyncIterator]();
    const HEARTBEAT = Symbol("heartbeat");
    let pending = iterator.next();
    let sleeper = null;

    try {
      while (true) {
        if (!sleeper) {
          const elapsed = now() - startedAt;
          const mark = (Math.floor(elapsed / HEARTBEAT_MS) + 1) * HEARTBEAT_MS;
          sleeper = sleep(Math.max(1, mark - elapsed), abort.signal).then(() => HEARTBEAT);
        }
        const winner = await Promise.race([pending, sleeper]);
        if (abort.signal.aborted) break; // the consumer closed us; do not emit more
        if (winner === HEARTBEAT) {
          sleeper = null;
          maybeFlushTimings();
          const line = heartbeat();
          if (line) yield line;
          continue;
        }
        const { value, done } = winner;
        if (done) break;
        // Handle before pulling the next event: an async generator's next()
        // resumes its body synchronously, so pulling first would let the run
        // advance past state this event wrote.
        const out = handle(value);
        maybeFlushTimings();
        if (out) yield out;
        pending = iterator.next();
      }
      flushTimings();
      writeAtomic(join(resultsDir, `${label}.log`), logText());
      running.clear();
      writeInFlight();
      const lines = endLines();
      if (lines.length > 0) yield `${lines.join("\n")}\n`;
    } finally {
      abort.abort();
      try {
        flushTimings(); // a closed generator still owns the files that finished
      } catch {
        // The cache is an optimisation; a run must never fail over it.
      }
      // Not awaited: a source suspended on its own await cannot settle its
      // return(), and close must not block on it.
      try {
        const returned = typeof iterator.return === "function" ? iterator.return() : null;
        if (returned && typeof returned.catch === "function") returned.catch(() => {});
      } catch {
        // The source is already finished or broken; nothing to recover.
      }
    }
  }

  /** The abort has to fire before the pending sleep settles, and only the
   *  consumer knows when that is -- so the iterator is wrapped rather than
   *  handed out raw.
   *
   *  An arrow function on purpose: Node's reporter loader runs `new reporter()`
   *  on any default export whose prototype owns a `constructor`, and calls the
   *  result with no source. */
  return (source) => {
    const abort = new AbortController();
    const inner = run(source, abort);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (value) => inner.next(value),
      throw: (error) => inner.throw(error),
      return: async (value) => {
        abort.abort();
        const result = await inner.return(value);
        return result.done ? result : { done: true, value: result.value };
      },
    };
  };
}

export default createReporter();
