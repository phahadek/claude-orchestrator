import type { StagedIntent } from '../api/stagedIntents';

interface SetStatusTriagePayload {
  taskId: string;
  status: string;
  groomingGate?: {
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
  return payload?.groomingGate?.triage?.proposedVerdict ?? null;
}

export function taskIdFor(intents: StagedIntent[]): string | null {
  const payload = readyIntent(intents)?.payload as
    | SetStatusTriagePayload
    | undefined;
  return payload?.taskId ?? null;
}
