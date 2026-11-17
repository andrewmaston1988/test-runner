# test-runner

A zero-dependency Node package that runs a repository's tests from its `test-runner.config.mjs`. It covers diff-aware selection, command runs, the Windows/Linux platform split and the WSL mirror. The user-facing reference is `README.md`; the plan of record is `<claude-base>/repos/test-runner/plans/test-runner-extract.md`.

---

## Architecture

```
bin/test-runner.mjs     entry point; turns main()'s promise into process.exitCode
src/cli.mjs             flags, config load, selection, {base}, summary, exit code
src/config.mjs          load, validate (field + fix + example), defaults
src/select.mjs          glob expansion, packages/homes, diff selection, command keys
src/graph.mjs           the import graph a package suite selects on
src/changed.mjs         the changed set and its base ref
src/run.mjs             installs, node --test runs, command runs, platform filter, timeouts
src/spawn-command.mjs   argv -> spawn; the cmd.exe route for Windows .cmd/.bat
src/wsl.mjs             the WSL mirror: sync, package copy, PATH, requires
src/reporter.mjs        the node --test reporter (heartbeat, agent mode, logs)
src/fast.mjs            --fast timings;  src/orphans.mjs  the orphan check
tests/                  one file per module; helpers.mjs holds the fixtures
```

The runner was ported from claude-plugin-marketplace's `scripts/test.mjs` (commit 5762005). `tests/helpers.mjs`'s `MARKETPLACE` config reproduces that runner's behaviour, so the ported tests double as its regression suite.

---

## Constraints

- **When adding an import**: only `node:*` builtins and relative paths. Consumers install this package with `npm ci`, and the WSL mirror runs a plain copy of the directory, which has to be complete with nothing installed.
- **When a file nears 500 lines**: split it by responsibility before adding to it. `run.mjs` and `cli.mjs` were split this way.
- **When adding a config field or a consumer-specific default**: put it in `src/config.mjs` with validation that names the field, the fix and an example. No suite name, path, branch or distro of any consumer may appear in `src/`; the plan's A6 grep checks this.
- **When a function reaches the process, filesystem, clock or platform**: take it as an underscore-prefixed parameter with the real one as default (`_spawn`, `_fs`, `_now`, `_platform`), so tests inject a fake.
- **When ending the CLI**: set `process.exitCode` and never call `process.exit()`. On Windows, stdout and stderr are async pipes and would be truncated mid-write.

---

## Run commands

```sh
node bin/test-runner.mjs --all           # the package's own suite (it dogfoods itself)
node bin/test-runner.mjs --orphans
node --test tests/select.test.mjs        # one file
```

The suite builds throwaway git repositories, so it needs a git identity (`user.name`, `user.email`). On a loaded Windows machine a full run takes several minutes; run it in the background rather than on a short timeout.

---

## Non-obvious gotchas

- **When spawning a user's command on Windows**: go through `commandSpawn`. Node refuses to spawn a `.cmd` without a shell (EINVAL), and `shell: true` would let an argument like `a && b` run a second command. `tests/spawn-command.win.test.mjs` covers both.
- **When adding a `wsl.exe` call**: pass an argv array, never a command string, because `wsl.exe` re-quotes strings. The one `sh -c` (the `requires` check) runs a constant script and passes the tool name as `$1`.
