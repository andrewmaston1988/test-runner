// The consumer's config: `test-runner.config.mjs` at the repository root,
// default-exporting a plain object. Every suite, path, base branch and distro
// the runner uses comes from here -- the package carries no consumer's names.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_NAME = "test-runner.config.mjs";

/** Base-ref candidates for a diff run, tried in order. */
export const DEFAULT_BASE = ["origin/main", "main", "origin/master", "master"];

/** A change to one of these inside a package runs that package's suites whole:
 *  the import graph cannot see what a manifest or lockfile changes. */
export const DEFAULT_FALLBACK = ["**/package.json", "**/package-lock.json"];

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The config could not be found, loaded or validated. Exit 2. */
export class ConfigError extends Error {}

/** `raw` with every optional field defaulted. Validation is `validateConfig`'s
 *  job; this only fills gaps, so it never throws on a well-formed object. */
export function normalizeConfig(raw, { configPath = CONFIG_NAME } = {}) {
  const wsl = raw.wsl
    ? {
      distro: raw.wsl.distro,
      setup: raw.wsl.setup ?? "",
      keep: raw.wsl.keep ?? [],
      path: raw.wsl.path ?? [],
      requires: raw.wsl.requires ?? [],
    }
    : null;
  return {
    base: raw.base ?? DEFAULT_BASE,
    selectAll: raw.selectAll ?? [],
    repoSuite: raw.repoSuite ?? null,
    packages: raw.packages ?? [],
    fallback: raw.fallback ?? DEFAULT_FALLBACK,
    skipDirs: raw.skipDirs ?? [],
    notRun: raw.notRun ?? [],
    wsl,
    configPath,
    suites: (raw.suites ?? []).map((suite) => ({
      ...suite,
      runs: suite.runs.map((run) => ({
        cwd: ".",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        platform: "any",
        ...run,
      })),
    })),
  };
}

/** The config file's repo-relative posix path: `--config` wins, else the root
 *  file. A path outside the repository is refused -- the always-select-all rule
 *  for the config file needs it to be a path a diff can name. */
export function configPathFor({ repoRoot, override = null }) {
  if (!override) return CONFIG_NAME;
  const abs = isAbsolute(override) ? override : join(repoRoot, override);
  const rel = relative(repoRoot, abs).split("\\").join("/");
  if (rel === "" || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    throw new ConfigError(`--config ${override} is outside the repository at ${repoRoot}`);
  }
  return rel;
}

/** Import the config file and return its default export. A missing file names
 *  the location and the fix; a file that throws on import names the error. */
export async function loadConfigFile({
  repoRoot,
  configPath,
  _exists = existsSync,
  _import = (url) => import(url),
}) {
  const abs = join(repoRoot, configPath);
  if (!_exists(abs)) {
    throw new ConfigError(
      `no config at ${configPath}. Create it at the repository root, for example:\n\n`
      + "  export default {\n"
      + "    suites: [\n"
      + '      { name: "unit", runs: [{ globs: ["tests/*.test.mjs"] }] },\n'
      + "    ],\n"
      + "  };\n",
    );
  }
  let mod;
  try {
    mod = await _import(pathToFileURL(abs).href);
  } catch (err) {
    throw new ConfigError(`${configPath} failed to load: ${err && err.message ? err.message : err}`);
  }
  if (!mod || mod.default === undefined) {
    throw new ConfigError(`${configPath} has no default export. Write \`export default { suites: [...] };\``);
  }
  return mod.default;
}
