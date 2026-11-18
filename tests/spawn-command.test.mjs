// How a command run's argv becomes a spawn: direct everywhere except a Windows
// batch file, which goes through cmd.exe with every argument quoted by us.
// The real cmd.exe round trip is in spawn-command.win.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { argvLimit, commandSpawn, quoteForCmd, resolveOnPath } from "../src/spawn-command.mjs";

const ENV = { PATH: "C:\\tools;C:\\node", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
const onDisk = (...files) => (path) => files.includes(path);

test("off Windows the argv spawns as written", () => {
  assert.deepEqual(commandSpawn(["cargo", "test", "a b"], { platform: "linux" }), {
    file: "cargo", args: ["test", "a b"], options: {},
  });
});

test("a name resolves through PATH and PATHEXT, in PATH order", () => {
  const isFile = onDisk("C:\\node\\npm.cmd", "C:\\tools\\cargo.exe");
  assert.equal(resolveOnPath("npm", { env: ENV, _isFile: isFile }), "C:\\node\\npm.cmd");
  assert.equal(resolveOnPath("cargo", { env: ENV, _isFile: isFile }), "C:\\tools\\cargo.exe");
  assert.equal(resolveOnPath("missing", { env: ENV, _isFile: isFile }), null);
});

test("an .exe on Windows spawns directly, by its resolved path", () => {
  const spawnSpec = commandSpawn(["cargo", "test"], { platform: "win32", env: ENV, _isFile: onDisk("C:\\tools\\cargo.exe") });
  assert.deepEqual(spawnSpec, { file: "C:\\tools\\cargo.exe", args: ["test"], options: {} });
});

test("a .cmd on Windows runs through cmd.exe /d /s /c with verbatim arguments", () => {
  const spawnSpec = commandSpawn(["npm", "run", "a & b"], { platform: "win32", env: ENV, _isFile: onDisk("C:\\node\\npm.cmd") });
  assert.equal(spawnSpec.file, ENV.ComSpec);
  assert.deepEqual(spawnSpec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(spawnSpec.options.windowsVerbatimArguments, true);
  const line = spawnSpec.args[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'), line);
  assert.ok(!/(^|[^^])&/.test(line), `an unescaped & reached cmd: ${line}`);
});

test("an unresolvable name is spawned as written, so the error names it", () => {
  assert.deepEqual(commandSpawn(["nope"], { platform: "win32", env: ENV, _isFile: () => false }), {
    file: "nope", args: [], options: {},
  });
});

test("quoting doubles backslashes before a quote and escapes every cmd metacharacter", () => {
  assert.equal(quoteForCmd("plain"), '^"plain^"');
  assert.equal(quoteForCmd('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(quoteForCmd("dir\\"), '^"dir\\\\^"');
  assert.equal(quoteForCmd("a&b"), '^"a^&b^"');
  assert.equal(quoteForCmd("a&b", { twice: true }), '^^^"a^^^&b^^^"');
});

test("a batch first token caps at cmd.exe's 8,191, a direct spawn at CreateProcess's 32,767", () => {
  const batch = "C:\\node\\npm.cmd";
  const win = { platform: "win32", env: ENV, _isFile: (path) => path === batch };
  const argvOf = (first, total) => [first, "x".repeat(total - first.length - 1)];
  const fits = (argv, opts) => argv.join(" ").length <= argvLimit(argv, opts);

  assert.equal(fits(argvOf("npm", 7000), win), true, "7,000 characters did not fit under 8,191");
  assert.equal(fits(argvOf("npm", 9000), win), false, "9,000 characters were accepted for cmd.exe");
  assert.equal(fits(argvOf("python", 9000), win), true, "a direct spawn was capped at cmd.exe's limit");
  assert.equal(fits(argvOf("python", 30000), win), true, "30,000 characters did not fit under 32,767");
  assert.equal(fits(argvOf("python", 33000), win), false, "33,000 characters were accepted by CreateProcess");
  assert.equal(fits(argvOf("python", 30000), { platform: "linux", env: ENV }), true);
});
