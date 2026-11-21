// The package's one public module: the `exports` map points here, so this file
// is the contract consumers import against. Re-exports only; a name a consumer
// needs is added here, never reached by a deep import.

export { main } from "./cli.mjs";
export { validateConfig } from "./config.mjs";
export { skipDirsFor } from "./graph.mjs";
export { filePlatform, hostPlatform, platformAllows } from "./run.mjs";
export { expandRun } from "./select.mjs";
