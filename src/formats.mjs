// Parsers for command-run output formats. `parseOutput` is the one entry the
// runner calls; each built-in parser turns a captured stream into the same
// event shape -- `{ name, outcome: "pass" | "fail" | "skip", ms }` -- with `ms`
// null whenever the producer prints no per-test time, `chain` naming the
// enclosing subtests where the format nests, `detail` holding a failure's own
// output and `todo: true` on a TAP `# TODO`. Events carry only the keys that
// apply: an un-nested test has no `chain`, an un-timed one keeps `ms: null`.
// Exit codes are the caller's verdict; nothing here reads them.

export function parseOutput(format, { stdout = "", stderr = "", exitCode = null, report = null } = {}) {
  switch (format) {
    case "tap":
      return parseTap(String(stdout ?? ""));
    case "libtest":
      return parseLibtest(`${stdout ?? ""}\n${stderr ?? ""}`);
    case "junit":
      // The file a `{report}` producer wrote is the input once it exists;
      // stdout is the fallback for producers that print the XML instead.
      return parseJunit(report && typeof report.text === "string" ? report.text : String(stdout ?? ""));
    default:
      return [];
  }
}

// The skip args of a `--fast` fastSkip run. Formats have no shared skip
// convention, so the run's own format decides: junit deselects by nodeid,
// everything else -- tap and libtest included -- runs whole and warns.

/** One `--deselect` pair per long-running test, in the order the producer's
 *  own argv takes them. Tests without a nodeid (bare-number entries, records
 *  the default junit family wrote) deselect nothing but keep their line. */
export function fastSkipArgs(run, tests) {
  if (!run.fastSkip) return { args: [], names: [] };
  if (run.format !== "junit") return { args: [], names: [], warn: true };
  return {
    args: tests.filter((test) => test.nodeid).flatMap((test) => ["--deselect", test.nodeid]),
    names: tests.map((test) => test.name),
    warn: false,
  };
}

// --- TAP --------------------------------------------------------------------
// The node --test --test-reporter=tap shape (probed 2026-11-17): a point's
// subtests print BEFORE the point itself, so the `# Subtest:` banners still
// open when a point arrives are its chain -- every banner indented less than
// the point. Each point is followed by a YAML block between two same-indent
// fence lines (`  ---` ... `  ...`); the block's `duration_ms` becomes the
// point's ms (Math.round), the remaining lines become its detail.

const TAP_POINT = /^(\s*)(not ok|ok)\s+(?:(\d+)\s+-\s+)?(.*?)(?:\s+#\s+(SKIP|skip|TODO|todo))?\s*$/;
const TAP_BANNER = /^\s*#\s*Subtest:\s*(.+?)\s*$/;

const indentOf = (line) => line.match(/^\s*/)[0].length;

function parseTap(text) {
  const events = [];
  let banners = []; // `# Subtest:` scopes still open, outermost first
  let pending = null; // the point waiting for its YAML block
  let block = null; // { indent, lines } while inside `  ---` ... `  ...`

  for (const raw of String(text).split(/\r?\n/)) {
    if (block) {
      if (/^\s*\.\.\.\s*$/.test(raw) && indentOf(raw) === block.indent) {
        applyTapYaml(pending, block);
        block = null;
      } else {
        block.lines.push(raw);
      }
      continue;
    }
    const point = TAP_POINT.exec(raw);
    if (point) {
      const [, prefix, okWord, , name, directive] = point;
      const indent = prefix.length;
      const chain = banners.filter((b) => b.indent < indent).map((b) => b.name);
      banners = banners.filter((b) => b.indent < indent);
      const event = {
        name,
        // A directive outranks the point's own word: `not ok ... # TODO` is a
        // skip that is expected to fail, not a failure.
        outcome: directive ? "skip" : okWord === "ok" ? "pass" : "fail",
        ms: null,
      };
      if (directive && /todo/i.test(directive)) event.todo = true;
      if (chain.length > 0) event.chain = chain;
      events.push(event);
      pending = event;
      continue;
    }
    const banner = TAP_BANNER.exec(raw);
    if (banner) {
      pending = null; // a block opening must follow its point directly
      banners.push({ name: banner[1], indent: indentOf(raw) });
      continue;
    }
    if (/^\s*---\s*$/.test(raw) && pending) {
      block = { indent: indentOf(raw), lines: [] };
      continue;
    }
    // Version lines, plans, comments and `Bail out!` are notices only.
    if (!/^\s*$/.test(raw)) pending = null;
  }
  return events;
}

function applyTapYaml(event, block) {
  const detail = [];
  for (const raw of block.lines) {
    const duration = /^\s*duration_ms:\s*(.+?)\s*$/.exec(raw);
    if (duration) {
      const value = Number(duration[1]);
      if (Number.isFinite(value)) event.ms = Math.round(value);
      continue;
    }
    detail.push(raw.slice(block.indent));
  }
  while (detail.length > 0 && detail[detail.length - 1].trim() === "") detail.pop();
  while (detail.length > 0 && detail[0].trim() === "") detail.shift();
  if (detail.length > 0) event.detail = detail.join("\n");
}

// --- libtest ----------------------------------------------------------------
// cargo's shape, plain and nightly --format json mixed (probed 2026-11-17).
// Plain lines: `test <name> ... ok|FAILED|ignored`. Failure blocks are
// anchored on the real header `---- <name> stdout ----` and end at the next
// `----` line or the `failures:` section -- a block's content is never parsed
// as test lines. JSON objects one per line: suite events and `started` are
// notices; a test's `ok`/`failed`/`ignored`/`timeout` is the event, `timeout`
// a failure. Probed cargo prints no per-test duration in either mode, so
// every event is un-timed and none can enter the slowest list.

const LIBTEST_POINT = /^\s*test (.+?) \.\.\. (ok|FAILED|ignored)\s*$/;
const LIBTEST_HEADER = /^---- (.+?) ----$/;

function parseLibtest(text) {
  const events = [];
  let block = null; // { name, lines } of an open failure block

  for (const raw of String(text).split(/\r?\n/)) {
    if (block) {
      if (LIBTEST_HEADER.test(raw) || /^failures:\s*$/.test(raw)) {
        applyLibtestBlock(events, block);
        block = null;
      } else {
        block.lines.push(raw);
        continue;
      }
    }
    const header = LIBTEST_HEADER.exec(raw);
    if (header) {
      block = { name: header[1].replace(/\s+stdout$/, ""), lines: [] };
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      applyLibtestJson(events, trimmed);
      continue;
    }
    const point = LIBTEST_POINT.exec(raw);
    if (point) {
      const outcome = point[2] === "ok" ? "pass" : point[2] === "ignored" ? "skip" : "fail";
      events.push({ name: point[1], outcome, ms: null });
    }
    // `running N tests`, `test result:`, `failures:` name lists, `Doc-tests`
    // headers and compiler chatter are notices only.
  }
  return events;
}

function applyLibtestJson(events, line) {
  let object;
  try {
    object = JSON.parse(line);
  } catch {
    return; // a "{"-led line that is not an object is chatter
  }
  if (!object || typeof object !== "object" || object.type !== "test") return;
  const event = object.event;
  if (event === "ok") {
    events.push({ name: String(object.name), outcome: "pass", ms: null });
  } else if (event === "failed" || event === "timeout") {
    const entry = { name: String(object.name), outcome: "fail", ms: null };
    if (typeof object.stdout === "string" && object.stdout) entry.detail = object.stdout;
    events.push(entry);
  } else if (event === "ignored") {
    events.push({ name: String(object.name), outcome: "skip", ms: null });
  }
}

function applyLibtestBlock(events, block) {
  const lines = [...block.lines];
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return;
  const target = events.find(({ name }) => name === block.name);
  if (target) target.detail = lines.join("\n");
}

// --- JUnit ------------------------------------------------------------------
// The common <testsuites>/<testsuite>/<testcase> shapes: a <failure>/<error>
// child fails the case with its `message` attribute (else its body) as detail,
// <skipped> skips it, and `time` (seconds) becomes rounded ms. Only a `file`
// attribute yields a deselectable nodeid -- the classname-qualified form is
// display only. Namespaces, CDATA and exotic producers take the shim.

const JUNIT_ATTR = /([A-Za-z_][\w.:-]*)="([^"]*)"/g;

function xmlUnescape(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function junitAttrs(tag) {
  const out = {};
  for (const match of String(tag ?? "").matchAll(JUNIT_ATTR)) out[match[1]] = xmlUnescape(match[2]);
  return out;
}

/** A `<testcase ...>...</testcase>` body with every element stripped and
 *  entities decoded: a `<failure>` without a message attribute hands its text
 *  over as detail. */
function junitBody(raw) {
  return xmlUnescape(String(raw ?? "").replace(/<[^>]*>/g, "")).trim();
}

/** Every `<testcase>` of one report, self-closing or element, in document
 *  order. The open tag is matched exactly (`[^>]*>` cannot cross the tag's own
 *  `>`), so a case's body never swallows the next case: an element case's body
 *  stops at its first `</testcase` and the walk resumes past the closing tag.
 *  Attributes come off the open tag; the body of an element case rides along
 *  for its failure/error/skipped children. */
function junitCases(text) {
  const out = [];
  const open = /<testcase\b([^>]*)>/g;
  for (let match; (match = open.exec(text));) {
    const tag = match[1];
    const attrs = junitAttrs(tag.replace(/\/\s*$/, ""));
    if (/\/\s*$/.test(tag)) {
      out.push({ at: match.index, attrs, body: "" });
      continue;
    }
    const close = text.indexOf("</testcase", match.index + match[0].length);
    out.push({
      at: match.index,
      attrs,
      body: close === -1 ? "" : text.slice(match.index + match[0].length, close),
    });
    open.lastIndex = close === -1 ? match.index + match[0].length : close;
  }
  return out;
}

function parseJunit(text) {
  const events = [];
  for (const { attrs, body } of junitCases(String(text ?? ""))) {
    const rawName = attrs.name ?? "";
    const event = {
      // The display name is the classname-qualified form both junit families
      // print; without a classname the bare name is all there is.
      name: attrs.classname ? `${attrs.classname}::${rawName}` : rawName,
      outcome: "pass",
      ms: null,
    };
    const seconds = Number(attrs.time);
    if (attrs.time !== undefined && Number.isFinite(seconds)) event.ms = Math.round(seconds * 1000);
    const failed = /<(?:failure|error)[\s/>]/.exec(body);
    const skipped = /<skipped[\s/>]/.exec(body);
    if (skipped) event.outcome = "skip";
    else if (failed) {
      event.outcome = "fail";
      // The message attribute is the producer's own one-liner; the element is
      // the detail's source only when there is no message to name. A
      // self-closing element carries its message on the open tag alone.
      const tag = /<(?:failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)\s*>)/.exec(body);
      const message = tag ? junitAttrs(tag[1]).message : undefined;
      event.detail = message !== undefined && message !== "" ? message : junitBody(tag ? tag[2] : "");
      if (event.detail === "") delete event.detail;
    }
    // Only a `file` attribute yields a real, deselectable nodeid. The
    // classname-qualified form is display detail; recording it would make
    // `--fast` log a skip the producer never honours.
    if (attrs.file && rawName !== "") event.nodeid = `${attrs.file}::${rawName}`;
    events.push(event);
  }
  return events;
}
