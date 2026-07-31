import { useEffect, useState } from 'react';
import type { StagedIntent } from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import type { TaskView } from '../types/taskView';
import { StagedIntentPanel } from './StagedIntentPanel';
import { DecisionPickOnePanel } from './DecisionPickOnePanel';
import { TriageBatchPanel } from './TriageBatchPanel';
import { GroupCard } from './GroupCard';
import { taskIdFor } from './triageVerdict';
import { taskIdFromIntent } from '../utils/milestoneStack';
import { useDecisionQueue } from '../hooks/useDecisionQueue';
import panelStyles from './DecisionPanel.module.css';
import styles from './MilestoneDecisionInbox.module.css';

interface Props {
  projectId: string;
  milestone: string;
  /** The milestone's tasks — resolved against each card's intent(s) to label the card by its target task's name + Type instead of an internal id. */
  tasks?: TaskView[];
  /** The currently drill-down-selected intent/group card id, if any — highlights that card. */
  selectedCardId?: string | null;
  /** Drives the middle-stack selection -> right drill-down wiring. Omit to render read-only (no selection affordance). */
  onSelectIntent?: (intent: StagedIntent) => void;
}

interface TaskLabel {
  icon: string;
  name: string;
}

/** Resolves a card's target task name + type icon from the milestone's task list — null when the intent carries no task ref (e.g. decision.pickOne) or the ref doesn't resolve, so the caller can fall back to a defined label. */
function taskLabelFor(
  taskId: string | null,
  taskById: Map<string, TaskView>,
): TaskLabel | null {
  if (!taskId) return null;
  const task = taskById.get(taskId);
  if (!task) return null;
  return { icon: task.taskType.split(' ')[0], name: task.taskName };
}

type Card =
  | { type: 'group'; groupId: string }
  | { type: 'intent'; intent: StagedIntent };

/** A card's provenance — the originating session/flow, shown as a badge/optional filter, never the ranking axis. */
function provenanceOf(intents: StagedIntent[]): string {
  return intents[0]?.sessionId ?? 'human';
}

/** Routes to the session that staged a card — the same app-wide jump used by GateReadinessPanel and ReviewDetailView. */
function jumpToSession(sessionId: string) {
  window.dispatchEvent(
    new CustomEvent('selectSession', { detail: { sessionId } }),
  );
}

/**
 * Flattens the backend's already-ranked ?milestone lens order into one card
 * per group_id (at the position of its first, i.e. highest-impact, member)
 * plus one card per ungrouped intent — never re-sorted client-side.
 */
function buildCardOrder(intents: StagedIntent[]): Card[] {
  const seenGroups = new Set<string>();
  const cards: Card[] = [];
  for (const intent of intents) {
    if (intent.groupId) {
      if (seenGroups.has(intent.groupId)) continue;
      seenGroups.add(intent.groupId);
      cards.push({ type: 'group', groupId: intent.groupId });
    } else {
      cards.push({ type: 'intent', intent });
    }
  }
  return cards;
}

/**
 * The milestone decision inbox (Technical Architecture § "Decision surface &
 * confirm-gate contract"): a flat, backend-ranked list of every staged
 * decision attributed to the milestone, across every session that
 * contributed to it — no session/flow partitions, no needs-attention
 * section, since the backend's unblock-impact ranking already floats a
 * blocking annotation, a flagged advisory, or an unanswered decision.pickOne
 * to the top. Reuses the same leaf renderers as the session DecisionPanel
 * (StagedIntentPanel, DecisionPickOnePanel, TriageBatchPanel) via the shared
 * useDecisionQueue hook, differing only in fetch scope.
 */
export function MilestoneDecisionInbox({
  projectId,
  milestone,
  tasks = [],
  selectedCardId = null,
  onSelectIntent,
}: Props) {
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const {
    intents,
    loaded,
    groups,
    cleanGroupIds,
    includedCleanGroupIds,
    batchExcluded,
    toggleBatchExcluded,
    batchInFlight,
    batchError,
    batchExceptions,
    handleApproveAllClean,
    groupInFlight,
    groupErrors,
    draftFor,
    setDraft,
    handleApproveGroup,
    handleRejectGroup,
    upsert,
    remove,
  } = useDecisionQueue({ type: 'milestone', projectId, milestone });

  // Already-committed siblings never reappear on the live active/blocked
  // surface `intents` is drawn from (that would perpetually resurface a
  // long-done group), so a partially-applied group — some members committed,
  // one still blocked — is fetched separately per group via the diagnostic
  // full-group read, purely for display: legible proof the body patches,
  // dependency write, and gate/seed accretion already landed behind the one
  // member still stuck.
  const [committedByGroup, setCommittedByGroup] = useState<
    Record<string, StagedIntent[]>
  >({});
  const groupIdsKey = [
    ...new Set(
      intents
        .filter((i): i is StagedIntent & { groupId: string } => !!i.groupId)
        .map((i) => i.groupId),
    ),
  ]
    .sort()
    .join(',');

  useEffect(() => {
    const groupIds = groupIdsKey ? groupIdsKey.split(',') : [];
    if (groupIds.length === 0) {
      setCommittedByGroup({});
      return;
    }
    let cancelled = false;
    Promise.all(
      groupIds.map((groupId) =>
        stagedIntentsApi
          .listGroup(groupId)
          .then(
            (res) =>
              [
                groupId,
                res.intents.filter((i) => i.state === 'committed'),
              ] as const,
          )
          .catch(() => [groupId, []] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setCommittedByGroup(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [groupIdsKey]);

  if (!loaded || intents.length === 0) return null;

  const cardOrder = buildCardOrder(intents);

  return (
    <div className={styles.inbox} data-testid="milestone-decision-inbox">
      <div className={styles.heading}>Decisions ({intents.length})</div>

      <TriageBatchPanel
        cleanGroupIds={cleanGroupIds}
        includedCount={includedCleanGroupIds.length}
        inFlight={batchInFlight}
        error={batchError}
        onApprove={() => void handleApproveAllClean()}
      />

      {cardOrder.map((card) => {
        if (card.type === 'intent') {
          const { intent } = card;
          const provenance = provenanceOf([intent]);
          const label = taskLabelFor(taskIdFromIntent(intent), taskById);
          return (
            <div
              key={intent.id}
              className={`${panelStyles.group}${
                selectedCardId === intent.id ? ` ${styles.selectedCard}` : ''
              }`}
              onClick={
                onSelectIntent ? () => onSelectIntent(intent) : undefined
              }
              data-testid={`milestone-decision-card-${intent.id}`}
            >
              <div className={panelStyles.groupHeader}>
                <span className={styles.cardTitleGroup}>
                  <span className={styles.cardTitle}>
                    {label ? (
                      <>
                        <span aria-hidden="true">{label.icon}</span>{' '}
                        {label.name}
                      </>
                    ) : (
                      intent.kind
                    )}
                  </span>
                  {label && (
                    <span className={styles.cardTitleDetail}>
                      {intent.kind}
                    </span>
                  )}
                </span>
                <span
                  className={styles.provenanceBadge}
                  data-testid={`provenance-badge-${intent.id}`}
                >
                  {provenance}
                </span>
                {intent.sessionId && (
                  <button
                    type="button"
                    className={styles.sessionJumpButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      jumpToSession(intent.sessionId!);
                    }}
                    data-testid={`session-jump-${intent.id}`}
                  >
                    View session
                  </button>
                )}
              </div>
              {intent.kind === 'decision.pickOne' ? (
                <DecisionPickOnePanel
                  intent={intent}
                  onAnswered={remove}
                  onDismiss={remove}
                />
              ) : (
                <StagedIntentPanel
                  intent={intent}
                  onApplied={remove}
                  onRejected={remove}
                  onDismiss={remove}
                  onApproved={upsert}
                />
              )}
            </div>
          );
        }

        const { groupId } = card;
        const groupIntents = groups.get(groupId) ?? [];
        const draft = draftFor(groupId);
        const inFlight = groupInFlight === groupId;
        const isClean = cleanGroupIds.includes(groupId);
        const provenance = provenanceOf(groupIntents);
        const groupLabel = taskLabelFor(taskIdFor(groupIntents), taskById);
        const members = [
          ...(committedByGroup[groupId] ?? []).map((intent) => ({
            intent,
            hideActions: true,
          })),
          ...groupIntents.map((intent) => {
            // A blocked member (needs_revision | pending_verification) is
            // the one live-surface exception to hideActions: its only
            // operator-usable exit is a per-member Decline, exposed by
            // StagedIntentPanel itself when actions aren't hidden.
            const isBlockedMember =
              intent.state === 'needs_revision' ||
              intent.state === 'pending_verification';
            return { intent, hideActions: !isBlockedMember };
          }),
        ];

        return (
          <GroupCard
            key={groupId}
            groupId={groupId}
            members={members}
            onApplied={remove}
            onRejected={remove}
            onDismiss={remove}
            onApproved={upsert}
            isClean={isClean}
            batchExcluded={!!batchExcluded[groupId]}
            onToggleBatchExcluded={() => toggleBatchExcluded(groupId)}
            cleanBatchLabel={taskIdFor(groupIntents) ?? groupId}
            batchException={batchExceptions[groupId]}
            groupError={
              groupInFlight === groupId ? null : (groupErrors[groupId] ?? null)
            }
            title={
              groupLabel ? (
                <>
                  <span aria-hidden="true">{groupLabel.icon}</span>{' '}
                  {groupLabel.name}
                </>
              ) : undefined
            }
            inFlight={inFlight}
            draft={draft}
            onSetDraft={(patch) => setDraft(groupId, patch)}
            onApproveGroup={() => void handleApproveGroup(groupId)}
            onRejectGroup={() => void handleRejectGroup(groupId)}
            selected={selectedCardId === groupId}
            className={
              selectedCardId === groupId ? styles.selectedCard : undefined
            }
            onClick={
              onSelectIntent && groupIntents[0]
                ? () => onSelectIntent(groupIntents[0])
                : undefined
            }
            data-testid={`milestone-decision-card-${groupId}`}
            headerExtra={
              <>
                <span
                  className={styles.provenanceBadge}
                  data-testid={`provenance-badge-${groupId}`}
                >
                  {provenance}
                </span>
                {groupIntents[0]?.sessionId && (
                  <button
                    type="button"
                    className={styles.sessionJumpButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      jumpToSession(groupIntents[0].sessionId!);
                    }}
                    data-testid={`session-jump-${groupId}`}
                  >
                    View session
                  </button>
                )}
              </>
            }
          />
        );
      })}
    </div>
  );
}
