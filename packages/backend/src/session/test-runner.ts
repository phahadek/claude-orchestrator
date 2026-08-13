import { spawn } from 'child_process';
import { readFileSync, readdirSync, type Dirent } from 'fs';
import path from 'path';
import { platform } from 'process';
import { minimatch } from 'minimatch';
import type { StructuredTestResult } from '../db/types';

export interface TestCommandResult {
  passed: boolean;
  output: string;
  timedOut?: boolean;
  oomKilled?: boolean;
}

export interface TestRunOptions {
  /** Max RSS in MB per subprocess; 0 (default) = no limit. Linux-only. */
  maxRssMb?: number;
  /** Stop running subsequent commands after the first failure. Default false. */
  failFast?: boolean;
}

const OUTPUT_CAP_CHARS = 50_000;

/** Collapse a run of the same non-newline char repeated this many times or more. */
const PROGRESS_RUN_THRESHOLD = 20;

/**
 * Time to wait after a graceful SIGINT before escalating to SIGKILL. Counted
 * as part of the overall run budget (timeoutMs + GRACE_PERIOD_MS), so a
 * command that ignores SIGINT still terminates within a bounded wall-clock
 * window rather than hanging indefinitely.
 */
const GRACE_PERIOD_MS = 5_000;

/**
 * Test runners (pytest, vitest) print long runs of the same progress
 * character (dots, F's) before their diagnosis at the end. Collapsing those
 * runs frees up cap budget for the informative tail rather than burning it
 * on noise.
 */
export function collapseProgressRuns(text: string): string {
  return text.replace(
    new RegExp(`([^\\n])\\1{${PROGRESS_RUN_THRESHOLD - 1},}`, 'g'),
    (match, ch: string) =>
      `${ch}[...${match.length - 1} more '${ch}' elided...]`,
  );
}

/**
 * Retains the tail of `output` for delivery into a session's feedback
 * inbox — a test runner's failure diagnosis prints last, so keeping the
 * head (a naive slice(0, cap)) discards exactly the informative part.
 * Below the cap, returns `output` unchanged.
 */
export function truncateForDelivery(output: string, cap: number): string {
  return output.length > cap ? '[truncated]...\n' + output.slice(-cap) : output;
}

function killProcessTree(pid: number): void {
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { detached: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // best-effort
  }
}

/**
 * Ask the process group to terminate gracefully so runners like pytest and
 * vitest can reach their normal teardown (summary printing, report writes).
 * No graceful equivalent exists on Windows' taskkill path, so that platform
 * is left untouched.
 */
function interruptProcessTree(pid: number): void {
  try {
    process.kill(-pid, 'SIGINT');
  } catch {
    // best-effort
  }
}

export function getChildRssMb(
  pid: number,
  _platform: NodeJS.Platform = process.platform,
  readFn: (path: string) => string = (p) => readFileSync(p, 'utf8') as string,
): number {
  if (_platform !== 'linux') return 0;
  try {
    const data = readFn(`/proc/${pid}/status`);
    const match = data.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (match) return parseInt(match[1], 10) / 1024;
  } catch {
    // process may have exited
  }
  return 0;
}

function runCommandWithTimeout(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  maxRssMb: number,
): Promise<{
  exitCode: number;
  output: string;
  timedOut: boolean;
  oomKilled: boolean;
}> {
  return new Promise((resolve) => {
    // Strip production data-plane env before the child spawns. A test
    // command runs `vitest run` (or similar) in a worktree; DB_PATH pointing
    // at the live orchestrator database must never reach it, or a test that
    // reads DB_PATH before its own in-memory-DB guard runs (or a subprocess
    // it spawns) could open and write to production data. See
    // CliSessionRunner.ts's identical strip for the session-spawn path.
    const { DB_PATH: _productionDbPath, ...env } = process.env;
    const spawnOpts =
      platform === 'win32'
        ? { shell: true, cwd, env }
        : { shell: true, cwd, env, detached: true };

    const proc = spawn(cmd, spawnOpts);
    let chunks: Buffer[] = [];
    let headDroppedChars = 0;
    let settled = false;
    let rssPoller: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    // Set once escalation begins (timeout or OOM). Preserved so a graceful
    // exit during the grace period is still reported as timedOut/oomKilled
    // rather than misreported as a normal completion.
    let escalation: {
      timedOut: boolean;
      oomKilled: boolean;
      marker: string;
    } | null = null;

    // Retains the *tail* of the stream — a test runner's diagnosis (failure
    // summary, traceback) always prints last, after uninformative progress
    // output. Collapses progress-character runs first so the retained
    // window isn't wasted on noise, then trims to the last OUTPUT_CAP_CHARS
    // characters, recording how much was dropped from the head.
    function collect(d: Buffer) {
      chunks.push(d);
      let text = collapseProgressRuns(Buffer.concat(chunks).toString('utf8'));
      if (text.length > OUTPUT_CAP_CHARS) {
        const excess = text.length - OUTPUT_CAP_CHARS;
        headDroppedChars += excess;
        text = text.slice(excess);
      }
      chunks = [Buffer.from(text, 'utf8')];
    }

    function collectedOutput(): string {
      const text = Buffer.concat(chunks).toString('utf8');
      return headDroppedChars > 0
        ? `[test-runner] output truncated: ${headDroppedChars} char(s) elided from head\n${text}`
        : text;
    }

    function settle(result: {
      exitCode: number;
      output: string;
      timedOut: boolean;
      oomKilled: boolean;
    }) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (rssPoller !== null) clearInterval(rssPoller);
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve(result);
    }

    // Escalate: SIGINT the process group so the runner can reach its normal
    // teardown (failure summary, report file), keep collecting output for a
    // bounded grace period, then SIGKILL if it hasn't exited by then. Settles
    // only once the process exits or the grace period elapses — never before.
    function escalate(timedOut: boolean, oomKilled: boolean, marker: string) {
      if (escalation !== null || settled) return;
      escalation = { timedOut, oomKilled, marker };

      if (proc.pid == null) {
        settle({
          exitCode: 1,
          output: collectedOutput() + marker,
          timedOut,
          oomKilled,
        });
        return;
      }

      if (platform === 'win32') {
        // No graceful equivalent to taskkill /F /T; keep prior behavior.
        killProcessTree(proc.pid);
        settle({
          exitCode: 1,
          output: collectedOutput() + marker,
          timedOut,
          oomKilled,
        });
        return;
      }

      interruptProcessTree(proc.pid);
      graceTimer = setTimeout(() => {
        if (proc.pid != null) killProcessTree(proc.pid);
        settle({
          exitCode: 1,
          output: collectedOutput() + marker,
          timedOut,
          oomKilled,
        });
      }, GRACE_PERIOD_MS);
    }

    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    if (maxRssMb > 0) {
      rssPoller = setInterval(() => {
        if (proc.pid == null) return;
        const rss = getChildRssMb(proc.pid);
        if (rss > 0 && rss > maxRssMb) {
          escalate(
            false,
            true,
            `\n[test-runner] OOM_KILL: RSS ${rss.toFixed(0)} MB exceeded limit ${maxRssMb} MB`,
          );
        }
      }, 2_000);
    }

    timer = setTimeout(() => {
      escalate(true, false, '\n[test-runner] TIMEOUT');
    }, timeoutMs);

    proc.on('close', (code) => {
      if (escalation !== null) {
        settle({
          exitCode: code ?? 1,
          output: collectedOutput() + escalation.marker,
          timedOut: escalation.timedOut,
          oomKilled: escalation.oomKilled,
        });
        return;
      }
      settle({
        exitCode: code ?? 1,
        output: collectedOutput(),
        timedOut: false,
        oomKilled: false,
      });
    });

    proc.on('error', (err) => {
      settle({
        exitCode: 1,
        output: err.message,
        timedOut: false,
        oomKilled: false,
      });
    });
  });
}

/**
 * Run each test command in the given worktree directory with a per-command
 * timeout. Returns the combined pass/fail and captured output.
 * Empty commands array is a no-op that returns passed: true.
 */
export async function runTestCommands(
  worktreePath: string,
  commands: string[],
  timeoutSec: number,
  log: (msg: string) => void,
  opts: TestRunOptions = {},
): Promise<TestCommandResult> {
  if (commands.length === 0) {
    return { passed: true, output: '' };
  }

  const { maxRssMb = 0, failFast = false } = opts;
  const timeoutMs = timeoutSec * 1000;
  const outputParts: string[] = [];
  let allPassed = true;
  let anyTimedOut = false;
  let anyOomKilled = false;

  for (const cmd of commands) {
    log(`[test-runner] running: ${cmd}\n`);
    const { exitCode, output, timedOut, oomKilled } =
      await runCommandWithTimeout(cmd, worktreePath, timeoutMs, maxRssMb);
    outputParts.push(`$ ${cmd}\n${output}`);

    if (oomKilled) {
      log(
        `[test-runner] OOM_KILL after exceeding ${maxRssMb} MB RSS: ${cmd}\n`,
      );
      allPassed = false;
      anyOomKilled = true;
    } else if (timedOut) {
      log(`[test-runner] TIMEOUT after ${timeoutSec}s: ${cmd}\n`);
      allPassed = false;
      anyTimedOut = true;
    } else if (exitCode !== 0) {
      log(`[test-runner] FAILED (exit ${exitCode}): ${cmd}\n`);
      allPassed = false;
    } else {
      log(`[test-runner] passed: ${cmd}\n`);
    }

    if (!allPassed && failFast) break;
  }

  return {
    passed: allPassed,
    output: outputParts.join('\n'),
    timedOut: anyTimedOut,
    oomKilled: anyOomKilled,
  };
}

// ─── JUnit-XML report acquisition ──────────────────────────────────────────
// Parses a project's declared test_report_glob report file(s) into the
// normalized StructuredTestResult contract stored on
// test_request_runs.structured_result. Deliberately dependency-free (no XML
// library): JUnit XML written by pytest/vitest reporters is a small, regular
// subset of XML — testsuite(s)/testcase elements with attribute-only
// metadata and at most one failure/error/skipped child — so a couple of
// targeted regexes cover it without pulling in a general-purpose parser.

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

function getXmlAttr(attrsSrc: string, name: string): string | undefined {
  const match = attrsSrc.match(
    new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`),
  );
  if (!match) return undefined;
  return decodeXmlEntities(match[1] ?? match[2] ?? '');
}

/** Max characters retained from a failure/error element's inner text. */
const FAILURE_TRACE_EXCERPT_CAP = 2_000;

function extractChildText(
  content: string,
  tag: 'failure' | 'error' | 'skipped',
): { message?: string; text?: string } | null {
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`);
  const match = content.match(re);
  if (!match) return null;
  const message = getXmlAttr(match[1] ?? '', 'message');
  const rawText = match[2];
  const text = rawText
    ? decodeXmlEntities(stripCData(rawText))
        .trim()
        .slice(0, FAILURE_TRACE_EXCERPT_CAP)
    : undefined;
  return { message, text: text || undefined };
}

interface JUnitTestCase {
  id: string;
  name: string;
  outcome: 'passed' | 'failed' | 'skipped' | 'error';
  durationMs: number;
  failureMessage?: string;
  failureTraceExcerpt?: string;
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
    const suiteName = getXmlAttr(suiteAttrs, 'name') ?? 'unknown';
    const tests: JUnitTestCase[] = [];

    const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let caseMatch: RegExpExecArray | null;
    while ((caseMatch = caseRe.exec(suiteContent)) !== null) {
      const [, caseAttrs, caseContent = ''] = caseMatch;
      const name = getXmlAttr(caseAttrs, 'name') ?? 'unknown';
      const classname = getXmlAttr(caseAttrs, 'classname');
      const timeSec = parseFloat(getXmlAttr(caseAttrs, 'time') ?? '0');
      const durationMs = Number.isFinite(timeSec)
        ? Math.round(timeSec * 1000)
        : 0;
      const id = classname ? `${classname}.${name}` : name;

      const error = extractChildText(caseContent, 'error');
      const failure = extractChildText(caseContent, 'failure');
      const skipped = extractChildText(caseContent, 'skipped');

      let outcome: JUnitTestCase['outcome'] = 'passed';
      let failureMessage: string | undefined;
      let failureTraceExcerpt: string | undefined;
      if (error) {
        outcome = 'error';
        failureMessage = error.message;
        failureTraceExcerpt = error.text;
      } else if (failure) {
        outcome = 'failed';
        failureMessage = failure.message;
        failureTraceExcerpt = failure.text;
      } else if (skipped) {
        outcome = 'skipped';
        failureMessage = skipped.message;
      }

      tests.push({
        id,
        name,
        outcome,
        durationMs,
        ...(failureMessage ? { failureMessage } : {}),
        ...(failureTraceExcerpt ? { failureTraceExcerpt } : {}),
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
 */
export function collectStructuredTestResult(
  worktreePath: string,
  reportGlob: string,
): StructuredTestResult | null {
  const matchedFiles = listWorktreeFiles(worktreePath)
    .filter((rel) => minimatch(rel, reportGlob, { dot: true }))
    .sort();
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

  return { format: 'junit-xml', suites, totals, durationMsTotal };
}
