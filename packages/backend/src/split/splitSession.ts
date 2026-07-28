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
 * exist yet when the plan is composed, so `composeSplitIntents` expresses
 * intra-split dependsOn references to them with local `$ref:<ref>`
 * placeholders. `stageSplitIntents` — the only function that actually writes
 * to the staged-intent store — stages each sibling's task.create first and
 * rewrites any placeholder naming it (as either a dependsOn entry OR, for a
 * sibling-depends-on-sibling edge, the task.setDependsOn's own subject
 * taskId) to routes/stagedIntents.ts's `staged-intent:<id>` symbolic
 * reference before staging the dependency intent. `commitGroupIntents`
 * resolves that symbolic reference to the real created task id once the
 * referenced task.create has actually applied (staged-intent apply is a
 * serial, human-gated action — see routes/stagedIntents.ts).
 */

import type { NewTaskFields } from '../tasks/TaskBackend';
import type { TaskBodySections } from '../tasks/bodyRender';
import {
  stageIntent,
  symbolicCreateRef,
  type StagedIntent,
} from '../routes/stagedIntents';

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

export interface StageSplitIntentsResult {
  /** The staged rows, in the same order as `composeSplitIntents`'s `intents`. */
  staged: StagedIntent[];
  siblingRefs: Record<string, string>;
  sizeCheck: SplitSizeCheck;
  groupId: string;
}

/**
 * Invocation glue: the dedicated split session's route from a decided cut to
 * the shared staged-intent display. Composes the intents
 * (`composeSplitIntents`) and stages every one of them through the same
 * chokepoint every other producer stages through (`stageIntent` in
 * `routes/stagedIntents.ts`) — this module still never calls
 * TaskWriteCommands or applies anything itself.
 *
 * Staging happens in `composeSplitIntents`'s own order (updateBody, then
 * every task.create, then every task.setDependsOn) so that, by the time a
 * task.setDependsOn naming a sibling is staged, that sibling's task.create
 * has already been staged and has a real staged-intent id — letting this
 * function rewrite the composed `$ref:<ref>` placeholder (in either the
 * dependsOn subject taskId or a dependsOn entry) to the
 * `staged-intent:<id>` symbolic reference `commitGroupIntents` resolves at
 * commit time. A placeholder naming the original task never needs rewriting
 * — `composeSplitIntents` already resolved it to the original's real id.
 */
export function stageSplitIntents(
  input: ComposeSplitInput,
  sessionId?: string | null,
): StageSplitIntentsResult {
  const composed = composeSplitIntents(input);
  const groupId = `split:${input.original.id}`;

  const refToStagedId = new Map<string, string>();
  const staged: StagedIntent[] = [];
  let nextSiblingIndex = 0;
  for (const intent of composed.intents) {
    let payload = intent.payload;
    if (intent.kind === 'task.setDependsOn') {
      const resolve = (value: string): string => {
        if (!value.startsWith('$ref:')) return value;
        const ref = value.slice('$ref:'.length);
        const stagedId = refToStagedId.get(ref);
        if (!stagedId) {
          throw new Error(
            `[splitSession] "${value}" was staged before its task.create intent`,
          );
        }
        return symbolicCreateRef(stagedId);
      };
      const depsOnPayload = intent.payload as {
        taskId: string;
        dependsOn: string[];
      };
      payload = {
        taskId: resolve(depsOnPayload.taskId),
        dependsOn: depsOnPayload.dependsOn.map(resolve),
      };
    }
    const stagedIntent = stageIntent(
      intent.kind,
      payload,
      intent.projectId,
      intent.groupId,
      sessionId,
    );
    staged.push(stagedIntent);
    if (intent.kind === 'task.create') {
      refToStagedId.set(
        input.siblings[nextSiblingIndex].ref,
        stagedIntent.id,
      );
      nextSiblingIndex += 1;
    }
  }

  return {
    staged,
    siblingRefs: composed.siblingRefs,
    sizeCheck: composed.sizeCheck,
    groupId,
  };
}
