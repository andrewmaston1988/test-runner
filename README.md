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
{ "devDependencies": { "test-runner": "github:andrewmaston1988/test-runner#v0.1.0" } }
```

Run it with `npx test-runner`, or from a script: `"test": "test-runner"`.

### The private-repository token (CI)

The repository is private, so `npm ci` needs credentials to fetch it. Create a fine-grained token with read access to `test-runner` only, and store it as a secret (`TEST_RUNNER_TOKEN`) in each consuming repository. Then add this step before `npm ci`.

npm may record a `github:` dependency in the lockfile as `git+ssh://git@github.com/...`. An `https://` rewrite alone never matches that form, so the step maps all three URL forms. Check the form your lockfile actually records.

Linux (`ubuntu-latest`):

```yaml
- name: Let npm fetch the private test-runner
  run: |
    for from in "https://github.com/" "ssh://git@github.com/" "git@github.com:"; do
      git config --global --add url."https://x-access-token:${TOKEN}@github.com/".insteadOf "$from"
    done
  env:
    TOKEN: ${{ secrets.TEST_RUNNER_TOKEN }}
```

Windows (`windows-latest`, PowerShell):

```yaml
- name: Let npm fetch the private test-runner
  shell: pwsh
  run: |
    foreach ($from in 'https://github.com/', 'ssh://git@github.com/', 'git@github.com:') {
      git config --global --add "url.https://x-access-token:$env:TOKEN@github.com/.insteadOf" $from
    }
  env:
    TOKEN: ${{ secrets.TEST_RUNNER_TOKEN }}
```

Locally, an SSH key with read access to the repository is enough.

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
    { name: "repo", runs: [{ globs: ["scripts/*.test.mjs"] }] },
    { name: "rust", runs: [
      { label: "test", command: ["cargo", "test", "--workspace"], platform: "linux",
        paths: ["crates/**", "Cargo.toml", "Cargo.lock"], timeoutMs: 3600000 },
      { label: "android", command: ["cargo", "ndk", "clippy"], platform: "windows", paths: ["crates/**"] },
    ] },
  ],
  notRun: [{ path: "tests/manual.test.mjs", reason: "needs a device" }],
  wsl: { distro: "ubuntu", setup: "See docs/wsl.md.", keep: ["target"],
         path: ["~/.cargo/bin"], requires: ["cargo", "node", "rsync"] },
};
```

| Field | Default | Meaning |
|---|---|---|
| `suites[].name` | required | Letters, digits, `.`, `-`, `_`; unique. |
| `runs[].globs` | | Run `node --test` over the files these match, relative to `cwd`. `**` crosses directories, `*` does not. |
| `runs[].command` | | Run this argv instead, with no shell. Give exactly one of `globs` and `command`. |
| `runs[].cwd` | `"."` | The run's working directory, relative to the root. |
| `runs[].label` | none | Names the run's log (`test-results/<suite>[<label>].log`); unique within a suite. |
| `runs[].timeoutMs` | 600000 | The run is killed as a process tree after this long. |
| `runs[].platform` | `"any"` | `any`, `windows` or `linux`; see [Platforms](#platforms). |
| `runs[].paths` | none | Command runs only: the globs whose changes select the run. With no `paths`, any change selects it. |
| `runs[].env`, `envFile` | none | Extra environment; `envFile` is passed to node as `--env-file` (globs runs only). |
| `runs[].install` | none | An argv run once per lockfile hash in `cwd`, e.g. `["npm", "ci"]`. Refused at the root, because the runner itself was installed there. |
| `runs[].exclude` | none | Globs runs only: path fragments to leave out. |
| `base` | `origin/main`, `main`, `origin/master`, `master` | The diff base is the merge-base with the first of these that exists. |
| `selectAll` | `[]` | Changes here select everything. The config file and the root `package-lock.json` always do. |
| `repoSuite` | none | Takes every non-Markdown change no other suite owns. Without it, such changes are listed as `unowned`. |
| `packages` | `[]` | Globs naming package directories. Within a package, selection follows the import graph. |
| `fallback` | `**/package.json`, `**/package-lock.json` | Changes here run the package's suites whole. |
| `skipDirs` | `[]` | Directory names never walked, on top of `node_modules` and `.git`. |
| `notRun` | `[]` | Test files deliberately run by no suite, each with its reason (see `--orphans`). |
| `wsl` | none | The WSL mirror; see [WSL](#wsl). |

An invalid config exits 2, naming the field, what is wrong, the fix and an example. An unknown field is an error, so a typo never silently does nothing.

## Running

```sh
test-runner                    # the diff: changed tests, plus whatever the diff reaches
test-runner --list             # what would run, and why, without running it
test-runner --all              # every suite
test-runner --suite api        # one suite, whole
test-runner --against main     # measure the diff from this ref
test-runner --fast             # skip files this machine measured over 30 s and unchanged since
test-runner --platform windows # only the Windows-pinned runs and *.win.test.mjs files
test-runner --wsl              # the Linux half, in the WSL mirror
test-runner --orphans          # list test files no suite runs; exit 1 if any
```

`--suite <name> --if-selected` runs the suite whole when the diff selects any of it, and otherwise exits 0 with `not selected by this diff`. This is the CI shape: one job per suite, each deciding for itself.

**Exit codes.** 0 means everything that ran passed, including an empty selection. 1 means a run failed or timed out, a whole-suite run matched no file, or `--orphans` found one. 2 means a request or prerequisite failed: an unknown flag or suite, an invalid config, an unresolvable base, or a missing distro or tool.

### What a diff selects

The changed set is the branch diff since the merge-base, plus uncommitted and untracked files.

- **Inside a `packages` directory**, a change selects the tests that reach it through relative imports, re-exports, literal dynamic imports, `new URL(..., import.meta.url)` and file-name string literals. A `fallback` file, or a non-Markdown file no test reaches, runs the package's suites whole.
- **Outside every package**, a change under a suite's own glob root (for example `tools/map/` for `tools/map/tests/*.test.mjs`) runs that suite whole.
- **A command run** is selected by a change its `paths` match, by any change when it has no `paths`, and by every select-all change.
- **Anything else** that is not Markdown goes to `repoSuite`, or is listed as `unowned`. Markdown nothing reaches selects nothing, and the run reports `docs-only`.
- **`*.win.test.mjs` files** are added to every diff, so they run on every Windows run.

### Platforms

Each run has a `platform`: `any` (the default), `windows` or `linux`. A `*.win.test.mjs` file is always `windows`, whatever its run says.

- **A plain run** executes `any` plus the host's own platform, and names the runs it skipped.
- **`--platform windows`** executes only `windows` runs and `*.win.test.mjs` files. It is allowed only on a Windows host, and exits 2 anywhere else.
- **`--wsl`** runs a plain Linux run in the mirror, so it executes `linux` and `any` runs without the `.win` files.

A Windows developer's full gate is `test-runner --platform windows` plus `test-runner --wsl`, and every run executes exactly once across the two. A Linux CI job runs a plain invocation; a Windows CI job runs `--platform windows`.

### `{base}`

The literal `{base}` inside a command argument is replaced by the diff base, so a gate script can take `["node", "gate.mjs", "--against", "{base}"]`. A whole-suite run that needs it resolves the base from `--against` or `base`.

## WSL

`--wsl` mirrors the working tree into `~/mirror/<repo>` on the distro's own disk and runs this package there. The mirror is a clone of the repository's git directory plus an `rsync` of the files as they are right now, uncommitted ones included. Treat the mirror as disposable.

- **The package runs from a copy.** The host copies this package into `<mirror>/.test-runner/` and runs it from there. The mirror never needs the consumer's own installed copy, and it always runs the host's version.
- **`npm ci` runs once per lockfile hash** at the mirror's root, because `node_modules` is never synced. If the lockfile names the private `test-runner` dependency, git inside the distro needs read access to it. That is one-time setup: an SSH key in the distro with read access to the repository.
- **`wsl.keep`** names paths the sync leaves in place, such as a `target` build cache. `node_modules` is always kept.
- **`wsl.path`** entries are put in front of `PATH` for every mirror run, with `~` expanded. `wsl.exe` starts no login shell, so `~/.cargo/bin` or an nvm `node` is otherwise missing.
- **`wsl.requires`** names tools checked before anything syncs. A missing one exits 2 and names the tool.

**One-time setup.** Install a distro and name it in `wsl.distro` (`wsl.exe -l -q` lists the names). Inside it, install `git`, `rsync`, `node` and whatever your Linux runs need. A missing distro prints `wsl.setup`, so point that at your own setup notes.

## Output

Each file prints a line the moment it finishes, and `… still running (65s): <files>` prints every 60 s while nothing does. At the end the run prints each failure with its error and a code frame, the slowest tests, and the totals. When an agent is detected (`CLAUDECODE`, `AI_AGENT` and the variables `std-env` knows) only failures print; `--reporter=agent|default` overrides the detection. The full record goes to `test-results/<label>.log`. A run killed at its timeout names the files it still had in flight.

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
      # the token step from "Install" goes here
      - run: npm ci
      - run: npx test-runner --suite api ${{ github.event_name == 'pull_request' && format('--if-selected --against {0}', github.event.pull_request.base.sha) || '' }}
```

On `windows-latest`, use the PowerShell token step and add `--platform windows`.
