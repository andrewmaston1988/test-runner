// The two constraints that keep this package installable by a plain copy: it
// imports nothing but builtins and its own files, and it names no consumer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = ["bin", "src"].flatMap((dir) =>
  readdirSync(join(ROOT, dir)).filter((name) => name.endsWith(".mjs")).map((name) => `${dir}/${name}`));

// Every literal module specifier, whatever the import form: `import ... from`,
// `export ... from`, a side-effect `import "x"`, and a dynamic `import("x")`.
// A computed specifier (`import(specifier)`) is not a literal and is not one of
// these -- the runtime path is what the WSL mirror's plain copy relies on.
const LITERAL_SPECIFIERS = [
  /(?:^|\n)\s*(?:import|export)\b[^"'\n]*?\bfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// Comments are stripped first: a doc comment naming `import("x")` is not an
// import, and flagging it would make this check unusable. String literals are
// walked so a `//` inside one (a URL) is not read as a comment.
function stripComments(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      out += "\n";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function bareSpecifiers(text) {
  const found = [];
  for (const pattern of LITERAL_SPECIFIERS) {
    for (const [, spec] of stripComments(text).matchAll(pattern)) {
      if (!spec.startsWith("node:") && !spec.startsWith(".")) found.push(spec);
    }
  }
  return found;
}

test("shipped code imports only node: builtins and relative paths", () => {
  const bad = [];
  for (const file of SHIPPED) {
    for (const spec of bareSpecifiers(readFileSync(join(ROOT, file), "utf8"))) bad.push(`${file}: ${spec}`);
  }
  assert.deepEqual(bad, []);
});

test("the specifier matcher sees every import form, so the check can fail", () => {
  const sample = [
    'import { readFileSync } from "pkg-a";',
    'export { x } from "pkg-b";',
    'import "pkg-c";',
    'await import("pkg-d");',
    'import("./relative.mjs");',
    'import { ok } from "node:fs";',
    '// a doc comment naming `import("pkg-e")` is not an import',
  ].join("\n");
  assert.deepEqual(bareSpecifiers(sample), ["pkg-a", "pkg-b", "pkg-c", "pkg-d"]);
});

// The README's invocations of the old command name: `npx [--no-install] test-runner`, a bare
// `test-runner ...` command at a line start or in inline code, and the `"test": "test-runner"`
// script value. `test-runner.config.mjs`, `.test-runner/`, `<tmpdir>/test-runner/` and the
// package path are not invocations, and headings are the repository's name.
function staleInvocations(text, bin) {
  const bad = [];
  for (const line of text.split("\n")) {
    if (/^#{1,6} /.test(line)) continue;
    // Only an npx in a code position (line start, inline code, a CI `run:`), so prose
    // mentioning npx is not read as a command.
    const npx = [...line.matchAll(/(?:^\s*|`|run:\s+)npx\s+(?:--no-install\s+)?([\w@/.-]+)/g)].map((m) => m[1]);
    const script = [...line.matchAll(/"test":\s*"([\w@/.-]+)/g)].map((m) => m[1]);
    const bare = /(?:^|`)test-runner(?=[\s`]|$)/.test(line);
    if (bare || [...npx, ...script].some((name) => name !== bin)) bad.push(line.trim());
  }
  return bad;
}

test("the README invokes the package by its bin name", () => {
  const bins = Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).bin);
  assert.deepEqual(bins, ["test-runr"]);
  assert.deepEqual(staleInvocations(readFileSync(join(ROOT, "README.md"), "utf8"), "test-runr"), []);
});

test("the invocation matcher sees every stale form, so the check can fail", () => {
  const sample = [
    "Run it with `npx --no-install test-runner`.",
    'Or from a script: `"test": "test-runner"`.',
    "A gate is `test-runner --platform windows` plus more.",
    "test-runner --all              # every suite",
    "      - run: npx test-runner --suite api",
    "# test-runner",
    "With no local install, npx ran it instead.",
    "`test-runner.config.mjs` at the root; the mirror copy is `.test-runner/`.",
    "Run it with `npx --no-install test-runr`, or `\"test\": \"test-runr\"`.",
  ].join("\n");
  assert.equal(staleInvocations(sample, "test-runr").length, 5);
});

test("shipped code names no consumer's suite, path or distro", () => {
  // The repositories this runner was extracted for, and their one-off names.
  const consumer = /claude-plugin-marketplace|rts-mobile|plugin-dev|plugins\/\*/i;
  const bad = SHIPPED.filter((file) => consumer.test(readFileSync(join(ROOT, file), "utf8")));
  assert.deepEqual(bad, []);
});
