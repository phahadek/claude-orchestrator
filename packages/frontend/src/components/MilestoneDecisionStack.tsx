import type { TaskView } from '../types/taskView';
import type { StagedIntent } from '../api/stagedIntents';
import { phaseForTask } from '../utils/phaseBurndown';
import { MilestoneDecisionInbox } from './MilestoneDecisionInbox';
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
}

function matchesPhase(task: TaskView, phaseFilter: string | null): boolean {
  if (!phaseFilter) return true;
  return phaseForTask(task) === phaseFilter;
}

export function MilestoneDecisionStack({
  projectId,
  milestone,
  tasks,
  phaseFilter,
  flaggedOnly = false,
  selection,
  onSelect,
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

  return (
    <div className={styles.stack} data-testid="milestone-decision-stack">
      <MilestoneDecisionInbox
        projectId={projectId}
        milestone={milestone}
        tasks={tasks}
        selectedCardId={selectedIntentCardId}
        onSelectIntent={(intent) => onSelect({ type: 'intent', intent })}
      />

      <TaskSection
        title="Not yet launched"
        tasks={notLaunched}
        selectedTaskId={selectedTaskId}
        onSelectTask={(task) => onSelect({ type: 'task', task })}
      />

      <TaskSection
        title="Done"
        tasks={done}
        selectedTaskId={selectedTaskId}
        onSelectTask={(task) => onSelect({ type: 'task', task })}
      />
    </div>
  );
}

function TaskSection({
  title,
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  title: string;
  tasks: TaskView[];
  selectedTaskId: string | null;
  onSelectTask: (task: TaskView) => void;
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
