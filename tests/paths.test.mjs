// The shared path convention (src/paths.mjs): one answer to "how is a file
// named", used by the cargo graph, the reporter's rows and the selection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { repoRelative, toPosix } from "../src/paths.mjs";
import { makeRepo } from "./helpers.mjs";

test("repoRelative is repo-relative posix, empty at the root, absolute outside", (t) => {
  const repo = makeRepo(t);
  assert.equal(repoRelative(repo, join(repo, "crates", "alpha", "Cargo.toml")), "crates/alpha/Cargo.toml");
  assert.equal(repoRelative(repo, repo), "");
  assert.equal(
    repoRelative(repo, join(repo, "..", "elsewhere", "x")),
    join(repo, "..", "elsewhere", "x").replace(/\\/g, "/"),
  );
});

test("toPosix converts the separator on every host, not only the current one", () => {
  assert.equal(toPosix("crates\\alpha\\src\\lib.rs"), "crates/alpha/src/lib.rs");
  assert.equal(toPosix("crates/alpha/src/lib.rs"), "crates/alpha/src/lib.rs");
});
