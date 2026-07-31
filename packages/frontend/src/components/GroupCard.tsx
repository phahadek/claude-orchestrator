import { useState, type ReactNode } from 'react';
import type {
  StagedIntent,
  StagedIntentRejectOutcome,
} from '../api/stagedIntents';
import { StagedIntentPanel } from './StagedIntentPanel';
import { CollapsibleField } from './CollapsibleField';
import panelStyles from './DecisionPanel.module.css';
import intentStyles from './StagedIntentPanel.module.css';
import styles from './GroupCard.module.css';

interface GroupCardMember {
  intent: StagedIntent;
  /** Suppresses this member's own action surface when expanded — see StagedIntentPanel's `hideActions`. */
  hideActions?: boolean;
}

interface GroupCardDraft {
  outcome: StagedIntentRejectOutcome;
  reason: string;
}

interface Props {
  groupId: string;
  members: GroupCardMember[];
  onApplied: (intent: StagedIntent, result: unknown) => void;
  onRejected: (intent: StagedIntent) => void;
  onDismiss: (intent: StagedIntent) => void;
  onApproved: (intent: StagedIntent) => void;
  isClean?: boolean;
  batchExcluded?: boolean;
  onToggleBatchExcluded?: () => void;
  cleanBatchLabel?: string;
  batchException?: string;
  groupError?: string | null;
  /** Resolved title for the card header (e.g. the target task's name + type), shown in place of the default "Group {groupId}" label — the groupId then demotes to secondary detail. Optional: DecisionPanel (session-scoped, no task list to resolve against) never passes this, so its header is unaffected. */
  title?: ReactNode;
  inFlight: boolean;
  draft: GroupCardDraft;
  onSetDraft: (patch: Partial<GroupCardDraft>) => void;
  onApproveGroup: () => void;
  onRejectGroup: () => void;
  /** True while the owning session hasn't signaled its proposal set complete for the turn — the backend refuses these too, so the group's controls are disabled rather than left to fail. */
  disabled?: boolean;
  /** Provenance badge / session-jump button — only the milestone inbox supplies this. */
  headerExtra?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** A short, kind-labelled identifier for a member's collapsed summary line — never the full per-kind view, which is reserved for the expanded state. */
function summaryLineFor(intent: StagedIntent): string {
  const payload = intent.payload as Record<string, unknown> | undefined;
  const identifier =
    (typeof payload?.taskId === 'string' && payload.taskId) ||
    (typeof payload?.taskName === 'string' && payload.taskName) ||
    (typeof payload?.title === 'string' && payload.title) ||
    (typeof payload?.capability === 'string' && payload.capability) ||
    null;
  return identifier ? `${intent.kind} — ${identifier}` : intent.kind;
}

/**
 * The card's shared head proposal: the first member's groomProposal, or —
 * when no member carries one — the first member's decisionProposal. Mirrors
 * the per-intent groomProposal/decisionProposal precedence StagedIntentPanel
 * already applies to a standalone intent.
 */
function headProposalOf(members: GroupCardMember[]) {
  for (const { intent } of members) {
    if (intent.groomProposal) return { groomProposal: intent.groomProposal };
  }
  for (const { intent } of members) {
    if (intent.decisionProposal) {
      return { decisionProposal: intent.decisionProposal };
    }
  }
  return {};
}

/**
 * The shared group-card presentation for a correlated set of staged
 * intents: one card per groupId, headed by the group's shared
 * groomProposal/decisionProposal, with each member collapsed to a single
 * summary line and individually expandable in place to its existing
 * StagedIntentPanel full per-kind view. Used identically by DecisionPanel
 * (session scope) and MilestoneDecisionInbox (milestone scope) — the two
 * surfaces differ only in the header content and action-bar wiring they
 * pass in via props.
 */
export function GroupCard({
  groupId,
  members,
  onApplied,
  onRejected,
  onDismiss,
  onApproved,
  isClean,
  batchExcluded,
  onToggleBatchExcluded,
  cleanBatchLabel,
  batchException,
  groupError,
  title,
  inFlight,
  draft,
  onSetDraft,
  onApproveGroup,
  onRejectGroup,
  disabled = false,
  headerExtra,
  onClick,
  selected,
  className,
  'data-testid': dataTestId,
}: Props) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const toggle = (id: string) =>
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));

  const head = headProposalOf(members);

  return (
    <div
      className={`${panelStyles.group}${className ? ` ${className}` : ''}${
        selected ? ` ${styles.selected}` : ''
      }`}
      onClick={onClick}
      data-testid={dataTestId ?? `group-card-${groupId}`}
    >
      <div className={panelStyles.groupHeader}>
        <span className={styles.cardTitleGroup}>
          <span className={styles.cardTitle}>
            {title ?? `Group ${groupId}`}
          </span>
          {title && (
            <span className={styles.cardTitleDetail}>Group {groupId}</span>
          )}
        </span>
        {headerExtra}
        {isClean && (
          <label>
            <input
              type="checkbox"
              checked={!batchExcluded}
              onChange={onToggleBatchExcluded}
              aria-label={`Include ${cleanBatchLabel ?? groupId} in approve all clean`}
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

      {batchException && (
        <div className={panelStyles.groupError}>{batchException}</div>
      )}
      {groupError && <div className={panelStyles.groupError}>{groupError}</div>}

      {head.groomProposal ? (
        <dl
          className={intentStyles.groomProposal}
          data-testid="group-card-groom-proposal"
        >
          <dt>Achieves</dt>
          <dd>
            <CollapsibleField text={head.groomProposal.achieves} />
          </dd>
          <dt>Open questions</dt>
          <dd>
            <CollapsibleField text={head.groomProposal.openQuestions} />
          </dd>
          <dt>Automated tests</dt>
          <dd>
            <CollapsibleField text={head.groomProposal.automatedTests} />
          </dd>
          <dt>Manual verification</dt>
          <dd>
            <CollapsibleField text={head.groomProposal.manualVerification} />
          </dd>
          <dt>Operational seed</dt>
          <dd>
            <CollapsibleField text={head.groomProposal.operationalSeed} />
          </dd>
        </dl>
      ) : (
        head.decisionProposal && (
          <p className={intentStyles.rationale}>
            <CollapsibleField text={head.decisionProposal} />
          </p>
        )
      )}

      <div className={styles.members}>
        {members.map(({ intent, hideActions }) => {
          const isExpanded = !!expandedIds[intent.id];
          return (
            <div
              key={intent.id}
              className={styles.member}
              data-testid={`group-member-${intent.id}`}
            >
              <button
                type="button"
                className={styles.memberSummary}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(intent.id);
                }}
                aria-expanded={isExpanded}
                data-testid={`group-member-toggle-${intent.id}`}
              >
                <span className={styles.memberChevron}>
                  {isExpanded ? '▾' : '▸'}
                </span>
                <span className={styles.memberSummaryText}>
                  {summaryLineFor(intent)}
                </span>
                {intent.state && (
                  <span className={intentStyles.stateBadge}>
                    {intent.state}
                  </span>
                )}
              </button>
              {isExpanded && (
                <div
                  className={styles.memberDetail}
                  onClick={(e) => e.stopPropagation()}
                >
                  <StagedIntentPanel
                    intent={intent}
                    onApplied={onApplied}
                    onRejected={onRejected}
                    onDismiss={onDismiss}
                    onApproved={onApproved}
                    hideActions={hideActions}
                    disabled={disabled}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div
        className={panelStyles.groupActions}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={panelStyles.commitButton}
          disabled={inFlight || disabled}
          onClick={onApproveGroup}
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
            onClick={() => onSetDraft({ outcome: 'pushback' })}
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
            onClick={() => onSetDraft({ outcome: 'decline' })}
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
          onChange={(e) => onSetDraft({ reason: e.target.value })}
        />
        <button
          type="button"
          className={panelStyles.denyButton}
          disabled={inFlight || disabled || !draft.reason.trim()}
          onClick={onRejectGroup}
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
}
