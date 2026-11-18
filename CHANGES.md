# Changes — 0.1.0

The first public release: one config file runs a repository's tests, picks only the ones a diff
can affect, and prints the result in one clean, coloured format whatever produced it.

## Selecting tests from a diff

- Selects test files by the JavaScript (ESM) import graph, including re-exports,
  literal dynamic imports, `new URL(...)` and files named as string literals, resolved across the
  whole repository rather than one package.
- Python suites select by their import closure, the way pytest resolves imports: configured
  `pythonpath` roots, relative dots, packages, and every `conftest.py` above a test. An import that
  resolves on no configured root still matches the in-repo module it names, so a test that adds its
  own `sys.path` entry is not skipped.
- Rust workspaces select by crate: a change runs `cargo test -p` for the crate that owns it and
  every crate that depends on it.
- Runs can declare `paths` globs, as an explicit claim alongside the graph, and a suite can opt into
  `select: "paths"` to use its declared globs alone.
- Tests that walk directories or load modules by computed path are detected and always run.
- When a change cannot be traced, its suite runs whole, and a warning says which file caused it.

## Running anything

- Command runs execute any test command, with a per-run timeout, platform filter, environment and
  install step. On Windows, `.cmd` and `.bat` tools run without a shell.
- Command output in TAP, Rust's libtest or JUnit XML (pytest, Pester) is parsed into per-test rows;
  anything else can be parsed by a small `.mjs` shim the repository supplies.
- Python suites run through a configured runner such as `python -m pytest`, with the selected files
  as arguments.
- `--wsl` runs the Linux half of a suite in a WSL mirror of the repository.
- `--fast` skips the files and tests recorded as long-running, including pytest tests by node id.

## Output

- A vitest-style tree: one row per file and per test, green ticks, red crosses, amber skips, with
  each time turning amber at the slow threshold (`slowMs`, default 300 ms; `--slow-ms` overrides).
- Coloured totals and a slowest-tests list; colour follows the terminal, `NO_COLOR` and
  `FORCE_COLOR`.
- An agent mode that prints only failures and the pass/fail line, for runs inside AI coding tools.
- Full logs per run under `test-results/`, and a heartbeat while a quiet run is still working.
