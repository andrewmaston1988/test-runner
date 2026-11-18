// Pure formatting for the reporter: rows, totals, the slow list and failure
// code frames. Nothing here reads the clock, the filesystem or the platform, so
// the reporter can render one record to stdout and to the log independently.

import { pathToFileURL } from "node:url";

import { CODES, paint } from "./colour.mjs";
import { DEFAULT_SLOW_MS } from "./config.mjs";
import { toPosix } from "./paths.mjs";

export const SLOW_TEST_LIMIT = 10;
export const PASS_MARK = "✓";
export const FAIL_MARK = "✗";
export const SKIP_MARK = "↓";

/** `SLOW_MS` from the parent, or the one default. An absent or unparseable
 *  value is the default, never zero: that would call every test slow. */
export function slowMsFrom(raw) {
  if (raw === undefined || raw === "") return DEFAULT_SLOW_MS;
  const value = Number(raw);
  return Number.isFinite(value) ? value : DEFAULT_SLOW_MS;
}

// --- Paths -----------------------------------------------------------------

// `toPosix` lives in paths.mjs: one convention for every module that names a
// file.

// --- Failures --------------------------------------------------------------

export function errorText(error) {
  if (!error) return "";
  const cause = error.cause;
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object") {
    if (typeof cause.stack === "string" && cause.stack) return cause.stack.trimEnd();
    if (typeof cause.message === "string" && cause.message) return cause.message;
  }
  if (typeof error.stack === "string" && error.stack) return error.stack.trimEnd();
  return error.code ? String(error.code) : "";
}

export function indentBlock(text) {
  return text.split(/\r?\n/).map((line) => (line ? `  ${line}` : line));
}

/** The first stack frame inside the test file: the test's own line, not the
 *  runner internals every failure shares. */
export function firstFrameIn(error, targetAbs) {
  const stack = errorText(error);
  if (!stack) return null;
  const needles = [targetAbs, toPosix(targetAbs)];
  try {
    needles.push(pathToFileURL(targetAbs).href);
  } catch {
    // A path Node cannot turn into a URL cannot appear in the stack either.
  }
  for (const line of stack.split(/\r?\n/)) {
    for (const needle of needles) {
      const at = line.indexOf(needle);
      if (at === -1) continue;
      const match = /^:(\d+):(\d+)/.exec(line.slice(at + needle.length));
      if (match) return { line: Number(match[1]), column: Number(match[2]) };
    }
  }
  return null;
}

export function codeFrameFor({ key, abs, error, fs }) {
  const frame = firstFrameIn(error, abs);
  if (!frame) return [];
  let text;
  try {
    text = String(fs.readFileSync(abs, "utf8"));
  } catch {
    return [`${key}:${frame.line}:${frame.column}`];
  }
  const source = text.split(/\r?\n/);
  const from = Math.max(1, frame.line - 2);
  const to = Math.min(source.length, frame.line + 2);
  const width = String(to).length;
  const out = [`${key}:${frame.line}:${frame.column}`];
  for (let n = from; n <= to; n++) {
    out.push(`${n === frame.line ? "> " : "  "}${String(n).padStart(width)} | ${source[n - 1]}`);
    if (n === frame.line) {
      out.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, frame.column - 1))}^`);
    }
  }
  return out;
}

// --- Formatting ------------------------------------------------------------

export function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The path a slow entry prints: a command event has no file, so its line is
 *  the chain and the name only. */
export function slowPath(entry) {
  return [entry.file, ...entry.chain, entry.name].filter((part) => part != null).join(" > ");
}

export function slowLines(slow, slowMs = DEFAULT_SLOW_MS) {
  if (slow.length === 0) return [];
  const sorted = [...slow].sort((a, b) => b.ms - a.ms).slice(0, SLOW_TEST_LIMIT);
  return [`slowest tests (over ${slowMs}ms):`, ...sorted.map((entry) => {
    return `  ${String(Math.round(entry.ms)).padStart(5)}ms  ${slowPath(entry)}`;
  })];
}

/** The reporter's summary carries `{ counts, duration_ms }`; a command run
 *  passes the plain counts with an optional duration. One wording, both shapes. */
export function totalsLines(totals, ctx = {}) {
  const counts = totals && (totals.counts || totals);
  if (!counts) return [];
  const colour = Boolean(ctx.colour);
  const failed = counts.failed ?? 0;
  const skipped = counts.skipped ?? 0;
  const todo = counts.todo ?? 0;
  const parts = [
    `${counts.tests} tests`,
    paint(colour, CODES.green, `${counts.passed} passed`),
    paint(colour && failed > 0, CODES.red, `${failed} failed`),
    paint(colour && skipped > 0, CODES.yellow, `${skipped} skipped`),
    paint(colour && todo > 0, CODES.yellow, `${todo} todo`),
  ];
  const duration = typeof totals.duration_ms === "number" ? ` -- ${seconds(totals.duration_ms)}` : "";
  return [`totals: ${parts.join(", ")}${duration}`];
}

// --- Rows ------------------------------------------------------------------

function slowMsOf(ctx) {
  return ctx.slowMs ?? DEFAULT_SLOW_MS;
}

function colouredTime(ctx, ms, text) {
  return paint(Boolean(ctx.colour), ms >= slowMsOf(ctx) ? CODES.yellow : CODES.green, text);
}

/** One row. A failed row is red throughout, time included; a skipped row is a
 *  yellow mark with no time; a passing row's time is green, or yellow at the
 *  slow threshold. */
export function row(ctx = {}, { ok, skipped = false, label, text = "", ms = 0, sep = "  " }) {
  const colour = Boolean(ctx.colour);
  if (skipped) return `${paint(colour, CODES.yellow, SKIP_MARK)} ${label}`;
  if (!ok) return paint(colour, CODES.red, `${FAIL_MARK} ${label}${text ? `${sep}${text}` : ""}`);
  const mark = paint(colour, CODES.green, PASS_MARK);
  return `${mark} ${label}${text ? `${sep}${colouredTime(ctx, ms, text)}` : ""}`;
}

/** One per-test entry of a command run's synthesized record, at the depth its
 *  chain names. A skip prints the ↓ row (`# TODO` marks a todo); `ms: null`
 *  prints no time; agent mode shows a failed row's detail -- default mode
 *  leaves that evidence to the log the run just wrote. */
function entryLines(ctx, entry, indent, agent) {
  if (entry.skip) {
    return [`${indent}${row(ctx, { ok: true, skipped: true, label: entry.skip === "todo" ? `${entry.name} # TODO` : entry.name })}`];
  }
  const ms = typeof entry.ms === "number" ? entry.ms : null;
  const lines = [`${indent}${row(ctx, {
    ok: entry.passed,
    label: entry.name,
    text: ms === null ? "" : `${Math.round(ms)}ms`,
    ms: ms ?? 0,
  })}`];
  if (agent && entry.passed === false && entry.detail) {
    for (const line of String(entry.detail).split(/\r?\n/)) lines.push(`${indent}    ${line}`);
  }
  return lines;
}

/** The rows of a command run's synthesized record `{ passed, ms, nodes }`, in
 *  file order, the record's `ms` being the run's wall time. Agent mode keeps
 *  failing rows only. */
export function testRows(record, ctx = {}) {
  const out = [];
  for (const entry of record.nodes || []) {
    const failed = entry.passed === false;
    if (ctx.agent && !failed) continue;
    out.push(...entryLines(ctx, entry, "  ".repeat((entry.chain || []).length), Boolean(ctx.agent)));
  }
  return out;
}

/** Every node in the file, parents before children, each with its depth. */
function walk(nodes, depth = 0) {
  return nodes.flatMap((node) => [{ node, depth }, ...walk(node.children || [], depth + 1)]);
}

/** One finished file's rows: its own line with its test count, then every suite
 *  and test at its depth. */
export function fileRows(key, record, ctx = {}) {
  const entries = walk(record.nodes || []);
  const count = entries.filter(({ node }) => !node.suite).length;
  const lines = [row(ctx, {
    ok: record.passed,
    label: `${key} (${count} tests)`,
    text: seconds(record.ms),
    ms: record.ms,
  })];
  for (const { node, depth } of entries) {
    lines.push(`${"  ".repeat(depth + 1)}${row(ctx, {
      ok: node.passed,
      skipped: node.skipped,
      label: node.name,
      text: `${Math.round(node.ms)}ms`,
      ms: node.ms,
    })}`);
  }
  return lines;
}
