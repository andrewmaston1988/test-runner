// R2: when colour is on. The parent resolves it once, so this is the only
// place the rule is exercised; the reporter reads TEST_COLOUR and never
// re-derives it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CODES, RESET, paint, resolveColour } from "../src/colour.mjs";

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("a user-set FORCE_COLOR decides, whatever the stream is", () => {
  assert.equal(resolveColour({ env: { FORCE_COLOR: "0" }, stream: tty }), false);
  for (const value of ["1", "", "true", "2"]) {
    assert.equal(resolveColour({ env: { FORCE_COLOR: value }, stream: pipe }), true, `FORCE_COLOR=${value}`);
  }
});

test("agent mode is plain unless the user forced colour", () => {
  assert.equal(resolveColour({ env: { CLAUDECODE: "1" }, stream: tty, mode: "agent" }), false);
  assert.equal(
    resolveColour({ env: { FORCE_COLOR: "1", CLAUDECODE: "1" }, stream: pipe, mode: "agent" }),
    true,
    "an explicit FORCE_COLOR must beat agent mode",
  );
});

test("NO_COLOR turns colour off, and FORCE_COLOR beats it when both are set", () => {
  assert.equal(resolveColour({ env: { NO_COLOR: "1" }, stream: tty }), false);
  assert.equal(resolveColour({ env: { FORCE_COLOR: "1", NO_COLOR: "1" }, stream: pipe }), true);
  assert.equal(resolveColour({ env: { NO_COLOR: "" }, stream: tty }), true, "an empty NO_COLOR is not set");
});

test("otherwise a TTY or CI", () => {
  assert.equal(resolveColour({ env: {}, stream: tty }), true);
  assert.equal(resolveColour({ env: {}, stream: pipe }), false);
  assert.equal(resolveColour({ env: { CI: "1" }, stream: pipe }), true);
  assert.equal(resolveColour({ env: {}, stream: null }), false, "no stream is no TTY");
});

test("paint wraps only when colour is on, and resets the foreground alone", () => {
  assert.equal(paint(true, CODES.green, "ok"), "\x1b[32mok\x1b[39m");
  assert.equal(paint(false, CODES.green, "ok"), "ok");
  assert.equal(RESET, "\x1b[39m");
});
