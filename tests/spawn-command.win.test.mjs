// A8 on a real Windows host: a `.cmd` tool runs from an argv-only command, and
// an argument holding cmd.exe's own metacharacters arrives as one argument.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandSpawn } from "../src/spawn-command.mjs";

const skip = process.platform !== "win32" && "a Windows batch file needs a Windows host";

function run(argv, env = process.env) {
  const { file, args, options } = commandSpawn(argv, { platform: "win32", env });
  return spawnSync(file, args, { encoding: "utf8", env, ...options });
}

test("A8: npm, a .cmd shim, runs from an argv with no shell", { skip }, () => {
  const r = run(["npm", "--version"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("A8: an argument with & and quotes reaches a .cmd as one argument", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "echo-args.cmd"),
    `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`,
  );
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
  const r = run(["echo-args", "a & echo SECOND", 'say "hi"', "plain"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ["a & echo SECOND", 'say "hi"', "plain"]);
  assert.doesNotMatch(r.stdout, /^SECOND/m, "cmd.exe ran the second command");
});
