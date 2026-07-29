import type { StagedIntent } from '../api/stagedIntents';

/**
 * Task types eligible for approve-by-standard triage — mirrors the
 * backend's INTERACTIVE_TASK_TYPES (planning/triage.ts). 💻 Code (and any
 * other non-interactive type) stays per-task-gated; a triage verdict
 * recorded against one is never a valid batch-approval signal.
 */
const INTERACTIVE_TASK_TYPES = new Set(['📐 Design', '📋 Planning']);

interface SetStatusTriagePayload {
  taskId: string;
  status: string;
  groomingGate?: {
    type?: string;
    triage?: {
      proposedVerdict: 'clean' | 'blocked' | 'needs-attention';
      hasOpenQuestionsHeading: boolean;
    };
  };
}

/** The task.setStatus -> Ready intent within a group, if any — the one carrying the recorded triage verdict. */
function readyIntent(intents: StagedIntent[]): StagedIntent | undefined {
  return intents.find((i) => {
    if (i.kind !== 'task.setStatus') return false;
    const payload = i.payload as SetStatusTriagePayload | undefined;
    return payload?.status === 'Ready';
  });
}

/** The recorded approve-by-standard triage verdict for a group, or null when the group isn't a triaged interactive-type row. */
export function triageVerdict(
  intents: StagedIntent[],
): 'clean' | 'blocked' | 'needs-attention' | null {
  const payload = readyIntent(intents)?.payload as
    | SetStatusTriagePayload
    | undefined;
  const groomingGate = payload?.groomingGate;
  if (!groomingGate?.triage) return null;
  // Defensive ignore: approve-by-standard is defined for interactive types
  // only. This never substitutes for the backend's stage-time eligibility
  // gate (groomGate.ts) — it only guards against a verdict already sitting
  // in the record from before that gate existed.
  if (!INTERACTIVE_TASK_TYPES.has(groomingGate.type ?? '')) return null;
  return groomingGate.triage.proposedVerdict;
}

export function taskIdFor(intents: StagedIntent[]): string | null {
  const payload = readyIntent(intents)?.payload as
    | SetStatusTriagePayload
    | undefined;
  return payload?.taskId ?? null;
}
