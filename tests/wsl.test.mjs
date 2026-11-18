// Tests for WSL mode (`src/wsl.mjs`) and the `--wsl` flag: the sync's step
// order, path conversion and the clone source. The fake spawnSync and the
// mirror's fixtures live in `wsl-harness.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import { distroList, setupPointer, toWslPath } from "../src/wsl.mjs";
import { configOf } from "./helpers.mjs";
import {
  DISTRO_PATH,
  HEAD,
  HOME,
  MIRROR,
  PACKAGE_COPY,
  RUN,
  SOURCE,
  TREE,
  WSL,
  inMirror,
  makeFake,
  plain,
  run,
  withStderr,
} from "./wsl-harness.mjs";

test("--wsl rejects a selection flag instead of silently running everything", async () => {
  const flags = [
    [["--wsl", "--list"], "--list"],
    [["--wsl", "--suite", "repo"], "--suite"],
    [["--wsl", "--all"], "--all"],
    [["--wsl", "--against", "master"], "--against"],
  ];
  for (const [argv, flag] of flags) {
    const errors = [];
    const refuse = () => {
      throw new Error(`a rejected combination spawned a process: ${argv.join(" ")}`);
    };
    const code = await main(argv, {
      _spawn: refuse,
      _spawnSync: refuse,
      _config: configOf([{ name: "repo", runs: [] }]),
      _log: () => {},
      _err: (line) => errors.push(line),
    });
    assert.equal(code, 2, argv.join(" "));
    assert.ok(errors.join("\n").includes(`--wsl cannot be combined with ${flag}`), argv.join(" "));
  }
});

test("a distro missing from the list exits 2 and prints the config's setup text", async () => {
  const fake = makeFake({ distros: ["docker-desktop"] });
  const { result: code, stderr } = await withStderr(async () => (await run(fake)).code);

  assert.equal(code, 2);
  assert.match(stderr, /TESTING\.md/);
  assert.match(stderr, /the WSL distro "ubuntu" is not installed/);
  assert.equal(setupPointer(WSL).includes("TESTING.md"), true, "the pointer must carry the config's setup text");
  assert.deepEqual(
    fake.calls.map((c) => c.args),
    [["-l", "-q"]],
    "nothing may be spawned once the distro is known to be missing",
  );
});

test("the distro list decodes from UTF-16LE and from plain UTF-8", () => {
  const utf16 = Buffer.from("docker-desktop\r\nubuntu\r\n", "utf16le");
  assert.deepEqual(distroList(utf16), ["docker-desktop", "ubuntu"]);
  assert.deepEqual(
    distroList(Buffer.from("docker-desktop\nubuntu\n", "utf8")),
    ["docker-desktop", "ubuntu"],
  );
  assert.deepEqual(distroList(Buffer.from("")), []);
  assert.deepEqual(distroList(Buffer.from("\uFEFFubuntu\r\n", "utf16le")), ["ubuntu"]);
});

test("a first sync clones, pins the checkout, rsyncs, copies the package and then runs it", async () => {
  const fake = makeFake();
  const { code, logs } = await run(fake);

  assert.equal(code, 0);
  assert.deepEqual(
    fake.calls.filter((c) => c.cmd === "wsl.exe").map((c) => c.args),
    [
      ["-l", "-q"],
      plain("printenv", "HOME"),
      plain("printenv", "PATH"),
      inMirror("git", "config", "--get", "remote.origin.url"),
      plain("mkdir", "-p", `${HOME}/mirror`),
      plain("test", "-d", MIRROR),
      plain("git", "clone", "--quiet", SOURCE, MIRROR),
      inMirror("git", "config", "core.fileMode", "false"),
      inMirror("git", "fetch", "--quiet", "origin"),
      inMirror("git", "checkout", "--force", "--detach", HEAD),
      plain(
        "rsync",
        "-rlt",
        "--delete",
        "--exclude",
        ".git",
        "--exclude",
        "node_modules",
        "--exclude",
        ".test-runner",
        TREE,
        `${MIRROR}/`,
      ),
      plain(...PACKAGE_COPY),
      inMirror(...RUN),
    ],
  );
  assert.ok(logs.length > 0, "the caller wants progress lines");
});

test("a mirror already cloned from this repo syncs without cloning again", async () => {
  const fake = makeFake({ mirrorOrigin: SOURCE, mirrorExists: true });
  const { code } = await run(fake);

  assert.equal(code, 0);
  const lines = fake.innerLines();
  assert.ok(!lines.some((l) => l.startsWith("git clone")), lines.join("\n"));
  assert.ok(!lines.some((l) => l === "git config core.fileMode false"), "fileMode is set at clone time");
  assert.ok(!lines.some((l) => l.startsWith("rm -rf")), "a usable mirror must never be deleted");
  assert.ok(lines.includes("git fetch --quiet origin"));
  assert.ok(lines.some((l) => l.startsWith("git checkout --force --detach ")));
  assert.ok(lines.some((l) => l.startsWith("rsync -rlt ")));
  assert.equal(lines[lines.length - 1], RUN.join(" "));
});

test("a mirror cloned from another remote is replaced, not reused", async () => {
  const fake = makeFake({
    mirrorOrigin: "https://github.com/someone/else.git",
    mirrorExists: true,
  });
  const { code } = await run(fake);

  assert.equal(code, 0);
  const lines = fake.innerLines();
  const removed = lines.indexOf(`rm -rf ${MIRROR}`);
  const cloned = lines.indexOf(`git clone --quiet ${SOURCE} ${MIRROR}`);
  assert.ok(removed !== -1, `no removal in:\n${lines.join("\n")}`);
  assert.ok(cloned !== -1, `no clone in:\n${lines.join("\n")}`);
  assert.ok(removed < cloned, "the stale mirror is removed before the clone");
  assert.ok(lines.includes("git config core.fileMode false"), "a fresh clone gets fileMode false");
});

test("the rsync copies no permissions and keeps .git and node_modules", async () => {
  const fake = makeFake();
  await run(fake);

  const args = fake.calls.find((c) => c.args.includes("rsync")).args;
  assert.ok(args.includes(TREE), "the first rsync is the tree");
  assert.ok(args.includes("-rlt"), args.join(" "));
  assert.ok(!args.includes("-a"), "-a copies /mnt/c's 777 modes and dirties every file");
  assert.ok(!args.includes("-p"), "-p copies modes too");
  assert.ok(args.includes("--delete"), "a file deleted on Windows must vanish from the mirror");
  assert.deepEqual(args.slice(args.indexOf("--exclude"), args.indexOf("--exclude") + 2), [
    "--exclude",
    ".git",
  ]);
  assert.ok(args.includes("node_modules"));
});

test("wsl.exe is never given a shell string", async () => {
  for (const options of [{}, { mirrorOrigin: SOURCE, mirrorExists: true }]) {
    const fake = makeFake(options);
    await run(fake);
    for (const { cmd, args, opts } of fake.calls.filter((c) => c.cmd === "wsl.exe")) {
      assert.ok(Array.isArray(args), `args must be an array, got ${typeof args}`);
      assert.equal(opts.shell, undefined, "no shell: wsl.exe re-quotes a command string");
      for (const arg of args) {
        assert.equal(typeof arg, "string");
        assert.doesNotMatch(arg, /(^|\s)(bash|sh|cmd|powershell)\s+-c/, `shell string in ${arg}`);
        assert.doesNotMatch(arg, /^["'].*["']$/, `quoted command string in ${arg}`);
      }
      // A command handed over as one string is what wsl.exe re-quotes.
      for (const arg of args.slice(args.indexOf("-e") + 1)) {
        assert.doesNotMatch(
          arg,
          /^(git|rsync|node|rm|mkdir|test|printenv|env)\s+\S/,
          `a whole command reached wsl.exe as one argument: ${arg}`,
        );
      }
    }
  }
});

test("every wsl.exe call passes its argv with -e, never a bare -- separator", async () => {
  const fake = makeFake({ onPath: ["git"] });
  let stopped;
  try {
    await run(fake, { wsl: { ...WSL, requires: ["git"] } });
  } catch (error) {
    // The fake cannot split a call's flags from its argv without -e, so a
    // mutant run stops early; the calls recorded so far still carry the shape.
    stopped = error;
  }

  const calls = fake.calls.filter((c) => c.cmd === "wsl.exe" && c.args.join(" ") !== "-l -q");
  assert.ok(calls.length > 0, "no wsl.exe call was recorded");
  for (const { args } of calls) {
    const e = args.indexOf("-e");
    assert.ok(e > 0, `no -e before the argv: ${args.join(" ")}`);
    assert.ok(
      [WSL.distro, MIRROR].includes(args[e - 1]),
      `-e must follow the distro or the --cd dir: ${args.join(" ")}`,
    );
    assert.ok(
      !args.slice(0, e).includes("--"),
      `a bare -- separator hands the argv to a shell: ${args.join(" ")}`,
    );
  }
  assert.equal(stopped, undefined, `the run stopped early: ${stopped?.message}`);
});

test("the mirror is named after the repository and lives under the WSL home", async () => {
  const fake = makeFake();
  await run(fake);
  const clone = fake.calls.find((c) => c.args.includes("clone")).args;
  assert.equal(clone[clone.length - 1], MIRROR);
  assert.ok(MIRROR.startsWith(`${HOME}/mirror/`), MIRROR);
});

test("the command's exit code is the runner's exit code", async () => {
  assert.equal((await run(makeFake({ runStatus: 0 }))).code, 0);
  assert.equal((await run(makeFake({ runStatus: 7 }))).code, 7);
});

test("the package runs in the mirror with inherited stdio", async () => {
  const fake = makeFake();
  await run(fake);

  const last = fake.calls[fake.calls.length - 1];
  assert.deepEqual(last.args, inMirror(...RUN));
  assert.equal(last.opts.stdio, "inherit", "output must stream, not buffer behind the run");
});

test("a failed mirror step stops before the command runs", async () => {
  const fake = makeFake({ failOn: "git fetch" });
  const { result: code, stderr } = await withStderr(async () => (await run(fake)).code);

  assert.equal(code, 2);
  assert.match(stderr, /git fetch failed/);
  assert.ok(!fake.innerLines().some((l) => l.includes(" node ")), "the suite must not run");
});

test("a repository root that does not exist exits 2", async () => {
  const fake = makeFake();
  const { result: code } = await withStderr(async () => (await run(fake, { repoExists: false })).code);
  assert.equal(code, 2);
  assert.deepEqual(
    fake.calls.filter((c) => c.cmd === "wsl.exe").map((c) => c.args),
    [["-l", "-q"]],
    "no work is attempted beyond the distro list",
  );
});

test("a Windows path converts to its /mnt form", () => {
  assert.equal(toWslPath("C:\\a\\b"), "/mnt/c/a/b");
  assert.equal(toWslPath("C:/a/b"), "/mnt/c/a/b");
  assert.equal(toWslPath("D:\\work\\tree"), "/mnt/d/work/tree");
  assert.equal(toWslPath("c:/x"), "/mnt/c/x");
  assert.equal(toWslPath("C:\\Users\\dev\\.cache\\wt"), "/mnt/c/Users/dev/.cache/wt");
});

test("a path already on the Linux side is left alone", () => {
  assert.equal(toWslPath("/home/ubuntu/mirror/x"), "/home/ubuntu/mirror/x");
  assert.equal(toWslPath("/mnt/c/a/b"), "/mnt/c/a/b");
});

test("a linked worktree's common dir converts to the clone source", async () => {
  // This worktree is a linked one: `--git-common-dir` prints the main
  // checkout's absolute path, which is what makes the clone see local commits.
  const fake = makeFake({ commonDir: "C:/code/consumer/.git" });
  await run(fake);

  const clone = fake.calls.find((c) => c.args.includes("clone")).args;
  assert.equal(clone[clone.length - 2], "/mnt/c/code/consumer/.git");
  assert.equal(clone[clone.length - 1], `${HOME}/mirror/consumer`);
});

test("a relative common dir resolves against the worktree root", async () => {
  const fake = makeFake({ commonDir: ".git" });
  await run(fake);

  const clone = fake.calls.find((c) => c.args.includes("clone")).args;
  assert.equal(clone[clone.length - 2], SOURCE, "a main-checkout `.git` must resolve, not clone `.git`");
});

test("the rsync source is the worktree root, converted, with a trailing slash", async () => {
  const fake = makeFake();
  await run(fake);

  const args = fake.calls.find((c) => c.args.includes("rsync")).args;
  const source = args[args.length - 2];
  assert.equal(source, TREE);
  assert.ok(source.endsWith("/"), "a missing trailing slash copies the directory, not its contents");
  assert.equal(args[args.length - 1], `${MIRROR}/`);
});

// --- wsl.keep, wsl.path, wsl.requires and the package copy -------------------

test("wsl.path entries, ~ expanded, lead the PATH every mirror run gets", async () => {
  const fake = makeFake();
  await run(fake, { wsl: { ...WSL, path: ["~/.cargo/bin", "/opt/tool/bin"] } });
  const last = fake.calls[fake.calls.length - 1].args;
  assert.equal(last[last.indexOf("-e") + 1], "env");
  assert.equal(last[last.indexOf("-e") + 2], `PATH=${HOME}/.cargo/bin:/opt/tool/bin:${DISTRO_PATH}`);
});

test("a missing wsl.requires tool exits 2 naming it, before any sync or run", async () => {
  const fake = makeFake({ onPath: ["cargo"] });
  const { result: code, stderr } = await withStderr(async () => (await run(fake, {
    wsl: { ...WSL, requires: ["cargo", "no-such-tool"] },
  })).code);
  assert.equal(code, 2);
  assert.match(stderr, /no-such-tool is not on PATH in ubuntu/);
  const lines = fake.innerLines();
  const ran = lines.some((l) => l.startsWith("git clone") || l.startsWith("rsync") || l.includes(" node "));
  assert.ok(!ran, lines.join("\n"));
  const check = fake.calls.find((c) => c.args.includes("no-such-tool")).args;
  assert.deepEqual(check.slice(check.indexOf("-e") + 1), [
    "env", `PATH=${DISTRO_PATH}`, "sh", "-c", 'command -v -- "$1"', "requires", "no-such-tool",
  ], "the tool name is an argument, never part of the script");
});

test("wsl.keep paths are excluded from the tree sync, so --delete leaves them", async () => {
  const fake = makeFake();
  await run(fake, { wsl: { ...WSL, keep: ["target"] } });
  const args = fake.calls.find((c) => c.args.includes(TREE)).args;
  assert.ok(args.join(" ").includes("--exclude target"), args.join(" "));
});

test("the mirror runs the host's package copy, never the consumer's node_modules", async () => {
  const fake = makeFake();
  await run(fake);
  const lines = fake.innerLines();
  const copy = lines.indexOf(PACKAGE_COPY.join(" "));
  const runAt = lines.indexOf(RUN.join(" "));
  assert.ok(copy !== -1 && runAt > copy, lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("node_modules/test-runner/bin")), "the consumer's installed copy ran");
});
