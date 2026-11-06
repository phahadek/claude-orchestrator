/**
 * JUnit-XML report acquisition: parses a project's declared test_report_glob
 * report file(s) into the normalized StructuredTestResult contract stored on
 * test_request_runs.structured_result. Deliberately dependency-free (no XML
 * library, no db/logger imports): JUnit XML written by pytest/vitest
 * reporters is a small, regular subset of XML — testsuite(s)/testcase
 * elements with attribute-only metadata and at most one failure/error/
 * skipped child — so a couple of targeted regexes cover it without pulling
 * in a general-purpose parser.
 *
 * Split out of session/test-runner.ts so this file has zero dependency on
 * db.ts/queries.ts or any other module with process-wide side effects —
 * session/testReportCollectorWorker.ts imports it directly to run
 * collectStructuredTestResult's readFileSync + parse (the test-lane's
 * dominant main-thread I/O cost for a large suite) on a worker thread. See
 * that file and db/flakyTestRollupWorker.ts's doc comment for why a worker
 * entry point can never import a module that transitively opens the shared
 * main-thread `db` singleton.
 */
import {
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  type Dirent,
} from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';
import type { StructuredTestResult } from '../db/types';

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, ref: string) => {
    if (ref[0] === '#') {
      const codePoint =
        ref[1] === 'x' || ref[1] === 'X'
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return XML_ENTITIES[ref] ?? match;
  });
}

function stripCData(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** Matches every `name="value"`/`name='value'` pair in an XML start-tag's attribute source. */
const XML_ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*'([^']*)'/g;

function parseXmlAttrs(attrsSrc: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  XML_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = XML_ATTR_RE.exec(attrsSrc)) !== null) {
    const name = match[1] ?? match[3];
    const value = match[2] ?? match[4] ?? '';
    attrs[name] = decodeXmlEntities(value);
  }
  return attrs;
}

/** Max characters retained from a failure/error element's inner text. */
const FAILURE_TRACE_EXCERPT_CAP = 2_000;

/** Matches a testcase's first failure/error/skipped child, whichever appears — the backreference ties the closing tag to the same name it opened with. */
const CHILD_OUTCOME_RE =
  /<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;

function extractChildOutcome(content: string): {
  tag: 'failure' | 'error' | 'skipped';
  message?: string;
  text?: string;
} | null {
  const match = content.match(CHILD_OUTCOME_RE);
  if (!match) return null;
  const [, tag, childAttrs, rawText] = match;
  const message = parseXmlAttrs(childAttrs).message;
  const text = rawText
    ? decodeXmlEntities(stripCData(rawText))
        .trim()
        .slice(0, FAILURE_TRACE_EXCERPT_CAP)
    : undefined;
  return {
    tag: tag as 'failure' | 'error' | 'skipped',
    message,
    text: text || undefined,
  };
}

interface JUnitTestCase {
  id: string;
  name: string;
  outcome: 'passed' | 'failed' | 'skipped' | 'error';
  durationMs: number;
  failureMessage?: string;
  failureTraceExcerpt?: string;
  markers?: string[];
}

/**
 * Recovers the `classname` component of a `${classname}.${name}` test id (see
 * the JUnit-XML parse below) — the inverse of that id's construction. Returns
 * null when `testId` carries no classname (id === name, e.g. a runner that
 * emitted no classname attribute), since there's then nothing to derive a
 * file path from.
 */
export function classnameFromTestId(
  testId: string,
  name: string,
): string | null {
  if (testId === name) return null;
  const suffix = `.${name}`;
  return testId.endsWith(suffix) ? testId.slice(0, -suffix.length) : null;
}

/**
 * The flaky-disposition touched-file masking guard (see
 * testRequestLane.ts's evaluateF2LaneFlakyDisposition): whether `testId`
 * can be confidently resolved to a file, and if so whether that file is
 * among `changedFiles` (the PR's diff, from getChangedFiles). classname is
 * dot-separated module/path segments by JUnit convention (pytest's dotted
 * module path, vitest's file-derived classname) — reasonable, but not
 * certain, so callers must fail closed (treat as touched) when `confident`
 * is false rather than assume "not touched".
 */
export function isTestIdTouchedByChangedFiles(
  testId: string,
  name: string,
  changedFiles: string[],
): { touched: boolean; confident: boolean } {
  const classname = classnameFromTestId(testId, name);
  if (!classname) return { touched: true, confident: false };

  const candidatePath = classname.replace(/\./g, '/');
  const touched = changedFiles.some((f) => {
    const noExt = f.replace(/\.[^./]+$/, '');
    return (
      noExt === candidatePath ||
      candidatePath.startsWith(`${noExt}/`) ||
      noExt.endsWith(`/${candidatePath}`)
    );
  });
  return { touched, confident: true };
}

/** Matches a testcase's `<properties>` child block, if present (pytest's record_property/user_properties, vitest's analogous custom-properties mechanism). */
const PROPERTIES_RE = /<properties>([\s\S]*?)<\/properties>/;
const PROPERTY_RE = /<property\b([^>]*?)(?:\/>|>([\s\S]*?)<\/property>)/g;

/**
 * Extracts marker/tag metadata from a testcase's `<properties>` child, if
 * present — a `<property name="markers" value="slow,db"/>` becomes
 * `["slow", "db"]`. Returns undefined when there's no `<properties>` block
 * or no `markers`-named property in it, so a testcase with no marker
 * metadata parses exactly as it did before this property was introduced.
 */
function extractMarkers(caseContent: string): string[] | undefined {
  const propsMatch = caseContent.match(PROPERTIES_RE);
  if (!propsMatch) return undefined;

  const markers: string[] = [];
  PROPERTY_RE.lastIndex = 0;
  let propMatch: RegExpExecArray | null;
  while ((propMatch = PROPERTY_RE.exec(propsMatch[1])) !== null) {
    const attrs = parseXmlAttrs(propMatch[1]);
    if (attrs.name !== 'markers') continue;
    const value =
      attrs.value ?? decodeXmlEntities(stripCData(propMatch[2] ?? '')).trim();
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed) markers.push(trimmed);
    }
  }
  return markers.length > 0 ? markers : undefined;
}

interface JUnitSuite {
  name: string;
  tests: JUnitTestCase[];
}

/**
 * Parses one JUnit-XML report file's contents into its testsuite(s). Tolerant
 * of both a `<testsuites>` wrapper (vitest) and a bare top-level `<testsuite>`
 * (pytest) since the regex scans for `<testsuite` occurrences directly rather
 * than requiring a specific root element.
 */
export function parseJUnitXml(xml: string): JUnitSuite[] {
  const suites: JUnitSuite[] = [];
  const suiteRe = /<testsuite\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testsuite>)/g;
  let suiteMatch: RegExpExecArray | null;
  while ((suiteMatch = suiteRe.exec(xml)) !== null) {
    const [, suiteAttrs, suiteContent = ''] = suiteMatch;
    const suiteName = parseXmlAttrs(suiteAttrs).name ?? 'unknown';
    const tests: JUnitTestCase[] = [];

    const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let caseMatch: RegExpExecArray | null;
    while ((caseMatch = caseRe.exec(suiteContent)) !== null) {
      const [, caseAttrsSrc, caseContent = ''] = caseMatch;
      const caseAttrs = parseXmlAttrs(caseAttrsSrc);
      const name = caseAttrs.name ?? 'unknown';
      const classname = caseAttrs.classname;
      const timeSec = parseFloat(caseAttrs.time ?? '0');
      const durationMs = Number.isFinite(timeSec)
        ? Math.round(timeSec * 1000)
        : 0;
      const id = classname ? `${classname}.${name}` : name;

      const childOutcome = extractChildOutcome(caseContent);

      let outcome: JUnitTestCase['outcome'] = 'passed';
      let failureMessage: string | undefined;
      let failureTraceExcerpt: string | undefined;
      if (childOutcome?.tag === 'error') {
        outcome = 'error';
        failureMessage = childOutcome.message;
        failureTraceExcerpt = childOutcome.text;
      } else if (childOutcome?.tag === 'failure') {
        outcome = 'failed';
        failureMessage = childOutcome.message;
        failureTraceExcerpt = childOutcome.text;
      } else if (childOutcome?.tag === 'skipped') {
        outcome = 'skipped';
        failureMessage = childOutcome.message;
      }

      const markers = extractMarkers(caseContent);

      tests.push({
        id,
        name,
        outcome,
        durationMs,
        ...(failureMessage ? { failureMessage } : {}),
        ...(failureTraceExcerpt ? { failureTraceExcerpt } : {}),
        ...(markers ? { markers } : {}),
      });
    }

    suites.push({ name: suiteName, tests });
  }
  return suites;
}

/** Directories skipped while walking the worktree for report-glob matches. */
const REPORT_WALK_SKIP_DIRS = new Set(['node_modules', '.git']);

function listWorktreeFiles(worktreePath: string): string[] {
  const results: string[] = [];
  function walk(dir: string, relPrefix: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (REPORT_WALK_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  }
  walk(worktreePath, '');
  return results;
}

function matchReportFiles(worktreePath: string, reportGlob: string): string[] {
  return listWorktreeFiles(worktreePath)
    .filter((rel) => minimatch(rel, reportGlob, { dot: true }))
    .sort();
}

/**
 * Deletes every file matching `reportGlob` under `worktreePath`, walking the
 * tree the same way collectStructuredTestResult does (matchReportFiles) so
 * cleanup and collection can never disagree about what counts as a report
 * file. Called before a run's test commands execute so that a command which
 * fails/crashes before its runner's normal teardown leaves no report file
 * behind to be mistaken for this run's output — collectStructuredTestResult's
 * glob then finds nothing for that command rather than a stale prior report.
 * Best-effort: a file that fails to delete (permissions, already removed) is
 * skipped rather than throwing, since acquisition's freshness check
 * (collectStructuredTestResult's `startedAt`) is the backstop for exactly
 * that case.
 */
export function clearReportFiles(
  worktreePath: string,
  reportGlob: string,
): void {
  for (const rel of matchReportFiles(worktreePath, reportGlob)) {
    try {
      unlinkSync(path.join(worktreePath, rel));
    } catch {
      // best-effort — freshness check in collectStructuredTestResult backstops this
    }
  }
}

/**
 * Glob-matches report files under `worktreePath`, parses each as JUnit XML,
 * and merges every matched file's suites into one normalized
 * StructuredTestResult. No suite/test-id namespacing is applied across
 * files — pytest's and vitest's junit reporters already qualify names by
 * file/module, so merging multiple report files under one glob does not
 * collide (see the parent design task's completeness-critic finding).
 *
 * Returns null when the glob matches nothing (report not written — e.g. the
 * run was killed before teardown) — the caller leaves structured_result
 * null in that case rather than persisting an empty/misleading result.
 *
 * `expectedReportCount` is the number of test commands that were run (each
 * command conventionally writes its own report file under the shared glob —
 * see .claude-orchestrator.yml's test_report_glob comment). When fewer
 * report files are found than commands ran, at least one command's report
 * never got written (e.g. it crashed/OOM-killed before its runner's normal
 * teardown) — the returned result is marked `incomplete: true` so this
 * partial merge is never indistinguishable from a genuinely complete one.
 *
 * `startedAt`, when given, is a Date.now() timestamp captured before the
 * run's test commands executed. Any matched file whose mtime predates it is
 * excluded from the merge (and from the matched-file count feeding
 * `incomplete`) — it wasn't written by this run, so ingesting its contents
 * would misattribute a stale/previous run's per-test results to this one.
 * This is defense-in-depth alongside clearReportFiles' pre-run cleanup, not
 * a replacement for it — cleanup already makes a fully-missing report caught
 * by the expectedReportCount check; this guards the case cleanup missed
 * (permission failure, glob/walk mismatch).
 */
export function collectStructuredTestResult(
  worktreePath: string,
  reportGlob: string,
  expectedReportCount = 1,
  startedAt?: number,
): StructuredTestResult | null {
  const allMatched = matchReportFiles(worktreePath, reportGlob);
  const matchedFiles =
    startedAt === undefined
      ? allMatched
      : allMatched.filter((rel) => {
          try {
            return statSync(path.join(worktreePath, rel)).mtimeMs >= startedAt;
          } catch {
            return false;
          }
        });
  if (matchedFiles.length === 0) return null;

  const suites: JUnitSuite[] = [];
  for (const rel of matchedFiles) {
    let xml: string;
    try {
      xml = readFileSync(path.join(worktreePath, rel), 'utf8');
    } catch {
      continue;
    }
    suites.push(...parseJUnitXml(xml));
  }
  if (suites.length === 0) return null;

  const totals = { passed: 0, failed: 0, skipped: 0, errors: 0 };
  let durationMsTotal = 0;
  for (const suite of suites) {
    for (const test of suite.tests) {
      durationMsTotal += test.durationMs;
      if (test.outcome === 'passed') totals.passed++;
      else if (test.outcome === 'failed') totals.failed++;
      else if (test.outcome === 'skipped') totals.skipped++;
      else if (test.outcome === 'error') totals.errors++;
    }
  }

  return {
    format: 'junit-xml',
    suites,
    totals,
    durationMsTotal,
    ...(matchedFiles.length < expectedReportCount ? { incomplete: true } : {}),
  };
}
