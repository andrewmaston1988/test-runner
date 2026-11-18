// R3/R4/R6: the row builder, the totals line and the slow heading. Pure
// formatting, so the thresholds are asserted against the skills literal 300 --
// never against this package's own constant, so mutating the constant bites.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CODES, RESET } from "../src/colour.mjs";
import { fileRows, row, slowLines, testRows, totalsLines } from "../src/render.mjs";

const on = { colour: true };
const green = (text) => `${CODES.green}${text}${RESET}`;
const red = (text) => `${CODES.red}${text}${RESET}`;
const yellow = (text) => `${CODES.yellow}${text}${RESET}`;

const testRow = (ms, ctx = on) => row(ctx, { ok: true, label: "a test", text: `${ms}ms`, ms });

test("with no slowMs the default boundary is 299 green and 300 yellow", () => {
  assert.ok(testRow(299).includes(green("299ms")), testRow(299));
  assert.ok(testRow(300).includes(yellow("300ms")), testRow(300));
});

test("an explicit slowMs moves the boundary", () => {
  const ctx = { colour: true, slowMs: 1000 };
  assert.ok(testRow(999, ctx).includes(green("999ms")), testRow(999, ctx));
  assert.ok(testRow(1000, ctx).includes(yellow("1000ms")), testRow(1000, ctx));
});

test("a file row's time follows the same threshold", () => {
  const [fast] = fileRows("tests/a.test.mjs", { passed: true, ms: 299, nodes: [] }, on);
  const [slow] = fileRows("tests/a.test.mjs", { passed: true, ms: 300, nodes: [] }, on);
  assert.equal(fast, `${green("✓")} tests/a.test.mjs (0 tests)  ${green("0.3s")}`);
  assert.equal(slow, `${green("✓")} tests/a.test.mjs (0 tests)  ${yellow("0.3s")}`);
});

test("a failed row is red throughout, mark and time included", () => {
  const out = row(on, { ok: false, label: "it breaks", text: "12ms", ms: 12 });
  assert.equal(out, red("✗ it breaks  12ms"));
  assert.ok(!out.includes(CODES.green), out);
  assert.ok(!out.includes(CODES.yellow), out);
  // Slow does not make a failure yellow: the row's outcome outranks its time.
  assert.equal(row(on, { ok: false, label: "it crawls", text: "5000ms", ms: 5000 }), red("✗ it crawls  5000ms"));
});

test("totals colour passed green, and failed/skipped/todo only when non-zero", () => {
  const [line] = totalsLines(
    { counts: { tests: 5, passed: 3, failed: 1, skipped: 2, todo: 1 }, duration_ms: 1200 },
    on,
  );
  assert.ok(line.includes(green("3 passed")), line);
  assert.ok(line.includes(red("1 failed")), line);
  assert.ok(line.includes(yellow("2 skipped")), line);
  assert.ok(line.includes(yellow("1 todo")), line);
  assert.ok(line.endsWith(" -- 1.2s"), "the duration stays plain");

  const [clean] = totalsLines(
    { counts: { tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }, duration_ms: 500 },
    on,
  );
  assert.ok(clean.includes(green("2 passed")), clean);
  assert.ok(clean.includes("0 failed") && !clean.includes(red("0 failed")), clean);
  assert.ok(clean.includes("0 skipped") && !clean.includes(yellow("0 skipped")), clean);
  assert.ok(clean.includes("0 todo") && !clean.includes(yellow("0 todo")), clean);
});

test("with colour off the totals line carries no ANSI", () => {
  const [line] = totalsLines(
    { counts: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0 } },
    { colour: false },
  );
  assert.equal(line, "totals: 1 tests, 1 passed, 0 failed, 0 skipped, 0 todo");
});

test("the slow heading names the caller's threshold", () => {
  const entry = { file: "tests/a.test.mjs", chain: [], name: "slow", ms: 300 };
  assert.equal(slowLines([entry], 300)[0], "slowest tests (over 300ms):");
  assert.equal(slowLines([entry], 150)[0], "slowest tests (over 150ms):");
  assert.deepEqual(slowLines([], 300), []);
});

test("a command event has no file, so the slow entry prints without a file segment", () => {
  const lines = slowLines([{ chain: [], name: "slow", ms: 350 }], 300);
  assert.deepEqual(lines, ["slowest tests (over 300ms):", "    350ms  slow"]);
  assert.deepEqual(
    slowLines([{ chain: ["parent"], name: "slow", ms: 350 }], 300)[1],
    "    350ms  parent > slow",
  );
});

// --- R6 command-run halves: entries with skip, detail and un-timed rows -----

test("an entry's skip field prints the ↓ row and a todo is distinct from a skip", () => {
  const record = { passed: true, ms: 5, nodes: [
    { name: "skipped one", chain: [], ms: 12, passed: true, skip: "skip" },
    { name: "todo one", chain: [], ms: 3, passed: true, skip: "todo" },
  ] };
  assert.deepEqual(testRows(record, { colour: false }), [
    "↓ skipped one",
    "↓ todo one # TODO",
  ]);
});

test("a chain indents an entry, and file order is kept with the child printed first", () => {
  const record = { passed: true, ms: 5, nodes: [
    { name: "child", chain: ["parent"], ms: 1, passed: true },
    { name: "parent", chain: [], ms: 2, passed: true },
  ] };
  assert.deepEqual(testRows(record, { colour: false }), [
    "  ✓ child  1ms",
    "✓ parent  2ms",
  ]);
});

test("an un-timed entry (ms: null) prints no time", () => {
  const record = { passed: true, ms: 5, nodes: [
    { name: "adds", chain: [], ms: null, passed: true },
    { name: "f", chain: [], ms: null, passed: false },
  ] };
  assert.deepEqual(testRows(record, { colour: false }), ["✓ adds", "✗ f"]);
});

test("agent mode keeps only failing rows, each with its detail under it", () => {
  const record = { passed: false, ms: 5, nodes: [
    { name: "adds", chain: [], ms: 4, passed: true },
    { name: "f", chain: [], ms: 6, passed: false, detail: "expected: 'two'\nactual: 'one'" },
    { name: "s", chain: [], ms: 1, passed: true, skip: "skip" },
  ] };
  assert.deepEqual(testRows(record, { colour: false, agent: true }), [
    "✗ f  6ms",
    "    expected: 'two'",
    "    actual: 'one'",
  ]);
});

test("default mode prints every row and no detail; the log and the tee carry the evidence", () => {
  const record = { passed: false, ms: 5, nodes: [
    { name: "f", chain: [], ms: 6, passed: false, detail: "boom" },
  ] };
  assert.deepEqual(testRows(record, { colour: false }), ["✗ f  6ms"]);
});

test("the >= slow boundary holds for entry rows with a caller-supplied threshold", () => {
  const rowFor = (ms, slowMs) => testRows({ passed: true, ms, nodes: [
    { name: "one", chain: [], ms, passed: true },
  ] }, { colour: true, slowMs })[0];
  assert.ok(rowFor(300, 300).includes(yellow("300ms")), rowFor(300, 300));
  assert.ok(rowFor(299, 300).includes(green("299ms")), rowFor(299, 300));
});

test("the totals export takes the plain counts and the caller's colour", () => {
  const [line] = totalsLines(
    { tests: 4, passed: 2, failed: 1, skipped: 1, todo: 0, duration_ms: 1500 },
    on,
  );
  assert.ok(line.startsWith("totals: 4 tests, "), line);
  assert.ok(line.includes(green("2 passed")), line);
  assert.ok(line.includes(red("1 failed")), line);
  assert.ok(line.includes(yellow("1 skipped")), line);
  assert.ok(line.endsWith(" -- 1.5s"), line);
  const [plain] = totalsLines(
    { tests: 4, passed: 2, failed: 1, skipped: 1, todo: 0 },
    { colour: false },
  );
  assert.equal(plain, "totals: 4 tests, 2 passed, 1 failed, 1 skipped, 0 todo");
});

test("fileRows prints the count and every suite and test at its depth", () => {
  const record = {
    passed: true,
    ms: 1200,
    nodes: [
      {
        name: "outer", nesting: 0, suite: true, passed: true, skipped: false, ms: 900,
        children: [
          {
            name: "inner", nesting: 1, suite: true, passed: true, skipped: false, ms: 800,
            children: [
              { name: "deep", nesting: 2, suite: false, passed: true, skipped: false, ms: 10, children: [] },
            ],
          },
        ],
      },
      { name: "skipped", nesting: 0, suite: false, passed: true, skipped: true, ms: 0, children: [] },
    ],
  };
  assert.deepEqual(fileRows("tests/a.test.mjs", record, { colour: false }), [
    "✓ tests/a.test.mjs (2 tests)  1.2s",
    "  ✓ outer  900ms",
    "    ✓ inner  800ms",
    "      ✓ deep  10ms",
    "  ↓ skipped",
  ]);
});
