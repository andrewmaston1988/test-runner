# Changes — Unreleased

## Kept temp roots are pruned

- A failed or timed-out run keeps its temp root as evidence. Every run now prunes the kept roots first: it keeps the newest three per suite label and removes anything older than three days, so recent failures stay inspectable without the temp dir growing without bound. A root written to within the last day is never touched, since a dispatch still running may own it, and those roots take no keep slot. There is no command to run.

# Changes — 0.2.0

This release changes how every project installs, runs and imports the runner. Each project needs the updates below once.

## A new name and command

- The package is now `@andrewmaston1988/test-runner` and the command is `test-runr`. Install it with `"@andrewmaston1988/test-runner": "github:andrewmaston1988/test-runner#v0.2.0"`, run it as `npx --no-install test-runr`, and point any `"test"` script at `test-runr`.
- The old command name also belongs to an unrelated package on the npm registry. In a checkout without its dependencies installed, `npx` used to run that package instead, sometimes even with `--no-install`. Now a missing install stops with an npm error instead of running the wrong tool.

## One public entry point

- Code that uses the runner's functions now imports them from the package itself, not from files inside it. The functions projects already use are all available there.
- Importing a file from inside the package now fails at once. The runner's internal files can be reorganised without breaking any project.
