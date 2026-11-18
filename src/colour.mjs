// ANSI colour, resolved once by the parent and handed to the reporter child as
// TEST_COLOUR. The rule is the skills reporter's, plus NO_COLOR.

export const CODES = { green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };
// Default foreground only: a test's own captured colour must survive around it.
export const RESET = "\x1b[39m";

export function paint(on, code, text) {
  return on ? `${code}${text}${RESET}` : text;
}

/** FORCE_COLOR wins (set at all, even empty, unless it is "0"), then agent mode
 *  never colours -- ANSI is a token an agent pays for and cannot see -- then
 *  NO_COLOR, then a TTY or CI. */
export function resolveColour({ env = process.env, stream = null, mode = "default" } = {}) {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (mode === "agent") return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return Boolean(stream && stream.isTTY) || Boolean(env.CI);
}
