// One dispatch's temp root: every test process the runner starts sees TEMP,
// TMP and TMPDIR inside it, so the dirs a test makes land under one named
// parent instead of scattering through the OS temp dir. A passing run removes
// its root; a failing or timed-out one keeps it as evidence.

import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** All three on every platform. Cheap, and a WSL or Git Bash child reads
 *  whichever its own platform's runtime uses. */
const TEMP_VARS = ["TEMP", "TMP", "TMPDIR"];

/** Labels carry `[`/`]` (from `suite[label]`); a directory name is easier to
 *  read beside the rest of `%TEMP%` without them. */
function safe(text) {
  return text.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** An empty root holds no evidence, so it is removed even after a failure. An
 *  unreadable one is kept rather than guessed at. */
function emptyRoot(fs, path) {
  try {
    return fs.readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/** Run `fn(tempEnv)` with a fresh `<tmpdir>/test-runner/<label>-XXXXXX` as the
 *  temp root, spreading `tempEnv` into the child's spawn env.
 *
 *  A `runEnv` naming any of TEMP, TMP or TMPDIR opts the run out: its value
 *  wins and no root is created. Otherwise the root is removed when `fn`
 *  resolves to a passing result (or leaves it empty) and kept, named on one
 *  log line, when the run failed, timed out or threw. A failed removal is a
 *  log line, never a failure: the run's result is the run's own. */
export async function withTempRoot({
  label,
  runEnv = {},
  _fs = nodeFs,
  _tmpdir = tmpdir,
  _log = () => {},
}, fn) {
  if (TEMP_VARS.some((name) => runEnv[name] !== undefined)) return fn({});

  const parent = join(_tmpdir(), "test-runner");
  _fs.mkdirSync(parent, { recursive: true });
  const root = _fs.mkdtempSync(join(parent, `${safe(label)}-`));
  const tempEnv = { TEMP: root, TMP: root, TMPDIR: root };

  let result;
  try {
    result = await fn(tempEnv);
  } catch (err) {
    // The throw is the caller's to report; the root it may have written to
    // stays where the evidence is.
    _log(`[test] ${label}: temp root kept at ${root}`);
    throw err;
  }

  if (result?.ok || emptyRoot(_fs, root)) {
    try {
      _fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      // A process outliving the run on Windows can hold a file open. One named
      // dir under the shared parent is bounded; a failed run is not.
      _log(`[test] ${label}: could not remove temp root ${root} (${err.code})`);
    }
    return result;
  }

  _log(`[test] ${label}: temp root kept at ${root}`);
  return result;
}
