// The one repo-relative path convention: posix separators, `""` for the
// repository root itself, and the absolute path for anything outside it. The
// cargo graph, the reporter's rows and the selection all name files this way,
// so a path recorded by one is a path the others recognise.

import { isAbsolute, relative, sep } from "node:path";

export function toPosix(path) {
  return String(path).replace(/\\/g, "/");
}

export function repoRelative(repoRoot, abs) {
  const rel = relative(String(repoRoot), String(abs));
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return toPosix(abs);
  return toPosix(rel);
}
