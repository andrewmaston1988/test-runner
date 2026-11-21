# Changes — 0.2.0

This release breaks every consumer's install line, commands and imports. Each needs the changes below.

## A new name and command

- The package is now `@andrewmaston1988/test-runner`, and the command is `test-runr`. Update the dependency to `"@andrewmaston1988/test-runner": "github:andrewmaston1988/test-runner#v0.2.0"`, `npx --no-install test-runner` to `npx --no-install test-runr`, and `"test": "test-runner"` scripts to `"test": "test-runr"`.
- The old command name is also the name of an unrelated registry package. With no local install, `npx` ran that package instead, even under `--no-install` once npx had cached it. A missing install now gives an npm error instead.

## A public entry point

- Import from the package root only: `import { validateConfig } from "@andrewmaston1988/test-runner"`. It exports `main`, `validateConfig`, `expandRun`, `skipDirsFor`, `filePlatform`, `hostPlatform` and `platformAllows`.
- Imports of files inside the package, such as `test-runner/src/config.mjs`, now fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. A shim that imported `bin/test-runner.mjs` to run the command now calls `main()` and sets `process.exitCode` from its result.
