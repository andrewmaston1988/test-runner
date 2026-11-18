// How a command run's argv reaches a process with no shell interpolating it.
//
// Node will not spawn a Windows `.cmd` or `.bat` without a shell (EINVAL since
// the 2024 batch-file fix), and `npm`, `npx` and most tool shims are exactly
// that. So on Windows the argv's first word is resolved against PATH and
// PATHEXT; a batch file runs through `cmd.exe /d /s /c` with every argument
// quoted and caret-escaped by us, and anything else spawns directly.

import * as nodeFs from "node:fs";
import { extname, isAbsolute, win32 } from "node:path";

const BATCH = new Set([".cmd", ".bat"]);

// cmd.exe truncates a command line at 8 191 characters and CreateProcess at
// 32 767; these budgets leave headroom under each.
export const ARGV_MAX = 32000;
export const CMD_ARGV_MAX = 8000;

// Every character cmd.exe treats specially outside quotes. Escaping each with a
// caret leaves cmd no quoted region to parse, so nothing in an argument can end
// the command or start another.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** The file `name` resolves to on a Windows PATH, or null. A name that
 *  already carries an extension in PATHEXT is tried as written first. */
export function resolveOnPath(name, { env = process.env, _isFile = isFile } = {}) {
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase());
  const candidates = exts.includes(extname(name).toLowerCase()) ? [name, ...exts.map((ext) => name + ext)] : exts.map((ext) => name + ext);
  const hasDir = /[\\/]/.test(name);
  const dirs = hasDir || isAbsolute(name) ? [""] : (env.PATH || env.Path || "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = dir === "" ? candidate : win32.join(dir, candidate);
      if (_isFile(full)) return full;
    }
  }
  return null;
}

function isFile(path) {
  try {
    return nodeFs.statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The character budget an argv may use. Only a batch file's first token goes
 *  through cmd.exe, so only that argv takes the smaller cap. */
export function argvLimit(argv, { platform = process.platform, env = process.env, _isFile = isFile } = {}) {
  if (platform !== "win32") return ARGV_MAX;
  const resolved = resolveOnPath(argv[0], { env, _isFile });
  return resolved && BATCH.has(extname(resolved).toLowerCase()) ? CMD_ARGV_MAX : ARGV_MAX;
}

/** One argument as `CommandLineToArgvW` reads it back, then caret-escaped for
 *  cmd.exe. A shim under `node_modules/.bin` re-parses its `%*` through cmd a
 *  second time, so its metacharacters are escaped twice. */
export function quoteForCmd(arg, { twice = false } = {}) {
  let out = String(arg)
    .replace(/(\\*)"/g, '$1$1\\"') // a quote and the backslashes before it
    .replace(/(\\*)$/, "$1$1"); // trailing backslashes, before our closing quote
  out = `"${out}"`.replace(CMD_META, "^$1");
  return twice ? out.replace(CMD_META, "^$1") : out;
}

/** `{ file, args, options }` for `child_process.spawn`: the argv itself, or the
 *  cmd.exe route for a batch file. `options` carries only what the route needs;
 *  the caller adds cwd, env and stdio. */
export function commandSpawn(argv, { platform = process.platform, env = process.env, _isFile = isFile } = {}) {
  const [name, ...rest] = argv;
  if (platform !== "win32") return { file: name, args: rest, options: {} };
  const resolved = resolveOnPath(name, { env, _isFile });
  if (!resolved) return { file: name, args: rest, options: {} };
  if (!BATCH.has(extname(resolved).toLowerCase())) return { file: resolved, args: rest, options: {} };
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [resolved.replace(CMD_META, "^$1"), ...rest.map((arg) => quoteForCmd(arg, { twice }))].join(" ");
  return {
    file: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
