import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import {
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  type Dirent,
} from 'fs';
import path from 'path';
import { platform } from 'process';
import { minimatch } from 'minimatch';
import type { StructuredTestResult } from '../db/types';
import { logger } from '../logger';
import {
  spawnIntoTestRunCgroup,
  killTestRunCgroup,
  isTestRunCgroupEmpty,
  removeTestRunCgroup,
  testRunCgroupMemoryCurrentPath,
} from './sessionCgroup';

export interface TestCommandResult {
  passed: boolean;
  output: string;
  timedOut?: boolean;
  oomKilled?: boolean;
  /**
   * True when at least one command's child process could not be spawned at
   * all (ENOENT, EAGAIN, fork failure) — an infrastructure failure, not a
   * test verdict: the command never ran, so `passed: false` here must not be
   * read as "the suite ran and failed".
   */
  spawnFailed?: boolean;
  /**
   * True when, after teardown (grace-period SIGINT, then SIGKILL/cgroup
   * kill), a process was still found alive in this run's cgroup — i.e. the
   * "no live subprocess" guarantee could not actually be confirmed. Distinct
   * from every other failure flag: those describe why the command was torn
   * down, this describes whether teardown actually finished the job. A
   * caller must not treat this run as safely settled.
   */
  teardownVerificationFailed?: boolean;
}

export interface TestRunOptions {
  /** Max RSS in MB per subprocess; 0 (default) = no limit. Linux-only. */
  maxRssMb?: number;
  /** Stop running subsequent commands after the first failure. Default false. */
  failFast?: boolean;
  /**
   * Identifies this run for cgroup-scoped teardown (see sessionCgroup.ts's
   * per-run tests/<runId>/ leaf) — callers that own a durable run id (e.g.
   * test_request_runs.id) should pass it so teardown diagnostics can be
   * traced back to that row. Defaults to a fresh id when omitted, so every
   * invocation still gets an isolated, verified-on-teardown cgroup.
   */
  runId?: string;
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

/**
 * Current memory footprint of the whole run, in MB. Prefers the run's own
 * cgroup-v2 leaf (tests/<runId>/memory.current) — inherited at fork, so it
 * captures the full process tree spawnIntoTestRunCgroup placed there,
 * including grandchildren that setsid() or get re-parented away from `pid`.
 * Falls back to `pid`'s own VmRSS (today's behavior — a single /proc read,
 * no subtree traversal) when no cgroup leaf exists, e.g. a host without the
 * delegated tests/ subtree set up. Non-Linux platforms return 0, same as
 * getChildRssMb, so the poller stays disabled there.
 */
export function getRunMemoryMb(
  runId: string,
  pid: number,
  _platform: NodeJS.Platform = process.platform,
  readFn: (path: string) => string = (p) => readFileSync(p, 'utf8') as string,
): number {
  if (_platform !== 'linux') return 0;
  const cgroupPath = testRunCgroupMemoryCurrentPath(runId);
  if (cgroupPath) {
    try {
      const raw = readFn(cgroupPath).trim();
      const bytes = parseInt(raw, 10);
      if (!Number.isNaN(bytes)) return bytes / (1024 * 1024);
    } catch {
      // leaf not yet created / already torn down — fall through
    }
  }
  return getChildRssMb(pid, _platform, readFn);
}

/** Bounded retries for verifyRunTeardown — a cgroup.kill signal needs a moment to actually reap before cgroup.procs reflects it as empty. */
const TEARDOWN_VERIFY_MAX_ATTEMPTS = 3;
export const TEARDOWN_VERIFY_RETRY_MS = 200;

/**
 * Confirms no process survives in this run's cgroup before settle()
 * resolves — the backstop for killProcessTree's process-group kill(-pid),
 * which a setsid() grandchild or a process re-parented to init after its
 * own parent exited both escape. cgroup-v2 membership is inherited at fork
 * and is orthogonal to process group/parent pid, so writing cgroup.kill
 * (via killTestRunCgroup) reaches those escapees regardless. Retries a
 * bounded number of times since a killed process needs a moment to actually
 * exit and be reaped before cgroup.procs reflects it as empty; if the
 * cgroup is still non-empty after all attempts, reports `survived: true`
 * rather than silently resolving. No-ops to `survived: false` on Windows,
 * which has no cgroups — that path is left on process-group teardown alone.
 */
function verifyRunTeardown(
  runId: string,
  onDone: (survived: boolean) => void,
  attempt = 0,
): void {
  if (platform === 'win32') {
    onDone(false);
    return;
  }
  if (isTestRunCgroupEmpty(runId)) {
    removeTestRunCgroup(runId);
    onDone(false);
    return;
  }
  killTestRunCgroup(runId);
  if (attempt + 1 >= TEARDOWN_VERIFY_MAX_ATTEMPTS) {
    onDone(!isTestRunCgroupEmpty(runId));
    return;
  }
  setTimeout(
    () => verifyRunTeardown(runId, onDone, attempt + 1),
    TEARDOWN_VERIFY_RETRY_MS,
  );
}

function runCommandWithTimeout(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  maxRssMb: number,
  runId: string,
): Promise<{
  exitCode: number;
  output: string;
  timedOut: boolean;
  oomKilled: boolean;
  spawnFailed: boolean;
  teardownVerificationFailed: boolean;
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

    // Relocated into this run's own per-run tests/<runId>/ cgroup for the
    // duration of the spawn call so this subprocess (and any grandchild it
    // forks synchronously, e.g. a temp postgres cluster) is born under that
    // bounded, run-scoped leaf rather than main/ or a leaf shared with other
    // runs — see spawnIntoTestRunCgroup's doc comment for why post-spawn
    // placement can't close this race.
    const proc = spawnIntoTestRunCgroup(runId, () => spawn(cmd, spawnOpts));
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
      spawnFailed?: boolean;
    }) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (rssPoller !== null) clearInterval(rssPoller);
      if (graceTimer !== null) clearTimeout(graceTimer);
      // Never settle "finished" while a process could still be alive in
      // this run's cgroup — the run must not be recorded as torn down
      // unless that's actually true (see verifyRunTeardown's doc comment).
      verifyRunTeardown(runId, (survived) => {
        if (survived) {
          logger.error(
            `[test-runner] teardown verification failed for run ${runId.slice(0, 8)}: a process survived cgroup kill`,
          );
        }
        resolve({
          spawnFailed: false,
          teardownVerificationFailed: survived,
          ...result,
        });
      });
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
        const rss = getRunMemoryMb(runId, proc.pid);
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

    proc.on('close', (code, signal) => {
      if (escalation !== null) {
        settle({
          exitCode: code ?? 1,
          output: collectedOutput() + escalation.marker,
          timedOut: escalation.timedOut,
          oomKilled: escalation.oomKilled,
        });
        return;
      }
      // A SIGKILL we did not initiate ourselves (no escalation in flight) is
      // the signature of the host/container OOM-killer reclaiming memory —
      // distinguishable from a normal nonzero exit purely via the `signal`
      // arg Node's close event provides, independent of whether the RSS
      // poller (maxRssMb > 0) is enabled for this run.
      const oomKilled = signal === 'SIGKILL';
      settle({
        exitCode: code ?? 1,
        output:
          collectedOutput() +
          (oomKilled
            ? `\n[test-runner] process terminated by signal ${signal} (likely OOM-kill)`
            : ''),
        timedOut: false,
        oomKilled,
      });
    });

    proc.on('error', (err) => {
      // The process could never be spawned at all (ENOENT, EAGAIN, fork
      // failure) — an infrastructure failure distinct from any test verdict:
      // no command ever ran, so this must not be mistaken for a test
      // failure downstream (see TestCommandResult.spawnFailed).
      settle({
        exitCode: 1,
        output: `[test-runner] spawn failed: ${err.message}`,
        timedOut: false,
        oomKilled: false,
        spawnFailed: true,
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

  const { maxRssMb = 0, failFast = false, runId = randomUUID() } = opts;
  const timeoutMs = timeoutSec * 1000;
  const outputParts: string[] = [];
  let allPassed = true;
  let anyTimedOut = false;
  let anyOomKilled = false;
  let anySpawnFailed = false;
  let anyTeardownVerificationFailed = false;

  for (const cmd of commands) {
    log(`[test-runner] running: ${cmd}\n`);
    const {
      exitCode,
      output,
      timedOut,
      oomKilled,
      spawnFailed,
      teardownVerificationFailed,
    } = await runCommandWithTimeout(
      cmd,
      worktreePath,
      timeoutMs,
      maxRssMb,
      runId,
    );
    outputParts.push(`$ ${cmd}\n${output}`);

    if (spawnFailed) {
      log(`[test-runner] SPAWN FAILED: ${cmd}\n`);
      allPassed = false;
      anySpawnFailed = true;
    } else if (teardownVerificationFailed) {
      log(
        `[test-runner] TEARDOWN VERIFICATION FAILED (process survived cgroup kill): ${cmd}\n`,
      );
      allPassed = false;
      anyTeardownVerificationFailed = true;
    } else if (oomKilled) {
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
    spawnFailed: anySpawnFailed,
    teardownVerificationFailed: anyTeardownVerificationFailed,
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
