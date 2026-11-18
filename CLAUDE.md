# test-runner

A zero-dependency Node package that runs a repository's tests from its `test-runner.config.mjs`. It covers diff-aware selection, command runs, the Windows/Linux platform split and the WSL mirror. The user-facing reference is `README.md`.

---

## Architecture

```
bin/test-runner.mjs     entry point; turns main()'s promise into process.exitCode
src/cli.mjs             flags, config load (incl. .mjs format shims), selection, {base}, summary, exit code
src/config.mjs          load, validate (field + fix + example), defaults
src/select.mjs          diff selection: the rule engine, declared paths, Python reach, cargo claims
src/select-glob.mjs     glob expansion from each glob's static prefix
src/select-suite.mjs    suite shape: packages, homes, root, command and cargo keys
src/graph.mjs           the repo-wide import graph, scanner detection, per-language dispatch
src/python.mjs          Python imports resolved as pytest resolves them (roots, dots, conftest)
src/crates.mjs          the cargo workspace graph from `cargo metadata`; the -p argv
src/changed.mjs         the changed set and its base ref
src/run.mjs             runSuites: node --test runs, platform filter, the summary lines
src/command.mjs         command runs: capture, heartbeat, format parsing into rows, {report}
src/temp-root.mjs       one dispatch's TEMP/TMP/TMPDIR root: deleted on a pass, kept on a failure
src/execute.mjs         installs, process-tree kill, timeouts, in-flight files
src/formats.mjs         TAP, libtest and JUnit parsers; --fast skip args per format
src/spawn-command.mjs   argv -> spawn; the cmd.exe route for Windows .cmd/.bat
src/wsl.mjs             the WSL mirror: sync, package copy, PATH, requires
src/reporter.mjs        the node --test reporter (event stream, heartbeat, agent mode, logs)
src/render.mjs          pure formatting: rows, the test tree, totals, slowest list, code frames
src/colour.mjs          the one colour rule; the parent decides it and passes TEST_COLOUR
src/fast.mjs            --fast timings;  src/orphans.mjs  the orphan check
tests/                  <module>.test.mjs, or <module>-<topic>.test.mjs once one outgrows 450
                        lines (changed.mjs is covered in select-changed); constraints.test.mjs checks
                        the import and consumer-name rules; helpers.mjs and *-harness.mjs hold the fixtures
```

The runner was ported from claude-plugin-marketplace's `scripts/test.mjs`. `tests/helpers.mjs`'s `MARKETPLACE` config reproduces that runner's behaviour, so the ported tests double as its regression suite.

---

## Constraints

- **When adding an import**: only `node:*` builtins and relative paths. Consumers install this package with `npm ci`, and the WSL mirror runs a plain copy of the directory, which has to be complete with nothing installed. `tests/constraints.test.mjs` checks this.
- **When a file nears 500 lines**: split it by responsibility before adding to it. `run.mjs` and `cli.mjs` were split this way.
- **When adding a config field or a consumer-specific default**: put it in `src/config.mjs` with validation that names the field, the fix and an example. No suite name, path, branch or distro of any consumer may appear in `src/`; `tests/constraints.test.mjs` checks this.
- **When a function reaches the process, filesystem, clock or platform**: take it as an underscore-prefixed parameter with the real one as default (`_spawn`, `_fs`, `_now`, `_platform`), so tests inject a fake. The reporter is the exception: `createReporter` takes `now`, `sleep`, `env` and `fs` unprefixed, as its options object.
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
- **When adding a `wsl.exe` call that runs something in the distro**: build the argv with `wslArgv`, which passes `-e` — an argv array executed with no shell. `--` hands the joined line to the distro's shell, which re-parses every argument; a PATH holding `Program Files (x86)` is a bash syntax error. The distro listing (`wsl.exe -l -q`) is the one bare call. The one `sh -c` (the `requires` check) runs a constant script and passes the tool name as `$1`. `tests/wsl.test.mjs` and `tests/wsl-exec.win.test.mjs` pin both.
- **When changing how `src/select.mjs` treats a declared `paths` match or a scanner test**: keep both narrow. A `paths` match suppresses only the unattributed whole-suite fallback, never what the import graph selects, and scanner detection runs only for suites under `packages`. Widening either silently over- or under-selects in consumer repos; `tests/select-paths.test.mjs` pins both.
