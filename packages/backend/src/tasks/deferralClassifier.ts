/**
 * Tier-3 semantic readiness advisory — a one-shot, headless classifier that
 * flags paraphrased deferrals (a genuine decision punted to implementation
 * time, worded to dodge the Tier-2 lexical list in readinessGate.ts).
 * Advisory-only: this module never gates a Ready transition (that stays the
 * deterministic tiers' + the human's authority — see readinessGate.ts and
 * TaskWriteCommands.setStatus). It writes a verdict into the staged
 * task.setStatus intent's `advisory` field, which the decision surface
 * (owned by the M12 decision-loop follow-on tasks) reads as a caution
 * signal distinct from the `annotation` hard-block channel.
 *
 * Reuses config.claudePath but NOT CliSessionRunner: a one-shot --print
 * classify call needs no tools, worktree, MCP config, or stream-json
 * protocol — spinning up the full session machinery for it would be
 * needless weight. No Anthropic API key is introduced; the CLI carries its
 * own credentials (Master Context Key Decision 2026-03-29).
 */

import { spawn, type ChildProcess } from 'child_process';
import { config, runtimeSettings } from '../config';
import { getTaskBackend } from './TaskBackend';
import {
  checkReadiness,
  composeProposedBody,
  DEFERRAL_PHRASES,
} from './readinessGate';
import {
  listStagedIntentsByGroup,
  getTaskCache,
  setStagedIntentAdvisory,
} from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import type { TaskBodySections } from './bodyRender';
import { recordEvent } from '../audit/AuditLog';
import { placeSessionPid } from '../session/sessionCgroup';
import { logger } from '../logger';

interface AdvisoryFinding {
  detail: string;
  location?: string;
  quote?: string;
}

interface Advisory {
  tier: 'semantic';
  status: 'pending' | 'clean' | 'flagged' | 'errored';
  confidence: number;
  findings: AdvisoryFinding[];
  model: string;
  checkedAt: number;
}

interface SetStatusPayload {
  taskId: string;
  status: string;
}

interface UpdateBodyPayload {
  taskId: string;
  sections: TaskBodySections;
}

/** Only these task Types carry implementer work worth screening — 📐 Design / 📋 Planning tasks have no implementation body to defer. */
const IMPLEMENTER_BEARING_TYPES: ReadonlySet<string> = new Set([
  '💻 Code',
  '🔧 Operational',
  '🧪 Testing',
]);

/** Gates whether a `flagged` verdict is significant enough to surface/route-back. Runtime tuning is Future Scope. */
const FLAG_CONFIDENCE_THRESHOLD = 0.7;

/** Fast timeout — a headless one-shot classify call must never hang a Ready-flip batch. */
const CLASSIFY_TIMEOUT_MS = 20_000;

/** Bounds how many classify subprocesses run at once for a batch of Ready-flips. */
const MAX_CONCURRENT_CLASSIFICATIONS = 3;

const DEFERRAL_CLASSIFIER_PROMPT = `You are a narrow classifier. Your ONLY job is to find sentences in a software task's description that defer a genuine decision to implementation-time — i.e. to "whoever writes the code" — WITHOUT using any of the well-known phrases already caught by a separate deterministic filter. You are looking for PARAPHRASES of those phrases, not the phrases themselves.

Already caught by the deterministic filter (do NOT flag these verbatim phrases — they never reach you):
${DEFERRAL_PHRASES.map((p) => `- "${p}"`).join('\n')}

Find sentences that convey the SAME MEANING as the above using different words — e.g. "the exact approach here is up to whoever picks this up", "we'll work out the details when someone builds this", "left open for the person implementing to sort out". High confidence should be reported ONLY when a specific sentence defers a real, consequential decision (an API shape, a data model choice, a security/auth boundary, a UX behavior) to implementation time.

MUST NOT FLAG (these are normal, healthy task-writing and are NOT deferrals):
- A sentence describing a step the implementer will take (e.g. "the implementer adds a new column", "the implementer wires the route") — this describes WORK, not an unresolved DECISION.
- A resolved reference to a linked decision made elsewhere (e.g. "per the linked design doc, use approach X", "as decided in TASK-123, the schema is Y") — the decision was already made; this is just a pointer to it.
- Acceptance criteria naming implementer actions (e.g. "the implementer writes a migration", "the implementer runs the test suite") — this is scope description, not deferred judgment.

Respond with ONLY a JSON object (no markdown fences, no commentary) of this exact shape:
{"status": "clean" | "flagged", "confidence": <number 0..1>, "findings": [{"quote": "<exact sentence>", "detail": "<why this is a paraphrased deferral>"}]}

"status" must be "flagged" only if at least one finding has confidence >= 0.7. "findings" must be empty when status is "clean".`;

interface ClassifyResult {
  status: 'clean' | 'flagged';
  confidence: number;
  findings: AdvisoryFinding[];
}

function parseClassifyOutput(stdout: string): ClassifyResult {
  const parsed = JSON.parse(stdout) as {
    result?: string;
  };
  // `claude --print --output-format json` wraps the model's reply in a
  // `result` string field; fall back to raw stdout for forward-compat.
  const raw = typeof parsed.result === 'string' ? parsed.result : stdout;
  const verdict = JSON.parse(raw) as {
    status?: unknown;
    confidence?: unknown;
    findings?: unknown;
  };
  const confidence =
    typeof verdict.confidence === 'number' ? verdict.confidence : 0;
  // Defense-in-depth: only ever surface 'flagged' when the model's own
  // confidence clears the threshold, regardless of what status string it
  // returned — a below-threshold "flagged" is not significant enough to
  // drive a route-back and is reported as clean.
  const status =
    verdict.status === 'flagged' && confidence >= FLAG_CONFIDENCE_THRESHOLD
      ? 'flagged'
      : 'clean';
  const findings = Array.isArray(verdict.findings)
    ? (verdict.findings as unknown[])
        .filter(
          (f): f is Record<string, unknown> =>
            typeof f === 'object' && f !== null,
        )
        .map((f) => ({
          detail: typeof f.detail === 'string' ? f.detail : '',
          location: typeof f.location === 'string' ? f.location : undefined,
          quote: typeof f.quote === 'string' ? f.quote : undefined,
        }))
    : [];
  return { status, confidence, findings };
}

/**
 * Invokes the claude CLI in one-shot headless print mode to classify a task
 * body for paraphrased deferrals. Fails open: any spawn error, non-zero
 * exit, timeout, or unparseable output resolves to status:'errored' rather
 * than throwing — a classify failure must never block or auto-route-back.
 */
async function classifyDeferral(body: string): Promise<Advisory> {
  const model = runtimeSettings.tier3_classifier_model;
  const checkedAt = Date.now();
  return new Promise<Advisory>((resolve) => {
    let settled = false;
    const settle = (advisory: Advisory) => {
      if (settled) return;
      settled = true;
      resolve(advisory);
    };

    let proc: ChildProcess;
    try {
      proc = spawn(
        config.claudePath,
        [
          '--print',
          '--output-format',
          'json',
          '--model',
          model,
          DEFERRAL_CLASSIFIER_PROMPT + '\n\nTASK BODY:\n' + body,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      logger.warn(
        `[deferralClassifier] failed to spawn classify subprocess: ${(err as Error).message}`,
      );
      settle({
        tier: 'semantic',
        status: 'errored',
        confidence: 0,
        findings: [],
        model,
        checkedAt,
      });
      return;
    }

    if (proc.pid) placeSessionPid(proc.pid);

    let stdout = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.on('error', (err: Error) => {
      logger.warn(
        `[deferralClassifier] classify subprocess error: ${err.message}`,
      );
      settle({
        tier: 'semantic',
        status: 'errored',
        confidence: 0,
        findings: [],
        model,
        checkedAt,
      });
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle({
        tier: 'semantic',
        status: 'errored',
        confidence: 0,
        findings: [],
        model,
        checkedAt,
      });
    }, CLASSIFY_TIMEOUT_MS);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle({
          tier: 'semantic',
          status: 'errored',
          confidence: 0,
          findings: [],
          model,
          checkedAt,
        });
        return;
      }
      try {
        const result = parseClassifyOutput(stdout);
        settle({
          tier: 'semantic',
          status: result.status,
          confidence: result.confidence,
          findings: result.findings,
          model,
          checkedAt,
        });
      } catch {
        settle({
          tier: 'semantic',
          status: 'errored',
          confidence: 0,
          findings: [],
          model,
          checkedAt,
        });
      }
    });
  });
}

/** Small in-process semaphore so a batch of Ready-flips doesn't spawn unbounded classify subprocesses. */
class Semaphore {
  private available: number;
  private readonly queue: (() => void)[] = [];

  constructor(size: number) {
    this.available = size;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.available--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.available++;
    const next = this.queue.shift();
    if (next) next();
  }
}

const classifySemaphore = new Semaphore(MAX_CONCURRENT_CLASSIFICATIONS);

function getCachedTaskType(taskId: string): string | null {
  const row = getTaskCache(taskId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.raw_json) as { type?: string };
    return parsed.type ?? null;
  } catch {
    return null;
  }
}

const ACTIVE_INTENT_STATES: ReadonlySet<StagedIntentRow['state']> = new Set([
  'staged',
  'approved',
]);

function isReadyFlip(row: StagedIntentRow): boolean {
  if (row.kind !== 'task.setStatus' || !ACTIVE_INTENT_STATES.has(row.state)) {
    return false;
  }
  const payload = JSON.parse(row.payload) as SetStatusPayload;
  return payload.status === 'Ready';
}

/** The body the proposal would make effective at Ready: the group's live task.updateBody payload if present, else the stored page body. */
async function computeGroupProposedBody(
  groupRows: StagedIntentRow[],
  backend: ReturnType<typeof getTaskBackend>,
  taskId: string,
): Promise<string> {
  const stored = (await backend.fetchTaskPage(taskId)) ?? '';
  const updateBodyRow = groupRows.find(
    (row) =>
      row.kind === 'task.updateBody' &&
      ACTIVE_INTENT_STATES.has(row.state) &&
      (JSON.parse(row.payload) as UpdateBodyPayload).taskId === taskId,
  );
  if (!updateBodyRow) return stored;
  const payload = JSON.parse(updateBodyRow.payload) as UpdateBodyPayload;
  return composeProposedBody(stored, payload.sections);
}

/**
 * Runs the Tier-3 classifier over each Ready-flip target in a proposal
 * group: gated on the deterministic tiers not already hard-blocking, and
 * only for implementer-bearing task types. Writes each verdict directly
 * into the target intent's `advisory` field and records an audit event
 * (mirroring `readiness_override`) so an operator returning from an
 * unattended run sees what happened.
 */
export async function classifyReadyProposal(groupId: string): Promise<void> {
  const groupRows = listStagedIntentsByGroup(groupId);
  const readyFlips = groupRows.filter(isReadyFlip);
  if (readyFlips.length === 0) return;

  await Promise.all(
    readyFlips.map(async (row) => {
      const payload = JSON.parse(row.payload) as SetStatusPayload;
      const taskType = getCachedTaskType(payload.taskId);
      if (!taskType || !IMPLEMENTER_BEARING_TYPES.has(taskType)) return;

      const backend = getTaskBackend(row.project_id);
      const body = await computeGroupProposedBody(
        groupRows,
        backend,
        payload.taskId,
      );

      if (checkReadiness(body, taskType).length > 0) return;

      const release = await classifySemaphore.acquire();
      let advisory: Advisory;
      try {
        advisory = await classifyDeferral(body);
      } finally {
        release();
      }

      setStagedIntentAdvisory(row.id, JSON.stringify(advisory));

      recordEvent({
        event_type: 'readiness_override',
        actor_type: 'system',
        actor_id: null,
        project_id: row.project_id,
        task_id: payload.taskId,
        payload: {
          reason: 'tier3_semantic_advisory',
          status: advisory.status,
          confidence: advisory.confidence,
          findings: advisory.findings,
          model: advisory.model,
          groupId,
        },
      });
    }),
  );
}
