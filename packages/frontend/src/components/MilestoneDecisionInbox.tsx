import type { StagedIntent } from '../api/stagedIntents';
import { StagedIntentPanel } from './StagedIntentPanel';
import { DecisionPickOnePanel } from './DecisionPickOnePanel';
import { TriageBatchPanel } from './TriageBatchPanel';
import { taskIdFor } from './triageVerdict';
import { useDecisionQueue } from '../hooks/useDecisionQueue';
import panelStyles from './DecisionPanel.module.css';
import styles from './MilestoneDecisionInbox.module.css';

interface Props {
  projectId: string;
  milestone: string;
  /** The currently drill-down-selected intent/group card id, if any — highlights that card. */
  selectedCardId?: string | null;
  /** Drives the middle-stack selection -> right drill-down wiring. Omit to render read-only (no selection affordance). */
  onSelectIntent?: (intent: StagedIntent) => void;
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
  selectedCardId = null,
  onSelectIntent,
}: Props) {
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
    groupError,
    draftFor,
    setDraft,
    handleApproveGroup,
    handleRejectGroup,
    upsert,
    remove,
  } = useDecisionQueue({ type: 'milestone', projectId, milestone });

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
                <span>{intent.kind}</span>
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

        return (
          <div
            key={groupId}
            className={`${panelStyles.group}${
              selectedCardId === groupId ? ` ${styles.selectedCard}` : ''
            }`}
            onClick={
              onSelectIntent && groupIntents[0]
                ? () => onSelectIntent(groupIntents[0])
                : undefined
            }
            data-testid={`milestone-decision-card-${groupId}`}
          >
            <div className={panelStyles.groupHeader}>
              <span>Group {groupId}</span>
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
              {isClean && (
                <label>
                  <input
                    type="checkbox"
                    checked={!batchExcluded[groupId]}
                    onChange={() => toggleBatchExcluded(groupId)}
                    aria-label={`Include ${taskIdFor(groupIntents) ?? groupId} in approve all clean`}
                    data-testid={`clean-batch-include-${groupId}`}
                  />
                  <span
                    className={panelStyles.cleanBadge}
                    data-testid={`clean-badge-${groupId}`}
                  >
                    Clean
                  </span>
                </label>
              )}
            </div>
            {batchExceptions[groupId] && (
              <div className={panelStyles.groupError}>
                {batchExceptions[groupId]}
              </div>
            )}
            {groupError && groupInFlight === null && (
              <div className={panelStyles.groupError}>{groupError}</div>
            )}
            {groupIntents.map((intent) => (
              <StagedIntentPanel
                key={intent.id}
                intent={intent}
                onApplied={remove}
                onRejected={remove}
                onDismiss={remove}
                onApproved={upsert}
                hideActions
              />
            ))}
            <div className={panelStyles.groupActions}>
              <button
                type="button"
                className={panelStyles.commitButton}
                disabled={inFlight}
                onClick={() => void handleApproveGroup(groupId)}
              >
                {inFlight ? 'Approving…' : '✓ Approve groom'}
              </button>
              <div
                className={panelStyles.outcomeToggle}
                role="radiogroup"
                aria-label="Reject outcome"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.outcome === 'pushback'}
                  className={
                    draft.outcome === 'pushback'
                      ? panelStyles.outcomeOptionActive
                      : panelStyles.outcomeOption
                  }
                  onClick={() => setDraft(groupId, { outcome: 'pushback' })}
                >
                  Pushback
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.outcome === 'decline'}
                  className={
                    draft.outcome === 'decline'
                      ? panelStyles.outcomeOptionActive
                      : panelStyles.outcomeOption
                  }
                  onClick={() => setDraft(groupId, { outcome: 'decline' })}
                >
                  Decline
                </button>
              </div>
              <textarea
                className={panelStyles.reasonInput}
                placeholder={
                  draft.outcome === 'pushback'
                    ? 'What should the session revise?'
                    : 'Why is this being declined?'
                }
                value={draft.reason}
                onChange={(e) => setDraft(groupId, { reason: e.target.value })}
              />
              <button
                type="button"
                className={panelStyles.denyButton}
                disabled={inFlight || !draft.reason.trim()}
                onClick={() => void handleRejectGroup(groupId)}
              >
                {inFlight
                  ? 'Submitting…'
                  : draft.outcome === 'pushback'
                    ? '↩ Pushback groom'
                    : '✕ Decline groom'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
