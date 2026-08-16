import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskView } from '../types/taskView';
import type { StagedIntent } from '../api/stagedIntents';
import type { InvestigationReport } from '../api/reports';
import type { SessionState } from '../hooks/useSessionStore';
import { phaseForTask } from '../utils/phaseBurndown';
import type { PanelKeyboardDeclaration } from '../types/panelKeyboard';
import {
  MilestoneDecisionInbox,
  type CardScrollTarget,
} from './MilestoneDecisionInbox';
import { CompactTaskCard } from './CompactTaskCard';
import styles from './MilestoneDecisionStack.module.css';

/** A middle-stack selection — either a pending intent/group card, a task row, or an investigation report card. Drives the right drill-down. */
export type MilestoneStackSelection =
  | { type: 'intent'; intent: StagedIntent }
  | { type: 'task'; task: TaskView }
  | { type: 'report'; report: InvestigationReport };

interface Props {
  projectId: string;
  /** The milestone's canonical short id (e.g. "M13") — the decision-inbox lens key, distinct from the board's DB id used to fetch `tasks`. */
  milestone: string;
  tasks: TaskView[];
  /** The live session list — forwarded to MilestoneDecisionInbox so a taskId-less card (e.g. decision.pickOne) can resolve a display-only task name from its originating session, with no extra fetch. */
  sessions?: SessionState[];
  /** The shared phase filter emitted by the burndown (left column) — a PhaseKey (see utils/phaseBurndown), matched against each task's derived phase. */
  phaseFilter: string | null;
  /** True when phaseFilter was activated via a phase's ⚠ warning badge — narrows the phase's tasks down to the flagged (blocked) ones. */
  flaggedOnly?: boolean;
  selection: MilestoneStackSelection | null;
  onSelect: (selection: MilestoneStackSelection | null) => void;
  /** Selects the intent's card *and* switches the drill-down to session mode — wired to each card's "View session" button. */
  onViewSession?: (selection: MilestoneStackSelection) => void;
  /** The centre column's scrollable ancestor (owned by MilestoneView) — scroll-follow attaches to it. Omit to skip scroll-follow (e.g. on mobile, where only one region is mounted at a time). */
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  /** The active keyboard ring's current highlight (an intent id or groupId) — forwarded to the matching decision card so it can enable its local 'a'/'r' bindings. */
  keyboardHighlightedId?: string | null;
  /** Called (once, on mount) with this stack's panel-keyboard declaration — the decision-card ring's ordered item list, for the Milestone view's active useKeyboardShortcuts registration. */
  onDeclarationChange?: (declaration: PanelKeyboardDeclaration) => void;
}

function matchesPhase(task: TaskView, phaseFilter: string | null): boolean {
  if (!phaseFilter) return true;
  return phaseForTask(task) === phaseFilter;
}

/** Distance (px) from the scroll container's top edge within which a target still counts as "at the top". */
const TOP_THRESHOLD_PX = 8;

export function MilestoneDecisionStack({
  projectId,
  milestone,
  tasks,
  sessions = [],
  phaseFilter,
  flaggedOnly = false,
  selection,
  onSelect,
  onViewSession,
  scrollContainerRef,
  keyboardHighlightedId = null,
  onDeclarationChange,
}: Props) {
  const filteredTasks = tasks
    .filter((t) => matchesPhase(t, phaseFilter))
    .filter((t) => !flaggedOnly || t.blocked);
  const notLaunched = filteredTasks.filter(
    (t) => t.displayStatus !== 'done' && !t.codeSession && !t.planningSession,
  );
  const inFlight = filteredTasks.filter(
    (t) =>
      t.displayStatus !== 'done' && (!!t.codeSession || !!t.planningSession),
  );
  const done = filteredTasks.filter((t) => t.displayStatus === 'done');

  const selectedIntentCardId =
    selection?.type === 'intent' ? selection.intent.id : null;
  const selectedTaskId =
    selection?.type === 'task' ? selection.task.taskId : null;
  const selectedReportId =
    selection?.type === 'report' ? selection.report.id : null;

  // Scroll-follow bookkeeping lives in refs, not state — a scroll handler
  // firing on every frame shouldn't force a re-render, and an explicit click
  // must suppress exactly the one scroll event it may itself trigger (e.g. a
  // layout shift from the selection outline) without a stale-closure race.
  const inboxTargetsRef = useRef<Map<string, CardScrollTarget>>(new Map());
  const taskTargetsRef = useRef<Map<string, CardScrollTarget>>(new Map());
  const suppressNextScrollRef = useRef(false);
  // Bumped (never read) whenever a disposition removes the selected card, to
  // force the reselect effect below to run once the removal's DOM update has
  // committed (a plain ref wouldn't re-trigger the effect).
  const [reselectTick, setReselectTick] = useState(0);

  // The decision-card ring's keyboard declaration — orderedItems reads the
  // scroll-follow target map live on every call (never cached), so it
  // reflects whatever cards are currently mounted without needing to be
  // rebuilt when the underlying intent list changes.
  const declaration = useMemo<PanelKeyboardDeclaration>(
    () => ({
      orderedItems: () =>
        Array.from(inboxTargetsRef.current.keys()).map((id) => ({ id })),
      // Re-dispatches the same 'a' keydown the highlighted card's own local
      // listener (useHighlightedCardKeyboardActions) responds to, rather
      // than duplicating a second lookup/approve path here — this way the
      // global accept shortcut always fires the exact same
      // handleApply/handleApprove/onApproveGroup call the card's own
      // primary button's onClick uses, with no risk of the two paths
      // drifting apart.
      onApprove: () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      },
      hints: [
        { key: 'j', description: 'Next decision' },
        { key: 'k', description: 'Previous decision' },
        { key: 'a', description: 'Approve highlighted card' },
        { key: 'r', description: 'Focus reason field' },
      ],
    }),
    [],
  );

  useEffect(() => {
    onDeclarationChange?.(declaration);
  }, [declaration, onDeclarationChange]);

  const handleSelect = useCallback(
    (next: MilestoneStackSelection | null) => {
      suppressNextScrollRef.current = true;
      onSelect(next);
    },
    [onSelect],
  );

  const handleViewSession = useCallback(
    (next: MilestoneStackSelection) => {
      handleSelect(next);
      onViewSession?.(next);
    },
    [handleSelect, onViewSession],
  );

  const registerInboxTarget = useCallback(
    (id: string, target: CardScrollTarget | null) => {
      if (target) inboxTargetsRef.current.set(id, target);
      else inboxTargetsRef.current.delete(id);
    },
    [],
  );

  const registerTaskTarget = useCallback(
    (task: TaskView, el: HTMLElement | null) => {
      if (el) {
        taskTargetsRef.current.set(task.taskId, {
          el,
          select: () => handleSelect({ type: 'task', task }),
        });
      } else {
        taskTargetsRef.current.delete(task.taskId);
      }
    },
    [handleSelect],
  );

  // The single definition of "which card is on top": the last target (in
  // document order — inbox cards, then task rows) whose top sits within
  // TOP_THRESHOLD_PX of the scroll container's top edge, defaulting to the
  // first target. Reused by the scroll-follow handler below and by the
  // post-disposition reselect effect, so there is never a second notion of
  // "topmost".
  const selectTopmost = useCallback(
    (clearIfEmpty: boolean) => {
      const targets = [
        ...inboxTargetsRef.current.values(),
        ...taskTargetsRef.current.values(),
      ];
      if (targets.length === 0) {
        if (clearIfEmpty) handleSelect(null);
        return;
      }

      const container = scrollContainerRef?.current;
      const containerTop = container
        ? container.getBoundingClientRect().top
        : 0;
      let chosen = targets[0];
      for (const target of targets) {
        const relativeTop =
          target.el.getBoundingClientRect().top - containerTop;
        if (relativeTop <= TOP_THRESHOLD_PX) {
          chosen = target;
        } else {
          break;
        }
      }
      chosen.select();
    },
    [scrollContainerRef, handleSelect],
  );

  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!container) return;

    const handleScroll = () => {
      if (suppressNextScrollRef.current) {
        suppressNextScrollRef.current = false;
        return;
      }
      selectTopmost(false);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollContainerRef, selectTopmost]);

  // Fires once a disposition (single, group, or batch) has removed the
  // currently-selected card and the removal's DOM update has committed —
  // ref cleanups (registerInboxTarget/registerTaskTarget) run during commit,
  // before this passive effect, so the target maps are already up to date.
  // Skipped on mount (tick 0) since nothing has been removed yet.
  useEffect(() => {
    if (reselectTick === 0) return;
    selectTopmost(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reselectTick]);

  const handleCardsRemoved = useCallback(
    (removedIds: string[]) => {
      if (selectedIntentCardId && removedIds.includes(selectedIntentCardId)) {
        setReselectTick((t) => t + 1);
      }
    },
    [selectedIntentCardId],
  );

  return (
    <div className={styles.stack} data-testid="milestone-decision-stack">
      <MilestoneDecisionInbox
        projectId={projectId}
        milestone={milestone}
        tasks={tasks}
        sessions={sessions}
        phaseFilter={phaseFilter}
        flaggedOnly={flaggedOnly}
        selectedCardId={selectedIntentCardId}
        selectedReportId={selectedReportId}
        onSelectIntent={(intent) => handleSelect({ type: 'intent', intent })}
        onViewSession={(intent) =>
          handleViewSession({ type: 'intent', intent })
        }
        onSelectReport={(report) =>
          handleViewSession({ type: 'report', report })
        }
        registerScrollTarget={registerInboxTarget}
        onCardsRemoved={handleCardsRemoved}
        keyboardHighlightedId={keyboardHighlightedId}
      />

      <TaskSection
        title="Not yet launched"
        tasks={notLaunched}
        selectedTaskId={selectedTaskId}
        onSelectTask={(task) => handleSelect({ type: 'task', task })}
        onRowRef={registerTaskTarget}
      />

      <TaskSection
        title="In flight"
        tasks={inFlight}
        selectedTaskId={selectedTaskId}
        onSelectTask={(task) => handleSelect({ type: 'task', task })}
        onRowRef={registerTaskTarget}
      />

      <TaskSection
        title="Done"
        tasks={done}
        selectedTaskId={selectedTaskId}
        onSelectTask={(task) => handleSelect({ type: 'task', task })}
        onRowRef={registerTaskTarget}
        defaultCollapsed
      />
    </div>
  );
}

function TaskSection({
  title,
  tasks,
  selectedTaskId,
  onSelectTask,
  onRowRef,
  defaultCollapsed = false,
}: {
  title: string;
  tasks: TaskView[];
  selectedTaskId: string | null;
  onSelectTask: (task: TaskView) => void;
  onRowRef?: (task: TaskView, el: HTMLElement | null) => void;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (tasks.length === 0) return null;

  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.sectionHeading}
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className={styles.sectionHeadingChevron}>
          {collapsed ? '▶' : '▼'}
        </span>
        {title} ({tasks.length})
      </button>
      {!collapsed &&
        tasks.map((task) => (
          <div
            key={task.taskId}
            ref={(el) => onRowRef?.(task, el)}
            className={
              selectedTaskId === task.taskId
                ? styles.taskRowSelected
                : undefined
            }
            data-testid={`milestone-task-row-${task.taskId}`}
          >
            <CompactTaskCard
              task={task}
              showCheckbox={false}
              checked={false}
              onCheckChange={() => {}}
              onClick={() => onSelectTask(task)}
              showStatus
            />
          </div>
        ))}
    </div>
  );
}
