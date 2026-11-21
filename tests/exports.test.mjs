// The package's public surface: consumers import from the package root and
// nothing else. Node resolves a package's own name from inside it once
// `exports` exists, so these imports need no install.
import { test } from "node:test";
import assert from "node:assert/strict";

const NAME = "@andrewmaston1988/test-runner";

// Every name a consumer imports today. A name dropped from src/index.mjs
// breaks a consumer, so it fails here first.
const PUBLIC = ["validateConfig", "expandRun", "skipDirsFor", "filePlatform", "hostPlatform", "platformAllows", "main"];

test("the package root exports every name consumers use", async () => {
  const api = await import(NAME);
  const missing = PUBLIC.filter((name) => typeof api[name] !== "function");
  assert.deepEqual(missing, []);
});

test("a deep import into src/ is refused", async () => {
  await assert.rejects(import(`${NAME}/src/config.mjs`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});
