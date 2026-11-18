// The WSL mirror's fixture plumbing, shared by its two test files.
//
// A fake spawnSync records every call, so the mirror's step ORDER and the
// ARGUMENT-ARRAY shape of each wsl.exe call are both asserted without a distro.
// Real distro behaviour is the main session's smoke run.
//
// This lives beside the tests rather than in `helpers.mjs` because only the WSL
// tests need it.

import { runWsl } from "../src/wsl.mjs";

export const DISTRO = "ubuntu";
export const WSL = { distro: DISTRO, setup: 'TESTING.md, section "The ubuntu distro", has the commands.' };

export const HEAD = "8aac8ba6e100a08c1aa33c9286aeecd45a21bf36";
export const REPO_ROOT = "C:\\code\\consumer";
export const PACKAGE_DIR = "C:\\code\\consumer\\node_modules\\test-runner";
export const HOME = "/home/ubuntu";
export const DISTRO_PATH = "/usr/bin:/bin";
export const MIRROR = `${HOME}/mirror/consumer`;
export const SOURCE = "/mnt/c/code/consumer/.git";
export const TREE = "/mnt/c/code/consumer/";
export const RUNNER_ARGS = ["--all", "--mirror"];
export const RUN = ["env", `PATH=${DISTRO_PATH}`, "node", ".test-runner/bin/test-runner.mjs", ...RUNNER_ARGS];
export const PACKAGE_COPY = ["rsync", "-rlt", "--delete", "--exclude", ".git", "--exclude", "node_modules", "--exclude",
  "test-results", "/mnt/c/code/consumer/node_modules/test-runner/", `${MIRROR}/.test-runner/`];

export const plain = (...argv) => ["-d", DISTRO, "--", ...argv];
export const inMirror = (...argv) => ["-d", DISTRO, "--cd", MIRROR, "--", ...argv];

/** Records every spawn and answers with scripted results. */
export function makeFake(options = {}) {
  const {
    distros = ["docker-desktop", DISTRO],
    listEncoding = "utf16le",
    head = HEAD,
    commonDir = "C:/code/consumer/.git",
    onPath = [],
    home = HOME,
    mirrorOrigin = null,
    mirrorExists = false,
    runStatus = 0,
    failOn = null,
  } = options;
  const calls = [];

  const spawn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const line = args.join(" ");
    if (cmd === "git") {
      if (line === "rev-parse --show-toplevel") return { status: 0, stdout: `${REPO_ROOT}\n` };
      if (line === "rev-parse HEAD") return { status: 0, stdout: `${head}\n` };
      if (line === "rev-parse --git-common-dir") return { status: 0, stdout: `${commonDir}\n` };
      throw new Error(`unexpected local git call: ${line}`);
    }
    if (cmd !== "wsl.exe") throw new Error(`unexpected command: ${cmd}`);
    if (line === "-l -q") {
      const list = distros.length ? `${distros.join("\r\n")}\r\n` : "";
      return { status: 0, stdout: Buffer.from(list, listEncoding) };
    }

    const inner = args.slice(args.indexOf("--") + 1).join(" ");
    const step = (value) => (failOn && inner.startsWith(failOn) ? { status: 1, stderr: "boom\n" } : value);
    if (inner === "printenv HOME") return step({ status: 0, stdout: Buffer.from(`${home}\n`) });
    if (inner === "printenv PATH") return step({ status: 0, stdout: Buffer.from(`${DISTRO_PATH}\n`) });
    if (inner.includes(" sh -c ")) return { status: onPath.includes(args[args.length - 1]) ? 0 : 1 };
    if (inner === "git config --get remote.origin.url") {
      return mirrorOrigin === null
        ? { status: 1, stderr: "fatal: not a git repository\n" }
        : step({ status: 0, stdout: Buffer.from(`${mirrorOrigin}\n`) });
    }
    if (inner.startsWith("mkdir -p ")) return step({ status: 0 });
    if (inner.startsWith("test -d ")) return { status: mirrorExists ? 0 : 1 };
    if (inner.startsWith("rm -rf ")) return step({ status: 0 });
    if (inner.startsWith("git clone ")) return step({ status: 0 });
    if (inner === "git config core.fileMode false") return step({ status: 0 });
    if (inner === "git fetch --quiet origin") return step({ status: 0 });
    if (inner.startsWith("git checkout ")) return step({ status: 0 });
    if (inner.startsWith("rsync ")) return step({ status: 0 });
    if (inner.startsWith("env PATH=") && inner.includes(" node ")) return { status: runStatus };
    throw new Error(`unexpected wsl.exe call: ${line}`);
  };

  const innerLines = () =>
    calls
      .filter((c) => c.cmd === "wsl.exe")
      .map((c) => c.args.slice(c.args.indexOf("--") + 1).join(" "));
  return { spawn, calls, innerLines };
}

export function makeFs(exists = true) {
  return { existsSync: () => exists };
}

/** `process.stderr` is the only place the module reports a refusal, so the
 *  test reads it there rather than taking a second injected writer. */
export async function withStderr(fn) {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    const result = await fn();
    return { result, stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

export async function run(fake, options = {}) {
  const logs = [];
  const code = await runWsl({
    repoRoot: options.repoRoot ?? REPO_ROOT,
    packageDir: PACKAGE_DIR,
    runnerArgs: options.runnerArgs ?? RUNNER_ARGS,
    wsl: options.wsl ?? WSL,
    colour: options.colour ?? false,
    _spawnSync: fake.spawn,
    _fs: makeFs(options.repoExists ?? true),
    _env: options.env ?? {},
    log: (line) => logs.push(line),
  });
  return { code, logs };
}
