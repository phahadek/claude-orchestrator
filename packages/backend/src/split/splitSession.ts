/**
 * The dedicated split session's compose step — the "route" half of the
 * detect → confirm → route flow. Once a candidate is confirmed
 * (splitCandidate.ts), a dedicated session decides the cut (which acceptance
 * criteria / files form coherent subsets) and this module turns that cut into
 * command-layer staged intents, re-presented on the shared staged-intent
 * display (routes/stagedIntents.ts) for human apply. This module never calls
 * TaskWriteCommands itself — it only stages.
 *
 * The original task KEEPS its ID (updateBody, never archived/deferred — that
 * would lose history, comments, and inbound deps). The N-1 siblings don't
 * exist yet when the plan is composed, so intra-split dependsOn references to
 * them are expressed as `$ref:<ref>` placeholders; resolving those to real
 * task IDs happens as each createTask intent is applied (staged-intent apply
 * is a serial, human-gated action — see routes/stagedIntents.ts).
 */

import type { NewTaskFields } from '../tasks/TaskBackend';
import type { TaskBodySections } from '../tasks/bodyRender';

export const ORIGINAL_REF = 'original';

interface SplitSiblingSpec {
  /** Stable local reference for this sibling within the split, e.g. 'sibling-1'. */
  ref: string;
  fields: NewTaskFields;
  /** Refs (sibling refs, or ORIGINAL_REF) this sibling hard-blocks on. */
  dependsOn?: string[];
}

export interface ComposeSplitInput {
  projectId: string;
  original: {
    id: string;
    /** The narrowed body for the ONE subset the original keeps. */
    sections: TaskBodySections;
  };
  siblings: SplitSiblingSpec[];
}

interface SplitStagedIntent {
  kind: string;
  projectId: string;
  payload: unknown;
  /** Correlates this intent with the rest of the split's staged intents on the shared display. */
  groupId: string;
}

interface SplitSizeCheck {
  decision: 'split_now';
  /** `$ref:<ref>` placeholders for the new siblings — resolved to real task IDs post-apply. */
  splitInto: string[];
}

export interface ComposeSplitResult {
  intents: SplitStagedIntent[];
  /** ref -> placeholder id, until each sibling's createTask intent is applied and the real id substituted. */
  siblingRefs: Record<string, string>;
  sizeCheck: SplitSizeCheck;
}

function refPlaceholder(ref: string): string {
  return `$ref:${ref}`;
}

/**
 * Composes the staged intents for a split: updateBody on the original (down
 * to one subset, ID unchanged) + one task.create per sibling (lands at
 * Backlog) + task.setDependsOn for any intra-split hard-block declared by the
 * dedicated session.
 */
export function composeSplitIntents(
  input: ComposeSplitInput,
): ComposeSplitResult {
  if (input.siblings.length === 0) {
    throw new Error(
      '[splitSession] a split requires at least one sibling task (N-1 >= 1)',
    );
  }

  const seenRefs = new Set<string>();
  for (const sibling of input.siblings) {
    if (sibling.ref === ORIGINAL_REF || seenRefs.has(sibling.ref)) {
      throw new Error(
        `[splitSession] sibling ref "${sibling.ref}" is missing, reserved, or duplicated`,
      );
    }
    seenRefs.add(sibling.ref);
  }

  const siblingRefs: Record<string, string> = {};
  for (const sibling of input.siblings) {
    siblingRefs[sibling.ref] = refPlaceholder(sibling.ref);
  }

  const resolveRef = (ref: string): string =>
    ref === ORIGINAL_REF ? input.original.id : refPlaceholder(ref);

  const groupId = `split:${input.original.id}`;
  const intents: SplitStagedIntent[] = [];

  // 1. Narrow the original down to one subset. Keeps its ID — never demote to Deferred.
  intents.push({
    kind: 'task.updateBody',
    projectId: input.projectId,
    groupId,
    payload: { taskId: input.original.id, sections: input.original.sections },
  });

  // 2. Create the N-1 siblings at Backlog.
  for (const sibling of input.siblings) {
    intents.push({
      kind: 'task.create',
      projectId: input.projectId,
      groupId,
      payload: sibling.fields,
    });
  }

  // 3. Intra-split dependencies (hard-block-vs-soft-order already decided by the dedicated session).
  for (const sibling of input.siblings) {
    if (sibling.dependsOn && sibling.dependsOn.length > 0) {
      intents.push({
        kind: 'task.setDependsOn',
        projectId: input.projectId,
        groupId,
        payload: {
          taskId: refPlaceholder(sibling.ref),
          dependsOn: sibling.dependsOn.map(resolveRef),
        },
      });
    }
  }

  const sizeCheck: SplitSizeCheck = {
    decision: 'split_now',
    splitInto: input.siblings.map((sibling) => refPlaceholder(sibling.ref)),
  };

  return { intents, siblingRefs, sizeCheck };
}
