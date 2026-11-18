# test-runner

A config-driven test runner for repositories with more than one kind of test. It provides:

- **Diff-aware selection.** A change runs only the tests whose import graph reaches it, plus whole suites for what the graph cannot see.
- **Command runs.** `cargo test`, `npm run gate` or any other argv runs under the same timeout and process-tree kill as `node --test`.
- **A Windows/Linux split.** Runs pinned to Windows stay on a Windows host. The rest run in a WSL mirror of the working tree, so Linux-only failures surface before CI.
- **One summary.** Exit 0 (pass), 1 (a test failed) or 2 (the request or a prerequisite failed).

There are no runtime dependencies, and it needs Node 22 or newer.

## Install

Install it as a git-pinned devDependency. Nothing is published to the npm registry; to upgrade, bump the tag.

```json
{ "devDependencies": { "test-runner": "github:andrewmaston1988/test-runner#v0.1.1" } }
```

Run it with `npx --no-install test-runner`, or from a script: `"test": "test-runner"`. Use `--no-install`: a bare `npx test-runner` with no `node_modules` fetches a different package of that name from the registry instead of the one this file adds.

## Config

`test-runner.config.mjs` at the repository root default-exports a plain object; `--config <path>` names another file inside the repository. Every field except `suites` is optional:

```js
export default {
  base: ["origin/main", "main"],          // base refs for a diff run, tried in order
  selectAll: [".github/workflows/**"],     // a change here runs every suite
  repoSuite: "repo",                       // the suite that takes changes nothing else owns
  packages: ["packages/*"],                // directories whose suites select by import graph
  fallback: ["**/package.json", "**/package-lock.json", "**/.env.test"],
  skipDirs: ["fixtures-big"],              // directory names never walked
  suites: [
    { name: "api", runs: [{ cwd: "packages/api", globs: ["tests/*.test.mjs"], install: ["npm", "ci"] }] },
    { name: "py", runs: [{ globs: ["tests/**/test_*.py"], runner: ["python", "-m", "pytest"] }] },
    { name: "repo", runs: [{ globs: ["scripts/*.test.mjs"] }] },
    { name: "rust", runs: [
      { label: "test", command: ["cargo", "test"], cargo: true, platform: "linux", timeoutMs: 3600000 },
      { label: "android", command: ["cargo", "ndk", "clippy"], platform: "windows", paths: ["crates/**"] },
    ] },
  ],
  notRun: [{ path: "tests/manual.test.mjs", reason: "needs a device" }],
  slowMs: 300,                             // a test row's time turns yellow here
  wsl: { distro: "ubuntu", setup: "Install the distro first; see the README's WSL section.", keep: ["target"],
         path: ["~/.cargo/bin"], requires: ["cargo", "node", "rsync"] },
};
```

| Field | Default | Meaning |
|---|---|---|
| `suites[].name` | required | Letters, digits, `.`, `-`, `_`; unique. |
| `suites[].select` | `"graph"` | `graph` or `paths`. A `paths` suite selects its runs by their declared `paths` alone: the import graph, the Python reach, the cross-package sweep and scanner detection are all off for it, and a change no `paths` glob covers runs the suite whole. Every globs run in it must declare non-empty `paths`. |
| `runs[].globs` | | Run `node --test` over the files these match, relative to `cwd`. `**` crosses directories, `*` does not. |
| `runs[].command` | | Run this argv instead, with no shell. Give exactly one of `globs` and `command`. |
| `runs[].runner` | none | Globs runs: the argv the selected files are appended to, e.g. `["python", "-m", "pytest"]`. Omit it for `node --test`. Refused with `envFile`. |
| `runs[].cwd` | `"."` | The run's working directory, relative to the root. |
| `runs[].label` | none | Names the run's log (`test-results/<suite>[<label>].log`); unique within a suite. |
| `runs[].timeoutMs` | 600000 | The run is killed as a process tree after this long. |
| `runs[].platform` | `"any"` | `any`, `windows` or `linux`; see [Platforms](#platforms). |
| `runs[].paths` | none | Globs runs and command runs: the globs whose changes select the run whole. Repo-relative, even when the run has a `cwd`. A globs run with no `paths` is selected by the import graph alone; a command run with no `paths` is selected by any change. |
| `runs[].cargo` | `false` | Command runs only: select per crate from a diff — a changed crate file runs that crate and its dependents with repeated `-p`; a workspace-manifest or toolchain change runs the run whole. Built from one `cargo metadata --no-deps` call per run `cwd`, cached for the invocation; a failed read runs the run whole with a notice. See [What a diff selects](#what-a-diff-selects). |
| `runs[].env`, `envFile` | none | Extra environment; `envFile` is passed to node as `--env-file` (globs runs only). |
| `runs[].install` | none | An argv run once per `package-lock.json` hash in `cwd`, e.g. `["npm", "ci"]`; other lockfiles are not watched. Refused at the root, because the runner itself was installed there. |
| `runs[].exclude` | none | Globs runs only: path fragments to leave out. |
| `runs[].format` | none | Command runs only: names the run's test-output format — `tap`, `libtest`, `junit`, or a repository-relative `.mjs` shim. With it the run's output is parsed into per-test rows; see [Formats](#formats). |
| `runs[].fastSkip` | `false` | Command runs only: with `--fast`, deselects the long-running tests this machine measured over 30 s in the last 7 days; see [Formats](#formats). |
| `base` | `origin/main`, `main`, `origin/master`, `master` | The diff base is the merge-base with the first of these that exists. |
| `selectAll` | `[]` | Changes here select everything. The config file and the root `package-lock.json` always do. |
| `repoSuite` | none | Takes every non-Markdown change no other suite owns. Without it, such changes are listed as `unowned`. |
| `packages` | `[]` | Globs naming package directories. Within a package, selection follows the import graph. A relative import is followed wherever it resolves, even out of its own package; a file-name literal is matched only inside the suite's own root. |
| `fallback` | `**/package.json`, `**/package-lock.json` | Changes here run the package's suites whole. |
| `skipDirs` | `[]` | Directory names never walked, on top of `node_modules`, `.git`, `.test-runner` and `.venv`. `--orphans` also skips `fixtures`. |
| `notRun` | `[]` | Test files deliberately run by no suite, each with its reason (see `--orphans`). |
| `slowMs` | `300` | A test row's time turns yellow at this many milliseconds, and the slowest-tests list uses the same threshold. `--slow-ms` overrides it. |
| `wsl` | none | The WSL mirror; see [WSL](#wsl). |

An invalid config exits 2, naming the field, what is wrong, the fix and an example. An unknown field is an error, so a typo never silently does nothing.

## Running

```sh
test-runner                    # the diff: changed tests, plus whatever the diff reaches
test-runner --list             # what would run, and why, without running it
test-runner --all              # every suite
test-runner --suite api        # one suite, whole
test-runner --against main     # measure the diff from this ref
test-runner --fast             # skip unchanged files measured over 30 s in the last 7 days; fastSkip runs also deselect long-running tests
test-runner --slow-ms 500      # the yellow threshold and the slow list, instead of 300 ms
test-runner --platform windows # only the Windows-pinned runs and *.win.test.mjs files
test-runner --wsl              # the Linux half, in the WSL mirror
test-runner --orphans          # list test files no suite runs; exit 1 if any
```

`--suite <name> --if-selected` runs the suite whole when the diff selects any of it, and otherwise exits 0 with `not selected by this diff`. This is the CI shape: one job per suite, each deciding for itself.

**`--fast` and command runs.** A run with `format` records every passing test's time under `--fast`, from the producer's own output. A run also setting `fastSkip: true` additionally drops the long-running tests measured over 30 s in the last 7 days: a `junit` run appends one `--deselect <nodeid>` pair per test — with pytest that needs `-o junit_family=legacy`, see [`{report}`](#base-and-report) below — while a `tap`, `libtest` or shim run has no skip convention, so it runs whole and the runner says so. (Node's `--test-skip-pattern`, the honest fix for TAP, is left for a later release.) A run only records times when it passed; deselects replay only while the recorded tree stamps — the commit hash and dirty state — are still this tree's.

**Exit codes.** 0 means everything that ran passed, including an empty selection. 1 means a run failed or timed out, a whole-suite run matched no file, or `--orphans` found one. 2 means a request or prerequisite failed: an unknown flag or suite, an invalid config, an unresolvable base, or a missing distro or tool.

**Temp roots.** Every run starts with `TEMP`, `TMP` and `TMPDIR` pointing at one fresh `<tmpdir>/test-runner/<label>-XXXXXX` dir, so the temp dirs a test leaves behind collect under that one parent instead of scattering through the OS temp dir. A passing run's root is removed. A run that fails or times out keeps it and prints `[test] <label>: temp root kept at <path>` — a failing test's evidence is usually in there — unless the root is empty, which is removed silently. If the root cannot be made (an unwritable or full temp dir), the run goes ahead without one and says so. The install step runs outside the root: npm's cache staging is not test litter. A `runs[].env` naming `TEMP`, `TMP` or `TMPDIR` opts that run out — its value wins and no root is made. `envFile` is not an opt-out: node's `--env-file` never overrides a variable that is already set, so a temp var in the file loses to the root; put it in `runs[].env` instead.

### What a diff selects

The changed set is the branch diff since the merge-base, plus uncommitted and untracked files. The rules run in this order, and `--list` prints the first reason that names a file:

1. **Select-all** — the config file, the root `package-lock.json`, or anything in `selectAll` runs every suite whole.
2. **Declared `paths`** — a run whose `paths` match the change is selected whole, globs runs and command runs alike.
3. **`fallback` manifests** — a match inside a package runs every suite covering that package whole.
4. **Graph closure** — inside each covering suite, the tests that reach the change through relative imports, re-exports, literal dynamic imports, `new URL(..., import.meta.url)` and file-name string literals.
5. **Scanner tests** — a test that walks a directory is selected by any non-Markdown change in its package.
6. **Cross-package reach** — a sibling package's test whose relative import leaves its own package.
7. **Unattributed fallback** — inside a package, a non-Markdown change no test reaches runs that package's suites whole; outside packages, a change under a suite's own glob root (for example `tools/map/` for `tools/map/tests/*.test.mjs`) runs that suite whole.
8. **`repoSuite`, else `unowned`** — any other non-Markdown change goes to `repoSuite`, or is listed as `unowned`. A change a cargo run maps to a crate is attributed to that run, so it neither reaches `repoSuite` nor is listed as `unowned`. A suite globbing a root `tests/` is homed at the root, so it takes every change nothing more specific owns. With `--if-selected` an unowned change selects nothing, so give a repository whose suites all live in subdirectories a `repoSuite`. Markdown nothing selects reports `docs-only`.

Rules 2, 5 and 6 add to 3-7 rather than replacing them: a declared `paths` match only suppresses rule 7's whole-suite fallback, and only for the suite that declared it. Over-selection costs seconds; a missed test costs a red PR.

- **A cargo run (`cargo: true`) is selected per crate.** Its declared `paths` gate it as rule 2 does. Without `paths`, the runner derives the gate from one `cargo metadata --no-deps` call per run `cwd`: the member crates' directories, the workspace's own files (`Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `rust-toolchain`, `.cargo/config.toml`, relative to the workspace root), non-member path-dependency dirs inside the repository, and the parent dirs of files the crates `include_str!`/`include_bytes!`. A change inside that set maps to the base crate and the crates that depend on it, run with repeated `-p` (any `--workspace` or `--all` in the argv is stripped when `-p` is inserted, because the flags union); a workspace file, or a change in the set that no crate owns, maps the run whole; a change outside the set selects nothing of the run. A path mapped to a crate counts as attributed for rule 8, so it is never also reported `unowned` or handed to `repoSuite`. A workspace whose root package is a member maps everything under the root into the root crate — over-selection, never a drop. The metadata call reads member manifests only and leaves `Cargo.lock` untouched; when it fails, the run is selected whole and a notice names the error. A member outside the default members set is still `-p`-selected; cargo accepts it. The honest worst case: a change to the workspace's base crate selects every crate that transitively depends on it — the same set `cargo test --workspace` runs today — so per-crate selection pays where the changed crate is not the base.

- **`*.win.test.mjs` files** are added to every diff, so they run on every Windows run.

- **Python repositories.** A `.py` test is selected as a file, by the imports it reaches: absolute names resolve against the repository root and the `pythonpath` under `[tool.pytest.ini_options]` in `pyproject.toml`, relative dots from the importing file. A name no configured root resolves falls back to a path-suffix match on the same three arms — the module, its own `__init__.py` and every ancestor's — so `import pricing` reaches `**/pricing.py` and `from shop.pricing import x` also reaches `**/shop/__init__.py`. Relative imports are deterministic and never take that fallback. A stdlib or third-party name over-selects when the repository holds a same-named module. Every `conftest.py` above a test seeds its reach, which is how a fixture-using test that imports nothing is still selected. A `pyproject.toml` change runs each suite holding `.py` files whole. A Python test that imports a name it computes — `import_module`, `__import__` — makes its suite run whole rather than narrowed. `sys.path.insert` in a conftest is not followed: put the directory in `pythonpath` instead. `.venv` is never walked, so a virtualenv's tests are neither selected nor reported as orphans.

### Declared paths and scanners

`runs[].paths` says which changes select a run, whatever the run kind:

- **A globs run** with `paths` is selected whole when a change matches, in addition to whatever the import graph reaches. Use it for a computed path the graph cannot follow, such as `join(root, "sm" + "oke.ps1")` or a template name built from a variable.
- **A command run** with `paths` runs when a change matches. With no `paths`, any change selects it.
- **A claiming suite** — one whose `paths` matched — does not also run whole on an unattributed change in its package. It still gets the graph, the scanners and the cross-package sweep.

A scanner is detected from the test's text, not its name: a test whose source contains a directory-walking token (`readdirSync`, `glob`, `opendir`, `Get-ChildItem` and similar) is selected by any change in its package, because it reads whatever it finds. Two boundaries:

- **Markdown never selects a scanner.** The walker's output is not assumed to depend on documentation.
- **Only inside a `packages` directory.** Outside packages the home-dir rule already runs the suite whole, so scanner detection is not applied.

PowerShell `.ps1` targets need no runner support:

- **A quoted literal is an edge.** A test naming `"$PSScriptRoot/../smoke-music.ps1"` or `Join-Path $PSScriptRoot "..\setup-symlinks.ps1"` reaches the script, because backslashes are normalised before the basename is matched. The target must sit inside the suite's glob root: the basename table is built from that root, so a target outside it is not an edge — the change lands on rule 7, which over-selects rather than missing.
- **A computed target needs `paths`.** `Join-Path $PSScriptRoot $name` leaves no literal for the graph to follow, so declare on the run the globs whose changes affect it.
- **Pester is run-level.** A suite that runs all its Pester files through one `pwsh -File tools/test.ps1` command run is selected whole by that run's `paths`.

### Platforms

Each run has a `platform`: `any` (the default), `windows` or `linux`. A `*.win.test.mjs` file is always `windows`, whatever its run says.

- **A plain run** executes `any` plus the host's own platform, and names the runs it skipped.
- **`--platform windows`** executes only `windows` runs and `*.win.test.mjs` files. It is allowed only on a Windows host, and exits 2 anywhere else.
- **`--wsl`** runs a plain Linux run in the mirror, so it executes `linux` and `any` runs without the `.win` files.
- **`--wsl` runs a cargo run whole.** The mirror is handed `--all --mirror`, so it reads no `cargo metadata` and builds no `-p` list: every run executes as declared. Per-crate selection is a host diff-mode feature only. In plain mode a run pinned to another platform is read on this host before the platform filter skips the run itself.

A Windows developer's full gate is `test-runner --platform windows` plus `test-runner --wsl`, and every run executes exactly once across the two. A Linux CI job runs a plain invocation; a Windows CI job runs `--platform windows`.

### `{base}` and `{report}`

The literal `{base}` inside a command argument is replaced by the diff base, so a gate script can take `["node", "gate.mjs", "--against", "{base}"]`. A whole-suite run that needs it resolves the base from `--against` or `base`.

The literal `{report}` — junit and shim runs only — expands to `test-results/<label>.report.xml` in the run's results directory: the file is deleted before the run, read after it, and kept as the raw evidence. The XML in the report file is what the rows come from; the run's stdout is the fallback when the producer prints the report instead. Because the `--fast` deselects are rebuilt from the report's node ids, name the option that makes the producer stamp real ones — for pytest, `-o junit_family=legacy` before `--junitxml={report}`:

```js
{ command: ["pytest", "-o", "junit_family=legacy", "--junitxml={report}"], format: "junit", fastSkip: true }
```

With the default junit family the report carries only `classname`, so node ids are display form and pytest silently ignores the deselects — the long-running test runs whole every time.

## WSL

`--wsl` mirrors the working tree into `~/mirror/<repo>` on the distro's own disk and runs this package there. The mirror is a clone of the repository's git directory plus an `rsync` of the files as they are right now, uncommitted ones included. Treat the mirror as disposable.

- **The package runs from a copy.** The host copies this package into `<mirror>/.test-runner/` and runs it from there. The mirror never needs the consumer's own installed copy, and it always runs the host's version.
- **`npm ci` runs once per lockfile hash** at the mirror's root, because `node_modules` is never synced.
- **`wsl.keep`** names paths the sync leaves in place, such as a `target` build cache. `node_modules` is always kept. `.venv` is not: it is copied on every sync unless you list it here, and a Windows virtualenv is useless inside the distro, so keep a Linux one here instead.
- **A `runner` run needs the distro's tools.** The interpreter and pytest execute inside the mirror, so install them there and name them in `wsl.requires` to fail before the sync rather than mid-run.
- **`wsl.path`** entries are put in front of `PATH` for every mirror run, with `~` expanded. `wsl.exe` starts no login shell, so `~/.cargo/bin` or an nvm `node` is otherwise missing.
- **`wsl.requires`** names tools checked before anything syncs. A missing one exits 2 and names the tool.
- **Colour and the slow threshold follow.** `--slow-ms` is passed on to the mirror's run, and the host's colour decision crosses over as `TEST_COLOUR`.

**One-time setup.** Install a distro and name it in `wsl.distro` (`wsl.exe -l -q` lists the names). Inside it, install `git`, `rsync`, `node` and whatever your Linux runs need. A missing distro prints `wsl.setup`, so point that at your own setup notes.

## Output

Each file prints its tree the moment it finishes — a row per suite and test, indented under the
file:

```text
✓ tests/select.test.mjs (4 tests)  0.4s
  ✓ picks a changed file
  ✓ select
    ✓ reads the merge-base
    ↓ reads the fixture
✗ tests/run.test.mjs (3 tests)  1.2s
  ✗ a run past its timeout is killed
```

`✓` is green, `✗` red, and `↓` yellow for a skipped or todo test. A failed row is red
throughout, time included. A time turns yellow at `slowMs` (300 ms by default), and the
end-of-run `slowest tests (over 300ms):` list uses the same threshold — `--slow-ms <n>` or the
config's `slowMs` moves both. `… still running (65s): <files>` prints every 60 s while nothing
finishes.

At the end the run prints each failure with its error and a code frame, the slowest tests, and
the totals. When an agent is detected (`CLAUDECODE`, `AI_AGENT` and the variables `std-env`
knows) only failures print; `--reporter=agent|default` overrides the detection. The full record
goes to `test-results/<label>.log` as the same rows with the ANSI removed. A run killed at its
timeout names the files it still had in flight.

A suite running whole because nothing attributed the change says so on stderr:
`[test] wide run: the blast radius of '<path>' could not be determined, so <suite> run whole`.
It prints in default and agent mode — it explains the wall-clock — and is amber when colour is
on. The notice names at most ten paths, then `[test] wide run: and <n> more (see --list)`.
`--list` prints every one uncapped, and `--if-selected` prints none, because CI runs the suite
whole by design.

A run with `format` prints its rows from the producer's own output: `tap` reads the TAP the
run printed, `libtest` reads cargo's test lines, `junit` reads the `{report}` file — see
[Formats](#formats). Durations are the producer's own, so cargo's rows carry none and an
un-timed row never enters the slowest list; a parsed run echoes the producer's stderr in its
last seconds only in agent mode after a failure. The same `still running` heartbeat covers
parsed runs. For such a run the log is the producer's own record — stdout, then stderr after
an `--- stderr ---` separator. A parsed run that recognises nothing prints
`[test] <label>: no tests recognised in the output (format: tap); raw output in …`; the exit
code still decides the verdict.

**Colour.** `FORCE_COLOR` wins first (`0` off, anything else on), then agent mode is off, then
`NO_COLOR` (any non-empty value) is off; otherwise colour follows `stdout.isTTY` or `CI`. The
parent decides once and passes the answer in `TEST_COLOUR`, so the rows, the PASS/FAIL lines and
a `--wsl` run all agree.

## Formats

`format` turns a command run's output into per-test rows. Three parsers are built in, each
pinned to a probed producer shape; anything else takes a shim.

- **`tap`** — `node --test --test-reporter=tap`, or any TAP producer. Subtests nest under
  their parent, `duration_ms` gives a row its time, a failing row's YAML block rides along as
  its detail, and `# SKIP` / `# TODO` directives become skips.
- **`libtest`** — `cargo test`, plain or `--format json`, or a mix of both. A failure block
  (`---- <name> stdout ----`) rides the row as detail; cargo prints no per-test durations, so
  rows carry no time and the slowest list stays empty.
- **`junit`** — any producer of the common `<testsuites>/<testsuite>/<testcase>` shape:
  pytest's `--junitxml={report}`, Pester's JUnitXml. `time` (seconds) becomes the row's
  milliseconds, a `<failure>`/`<error>` child fails the row with its `message` as detail, a
  `<skipped>` child skips it. Node ids (`file::name`) come off the testcase's `file`
  attribute — pytest's default family has none, so add `-o junit_family=legacy` (see
  [`{report}`](#base-and-report) above).

Namespaces and CDATA defeat the built-in scanner. A `format` may instead name a
repository-relative `.mjs` file:

```js
// parsers/my-runner.mjs
export default function parse({ stdout, stderr, exitCode, report }) {
  // report is { path, text } when the {report} file the run was handed exists, else null
  return {
    events: [
      { name: "suite a test", outcome: "pass", ms: 12 },
      { name: "suite a fails", outcome: "fail", ms: 3, detail: "the failure's own output" },
      { name: "suite a skips", outcome: "skip", ms: null, todo: false },
    ],
  };
}
```

The contract: a default function; imported once when the config loads — a module that is
missing, throws, or default-exports anything but the function exits 2 before anything runs;
called once per run with `{ stdout, stderr, exitCode, report }` (the captured streams, the
child's exit code, and `report: { path, text }` when the `{report}` file was given and
written); returns the events above, where `ms` is `null` whenever the producer prints no
per-test time, `chain` names enclosed subtests, `detail` carries a failure's own output and
renders in agent mode only, and `todo: true` marks a TAP-style todo. The exit code stays the
runner's verdict, never the parser's — a shim that throws prints the no-tests notice and the
run stands on its own exit. The path is repository-relative and may not contain `\` or `..`.

### PowerShell

A hand-rolled `.ps1` runs as a plain command run; if it prints TAP, set `format: "tap"` and
its lines become rows. For Pester, `Invoke-Pester` writes the JUnitXml report the `junit`
parser reads:

```js
{ label: "unit", platform: "windows", format: "junit",
  command: ["pwsh", "-NoProfile", "-NoLogo", "-NonInteractive", "-Command",
            "Invoke-Pester -Configuration @{ TestResult = @{ Enabled = $true; OutputPath = '{report}'; OutputFormat = 'JUnitXml' } }"] },
```

That configuration API is Pester 5's; the probed output (Pester 6) has each testcase carry the
script path as its `classname`, so rows show the full path before the `describe.it` name, and
skips ride a `<skipped>` child.

## CI

One job per suite, each selecting itself from the diff:

```yaml
jobs:
  api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }      # the diff needs its base commit
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm ci
      - run: npx test-runner --suite api ${{ github.event_name == 'pull_request' && format('--if-selected --against {0}', github.event.pull_request.base.sha) || '' }}
```

On `windows-latest`, add `--platform windows`.

## Licence

MIT; see [LICENSE](LICENSE). To report a vulnerability, see [SECURITY.md](SECURITY.md).
