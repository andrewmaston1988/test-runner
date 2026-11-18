// Test files no suite runs. A test that is never executed is a green CI that
// proves nothing, so the whole repository is walked -- not just the directories
// the suites happen to name -- with the same walker glob expansion uses.

import * as nodeFs from "node:fs";

import { skipDirsFor } from "./graph.mjs";
import { expandRun, walkFrom } from "./select.mjs";

const TEST_FILE = /\.test\.(?:mjs|js)$/;

/** Every `*.test.mjs`/`*.test.js` under `repoRoot` that no suite's globs expand
 *  to and `notRun` does not list, sorted. `notRun` entries are
 *  `{ path, reason }`; `skipDirs` are the config's extra directories never
 *  walked. A fixture tree holds data a test reads, never a test of its own. */
export function orphanTests(suites, { repoRoot, notRun = [], skipDirs = [], _readdirSync = nodeFs.readdirSync } = {}) {
  const walkSkips = skipDirsFor({ skipDirs });
  const covered = new Set();
  for (const suite of suites) {
    for (const run of suite.runs) {
      for (const file of expandRun(run, { repoRoot, skipDirs: walkSkips, _readdirSync })) covered.add(file);
    }
  }
  const exempt = new Set(notRun.map((entry) => entry.path));
  const files = [];
  walkFrom(repoRoot, "", files, _readdirSync, new Set([...walkSkips, "fixtures"]));
  return files.filter((file) => TEST_FILE.test(file) && !covered.has(file) && !exempt.has(file)).sort();
}
