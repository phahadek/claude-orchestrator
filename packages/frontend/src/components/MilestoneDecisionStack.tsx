import { useCallback, useEffect, useRef } from 'react';
import type { TaskView } from '../types/taskView';
import type { StagedIntent } from '../api/stagedIntents';
import { phaseForTask } from '../utils/phaseBurndown';
import {
  MilestoneDecisionInbox,
  type CardScrollTarget,
} from './MilestoneDecisionInbox';
import { CompactTaskCard } from './CompactTaskCard';
import styles from './MilestoneDecisionStack.module.css';

/** A middle-stack selection — either a pending intent/group card or a task row. Drives the right drill-down. */
export type MilestoneStackSelection =
  | { type: 'intent'; intent: StagedIntent }
  | { type: 'task'; task: TaskView };

interface Props {
  projectId: string;
  /** The milestone's canonical short id (e.g. "M13") — the decision-inbox lens key, distinct from the board's DB id used to fetch `tasks`. */
  milestone: string;
  tasks: TaskView[];
  /** The shared phase filter emitted by the burndown (left column) — a PhaseKey (see utils/phaseBurndown), matched against each task's derived phase. */
  phaseFilter: string | null;
  /** True when phaseFilter was activated via a phase's ⚠ warning badge — narrows the phase's tasks down to the flagged (blocked) ones. */
  flaggedOnly?: boolean;
  selection: MilestoneStackSelection | null;
  onSelect: (selection: MilestoneStackSelection) => void;
  /** The centre column's scrollable ancestor (owned by MilestoneView) — scroll-follow attaches to it. Omit to skip scroll-follow (e.g. on mobile, where only one region is mounted at a time). */
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
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
  phaseFilter,
  flaggedOnly = false,
  selection,
  onSelect,
  scrollContainerRef,
}: Props) {
  const filteredTasks = tasks
    .filter((t) => matchesPhase(t, phaseFilter))
    .filter((t) => !flaggedOnly || t.blocked);
  const notLaunched = filteredTasks.filter(
    (t) => t.displayStatus !== 'done' && !t.codeSession,
  );
  const done = filteredTasks.filter((t) => t.displayStatus === 'done');

  const selectedIntentCardId =
    selection?.type === 'intent' ? selection.intent.id : null;
  const selectedTaskId =
    selection?.type === 'task' ? selection.task.taskId : null;

  // Scroll-follow bookkeeping lives in refs, not state — a scroll handler
  // firing on every frame shouldn't force a re-render, and an explicit click
  // must suppress exactly the one scroll event it may itself trigger (e.g. a
  // layout shift from the selection outline) without a stale-closure race.
  const inboxTargetsRef = useRef<Map<string, CardScrollTarget>>(new Map());
  const taskTargetsRef = useRef<Map<string, CardScrollTarget>>(new Map());
  const suppressNextScrollRef = useRef(false);

  const handleSelect = useCallback(
    (next: MilestoneStackSelection) => {
      suppressNextScrollRef.current = true;
      onSelect(next);
    },
    [onSelect],
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

  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!container) return;

    const handleScroll = () => {
      if (suppressNextScrollRef.current) {
        suppressNextScrollRef.current = false;
        return;
      }
      // Inbox cards render above task rows, so concatenation already
      // reflects document (top-to-bottom) order.
      const targets = [
        ...inboxTargetsRef.current.values(),
        ...taskTargetsRef.current.values(),
      ];
      if (targets.length === 0) return;

      const containerTop = container.getBoundingClientRect().top;
      let chosen = targets[0];
      for (const target of targets) {
        const relativeTop = target.el.getBoundingClientRect().top - containerTop;
        if (relativeTop <= TOP_THRESHOLD_PX) {
          chosen = target;
        } else {
          break;
        }
      }
      chosen.select();
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollContainerRef]);

  return (
    <div className={styles.stack} data-testid="milestone-decision-stack">
      <MilestoneDecisionInbox
        projectId={projectId}
        milestone={milestone}
        tasks={tasks}
        phaseFilter={phaseFilter}
        flaggedOnly={flaggedOnly}
        selectedCardId={selectedIntentCardId}
        onSelectIntent={(intent) => handleSelect({ type: 'intent', intent })}
        registerScrollTarget={registerInboxTarget}
      />

      <TaskSection
        title="Not yet launched"
        tasks={notLaunched}
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
}: {
  title: string;
  tasks: TaskView[];
  selectedTaskId: string | null;
  onSelectTask: (task: TaskView) => void;
  onRowRef?: (task: TaskView, el: HTMLElement | null) => void;
}) {
  if (tasks.length === 0) return null;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeading}>
        {title} ({tasks.length})
      </div>
      {tasks.map((task) => (
        <div
          key={task.taskId}
          ref={(el) => onRowRef?.(task, el)}
          className={
            selectedTaskId === task.taskId ? styles.taskRowSelected : undefined
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
