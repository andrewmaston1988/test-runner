#!/usr/bin/env node
// The package's one entry point. Everything lives in src/cli.mjs; this file
// only turns its promise into an exit code.

import { main } from "../src/cli.mjs";

// `exitCode` rather than `exit()`: stdout/stderr are async pipes on Windows and
// would be truncated mid-write.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`[test] ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
