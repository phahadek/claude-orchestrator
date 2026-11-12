import { execFileSync } from 'child_process';
import { getProjectById } from '../config';
import { getCachedStatus } from '../tasks/TaskWriteCommands';
import { normalizeBoardId } from '../tasks/taskId';
import { STATUS_DISPLAY, toCanonicalStatus } from '../tasks/statusCanonical';
import { rejectStageGuard } from './stageGuard';
import type { StateClaim, VerifiedStateClaim } from '../db/types';

const STATE_CLAIM_GUARD_ID = 'state-claim';

const TASK_ID_RE =
  /(?<![0-9a-zA-Z-])(?:(?:notion|yaml|jira|github):)?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-zA-Z-])/gi;

const PATH_SEGMENT_RE = /^[\w.-]+$/;
const PATH_FILE_RE = /\w\.[A-Za-z0-9]{1,8}$/;

function extractTaskIdMentions(text: string): string[] {
  return (text.match(TASK_ID_RE) ?? []).map(normalizeBoardId);
}

function isRepoPathToken(token: string): boolean {
  if (token.includes(':') || token.includes('@')) return false;
  const segments = token.split('/');
  if (segments.length < 2) return false;
  if (!segments.every((s) => PATH_SEGMENT_RE.test(s))) return false;
  return PATH_FILE_RE.test(segments[segments.length - 1]);
}

function extractPathMentions(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s`"'()<>,;[\]{}]+/)) {
    const token = raw.replace(/[.:!?]+$/, '');
    if (isRepoPathToken(token)) out.push(normalizePath(token));
  }
  return out;
}

function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '');
}

function canonicalStatus(s: string): string {
  return toCanonicalStatus(s) ?? s.trim();
}

function pathExistsOnBase(
  repoRoot: string,
  baseBranch: string,
  relPath: string,
): boolean | null {
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
  };
  let ref: string | null = null;
  for (const candidate of [`origin/${baseBranch}`, baseBranch]) {
    try {
      git(['rev-parse', '--verify', '--quiet', candidate]);
      ref = candidate;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!ref) return null;
  try {
    git(['cat-file', '-e', `${ref}:${relPath}`]);
    return true;
  } catch {
    return false;
  }
}

interface StateClaimContext {
  sessionId: string | null | undefined;
  projectId: string;
  texts: string[];
  claims: unknown;
}

/**
 * Requires every task id / repo path mentioned in `texts` to be covered by a
 * declared claim, re-derives each claim against the task cache and the
 * project's base-branch tree, and returns the claims annotated with the
 * server-verified state. A missing or false claim rejects via the audited
 * stage-guard path.
 */
export function verifyStateClaims(
  ctx: StateClaimContext,
): VerifiedStateClaim[] {
  const reject = (evidence: string): never =>
    rejectStageGuard({
      guardId: STATE_CLAIM_GUARD_ID,
      evidence,
      sessionId: ctx.sessionId ?? null,
      taskId: null,
      projectId: ctx.projectId,
      intentKind: 'decision.pickOne',
    });

  const raw = ctx.claims ?? [];
  if (!Array.isArray(raw)) reject('stateClaims must be an array');
  const claims = raw as unknown[];

  const text = ctx.texts.join('\n');
  const mentionedTasks = new Set(extractTaskIdMentions(text));
  const mentionedPaths = new Set(extractPathMentions(text));

  let project: ReturnType<typeof getProjectById> | undefined;
  let projectResolved = false;
  const resolveProject = () => {
    if (!projectResolved) {
      project = getProjectById(ctx.projectId);
      projectResolved = true;
    }
    return project;
  };

  const coveredTasks = new Set<string>();
  const coveredPaths = new Set<string>();
  const verified: VerifiedStateClaim[] = [];

  for (const c of claims) {
    const claim = c as Partial<StateClaim> & Record<string, unknown>;
    if (typeof claim?.taskId === 'string' && typeof claim.status === 'string') {
      const actual = getCachedStatus(claim.taskId);
      if (!actual) {
        reject(
          `state claim for task ${claim.taskId} cannot be verified — the task is not in the task store`,
        );
      }
      if (actual !== canonicalStatus(claim.status)) {
        reject(
          `state claim says task ${claim.taskId} is "${claim.status}" but the task store has it as "${STATUS_DISPLAY[actual!]}"`,
        );
      }
      coveredTasks.add(normalizeBoardId(claim.taskId));
      verified.push({
        taskId: claim.taskId,
        status: claim.status,
        verified: STATUS_DISPLAY[actual!],
      });
    } else if (
      typeof claim?.path === 'string' &&
      (claim.onBase === 'exists' || claim.onBase === 'missing')
    ) {
      const rel = normalizePath(claim.path);
      const repoRoot = resolveProject()?.projectDir;
      const baseBranch = project?.baseBranch ?? 'dev';
      if (!repoRoot) {
        reject(
          `state claim for path ${rel} cannot be verified — project "${ctx.projectId}" has no repo checkout`,
        );
      }
      const exists = pathExistsOnBase(repoRoot!, baseBranch, rel);
      if (exists === null) {
        reject(
          `state claim for path ${rel} cannot be verified — base branch "${baseBranch}" is not resolvable in the checkout`,
        );
      }
      const actual = exists ? 'exists' : 'missing';
      if (actual !== claim.onBase) {
        reject(
          `state claim says ${rel} is ${claim.onBase} on ${baseBranch} but it is ${actual}`,
        );
      }
      coveredPaths.add(rel);
      verified.push({
        path: rel,
        onBase: claim.onBase,
        verified: `${actual} on ${baseBranch}`,
      });
    } else {
      reject(
        'each state claim must be {taskId, status} or {path, onBase: "exists"|"missing"}',
      );
    }
  }

  const uncoveredTasks = [...mentionedTasks].filter(
    (t) => !coveredTasks.has(t),
  );
  const uncoveredPaths = [...mentionedPaths].filter(
    (p) => !coveredPaths.has(p),
  );
  if (uncoveredTasks.length > 0 || uncoveredPaths.length > 0) {
    reject(
      `the prompt/options mention ${[...uncoveredTasks, ...uncoveredPaths].join(', ')} with no covering stateClaims entry — ` +
        'declare {taskId, status} for each task id and {path, onBase} for each repo path',
    );
  }
  return verified;
}
