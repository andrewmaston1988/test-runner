# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub's **Report a vulnerability** button on the repository's Security tab. Please don't open a public issue for it.

Include what you ran, what happened and the version (the tag your `package.json` pins). You'll get an acknowledgement within a week.

## Scope

test-runner executes the commands and test files a repository's own `test-runner.config.mjs` names. That config is code you trust, the same way you trust your `package.json` scripts. Running test-runner against a repository you don't trust is equivalent to running its tests, and is out of scope.

Reports that are in scope:
- a command argument reaching a shell when the config gave it as one argv element;
- `--wsl` syncing or running anything outside the repository and its mirror;
- a path in the config escaping the repository root.

## Supported versions

Only the latest tag receives fixes.
