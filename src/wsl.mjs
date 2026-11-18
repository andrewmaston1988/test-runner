// WSL mode: mirror the working tree onto the configured distro's ext4 disk,
// then run the suite there. Linux-only failures surface before the PR instead
// of in CI. The distro and its setup text come from the config's `wsl` block.

// The mirror is a git clone of the repository's COMMON dir (`--git-common-dir`,
// so a linked worktree works) plus an rsync of the tree that is running now.
// /mnt/c reports every file as mode 777, so the rsync copies no permissions
// (-rlt, never -a) and the clone keeps git's own modes; with `-a` every file
// reads as mode-dirty in the mirror.

// Every wsl.exe call is an argument array, built by `wslArgv` below: wsl.exe
// re-quotes a single command string, which mangles it.

// Exit codes: the suite's own code, or 2 when WSL mode could not run at all.

import { MIRROR_PACKAGE } from "./graph.mjs";

/** What a missing distro prints: the config's own setup text, then the check. */
export function setupPointer({ distro, setup = "" }) {
  const lines = setup.trim() ? setup.trim().split("\n").map((line) => `  ${line}`) : [];
  const body = lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
  return `[wsl] the WSL distro "${distro}" is not installed.${body}

  Then check it is listed:

      wsl.exe -l -q
`;
}

/** `C:\a\b` and `C:/a/b` -> `/mnt/c/a/b`. Anything already POSIX comes back
 *  as written, so a Linux path survives a round trip. */
export function toWslPath(winPath) {
  const path = String(winPath).replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(\/|$)/.exec(path);
  if (!drive) return path;
  return `/mnt/${drive[1].toLowerCase()}${path.slice(2) || "/"}`;
}

/** `wsl.exe -l -q` prints UTF-16LE on Windows and has printed UTF-8 on older
 *  builds. A NUL in every odd byte is the tell (a leading BOM is the other),
 *  so detect rather than assume. */
export function distroList(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""), "utf8");
  return bytes
    .toString(isUtf16Le(bytes) ? "utf16le" : "utf8")
    .replace(/\uFEFF/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, "").trim())
    .filter(Boolean);
}

function isUtf16Le(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return true;
  const probe = Math.min(bytes.length, 64);
  if (probe < 2) return false;
  for (let i = 1; i < probe; i += 2) if (bytes[i] !== 0) return false;
  return true;
}

function text(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value ?? "");
}

function isAbsolutePath(path) {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path);
}

/** `--git-common-dir` prints an absolute path from a linked worktree and a
 *  bare `.git` from the main checkout; both name the same directory. */
function commonDirOf(commonDir, repoRoot) {
  if (isAbsolutePath(commonDir)) return commonDir;
  return `${String(repoRoot).replace(/[\\/]+$/, "")}/${commonDir}`;
}

/** `.../<repo>/.git` -> `<repo>`, which is the mirror's name. */
function repoNameOf(commonDir) {
  const parts = String(commonDir).replace(/[\\/]+$/, "").split(/[\\/]/);
  if (parts[parts.length - 1] === ".git") parts.pop();
  return parts[parts.length - 1] || "repo";
}


/** `~` and `~/x` against the distro's home; anything else as written. */
function expandHome(entry, home) {
  if (entry === "~") return home;
  return entry.startsWith("~/") ? `${home}/${entry.slice(2)}` : entry;
}

/** The argv every wsl.exe call is built from: `-d <distro> [--cd <dir>] -e
 *  <argv…>`. `-e` runs the argv with no shell, so no argument is re-parsed;
 *  `--` would hand the joined line to the distro's shell instead. */
export function wslArgv({ distro, cd }, argv) {
  return ["-d", distro, ...(cd ? ["--cd", cd] : []), "-e", ...argv];
}

/** Mirror `repoRoot`, copy this package into it and run it with `runnerArgs`;
 *  resolves to that run's exit code, or 2 when it never ran. `wsl.exe --cd`
 *  and `-e` start no login shell, so `~/.cargo/bin` is not on PATH: every
 *  mirror run gets `wsl.path` prepended, and `wsl.requires` is checked before
 *  any sync. */
export async function runWsl({
  repoRoot, packageDir, runnerArgs, wsl: wslConfig, colour = false, _spawnSync, _fs,
  _env = process.env, log,
  err = (text) => process.stderr.write(text),
}) {
  const DISTRO = wslConfig.distro;
  const wslExe = (argv, opts = {}) => {
    const r = _spawnSync("wsl.exe", argv, { encoding: "buffer", ...opts });
    return {
      status: r && typeof r.status === "number" ? r.status : 1,
      stdout: Buffer.isBuffer(r?.stdout) ? r.stdout : Buffer.from(text(r?.stdout), "utf8"),
      stderr: text(r?.stderr),
    };
  };
  const local = (args) => {
    const r = _spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    return {
      status: r && typeof r.status === "number" ? r.status : 1,
      stdout: text(r?.stdout),
      stderr: text(r?.stderr),
    };
  };
  const inDistro = (...argv) => wslArgv({ distro: DISTRO }, argv);
  const at = (dir, ...argv) => wslArgv({ distro: DISTRO, cd: dir }, argv);
  const run = (label, argv) => {
    const r = wslExe(argv);
    if (r.status !== 0) {
      err(`[wsl] ${label} failed (exit ${r.status})\n${r.stderr.trim()}\n`);
    }
    return r.status;
  };

  if (!distroList(wslExe(["-l", "-q"]).stdout).includes(DISTRO)) {
    err(setupPointer(wslConfig));
    return 2;
  }
  if (!_fs.existsSync(repoRoot)) {
    err(`[wsl] repository root not found: ${repoRoot}\n`);
    return 2;
  }

  const head = local(["rev-parse", "HEAD"]);
  const common = local(["rev-parse", "--git-common-dir"]);
  if (head.status !== 0 || common.status !== 0) {
    err(`[wsl] cannot read the repository at ${repoRoot}\n`);
    return 2;
  }
  const sourceUrl = toWslPath(commonDirOf(common.stdout.trim(), repoRoot));
  const name = repoNameOf(sourceUrl);

  const homeResult = wslExe(inDistro("printenv", "HOME"));
  const home = text(homeResult.stdout).trim().replace(/\/+$/, "");
  const pathResult = wslExe(inDistro("printenv", "PATH"));
  if (homeResult.status !== 0 || home === "" || pathResult.status !== 0) {
    err(`[wsl] cannot read the home directory and PATH in ${DISTRO}\n`);
    return 2;
  }
  const extra = (wslConfig.path || []).map((entry) => expandHome(entry, home));
  const pathValue = [...extra, text(pathResult.stdout).trim()].filter(Boolean).join(":");
  const withPath = (...argv) => ["env", `PATH=${pathValue}`, ...argv];

  // The script is a constant and the tool name its positional argument, so
  // nothing from the config is ever parsed by the shell.
  for (const tool of wslConfig.requires || []) {
    if (wslExe(inDistro(...withPath("sh", "-c", 'command -v -- "$1"', "requires", tool))).status !== 0) {
      err(`[wsl] ${tool} is not on PATH in ${DISTRO}; install it, or add its directory to wsl.path\n`);
      return 2;
    }
  }

  const mirror = `${home}/mirror/${name}`;

  // A mirror holding some other checkout would fetch from the wrong remote and
  // never see a local commit. Nothing in a mirror is worth keeping, so replace
  // it rather than fail.
  const origin = wslExe(at(mirror, "git", "config", "--get", "remote.origin.url"));
  if (!(origin.status === 0 && text(origin.stdout).trim() === sourceUrl)) {
    if (run(`mkdir -p ${home}/mirror`, inDistro("mkdir", "-p", `${home}/mirror`)) !== 0) return 2;
    if (wslExe(inDistro("test", "-d", mirror)).status === 0) {
      log(`wsl: replacing ${mirror}: not a clone of ${sourceUrl}`);
      if (run(`removing ${mirror}`, inDistro("rm", "-rf", mirror)) !== 0) return 2;
    }
    log(`wsl: cloning ${sourceUrl} -> ${mirror} (first sync)`);
    if (run("git clone", inDistro("git", "clone", "--quiet", sourceUrl, mirror)) !== 0) return 2;
    if (run("core.fileMode false", at(mirror, "git", "config", "core.fileMode", "false")) !== 0) {
      return 2;
    }
  }

  const sha = head.stdout.trim();
  log(`wsl: syncing ${repoRoot} -> ${mirror} at ${sha.slice(0, 8)}`);
  if (run("git fetch", at(mirror, "git", "fetch", "--quiet", "origin")) !== 0) return 2;
  // Forced: the last sync's rsync left tracked files dirty, and a plain
  // checkout then refuses to move HEAD. The mirror holds nothing of its own.
  if (run("git checkout", at(mirror, "git", "checkout", "--force", "--detach", sha)) !== 0) return 2;
  // `--delete` leaves an excluded path alone, which is what keeps a build
  // cache (`wsl.keep`), the install and the package copy across syncs.
  const keep = [".git", "node_modules", MIRROR_PACKAGE, ...(wslConfig.keep || [])];
  const source = `${toWslPath(repoRoot).replace(/\/+$/, "")}/`;
  const rsync = ["rsync", "-rlt", "--delete", ...keep.flatMap((path) => ["--exclude", path]), source, `${mirror}/`];
  if (run("rsync", inDistro(...rsync)) !== 0) return 2;

  // The mirror runs this package, not the consumer's installed copy: zero
  // dependencies make the directory complete, and it pins the host's version.
  const pkg = `${toWslPath(packageDir).replace(/\/+$/, "")}/`;
  const copy = ["rsync", "-rlt", "--delete", "--exclude", ".git", "--exclude", "node_modules", "--exclude", "test-results",
    pkg, `${mirror}/${MIRROR_PACKAGE}/`];
  if (run("package copy", inDistro(...copy)) !== 0) return 2;

  const command = withPath("node", `${MIRROR_PACKAGE}/bin/test-runner.mjs`, ...runnerArgs);
  log(`wsl: running ${command.slice(2).join(" ")} in ${mirror}`);
  // The parent resolved colour once; WSLENV is the only way a variable crosses
  // into a `wsl.exe -e` child, and an existing list must survive it.
  const forwarded = _env.WSLENV ? `${_env.WSLENV}:` : "";
  const r = _spawnSync("wsl.exe", at(mirror, ...command), {
    stdio: "inherit",
    env: { ..._env, TEST_COLOUR: colour ? "1" : "0", WSLENV: `${forwarded}TEST_COLOUR/u` },
  });
  return r && typeof r.status === "number" ? r.status : 1;
}
