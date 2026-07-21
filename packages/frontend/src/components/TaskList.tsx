import { useState, useEffect, useCallback, useRef } from 'react';
import type { TaskView, DisplayStatus } from '../types/taskView';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { TaskCard } from './TaskCard';
import { CompactTaskCard } from './CompactTaskCard';
import { BacklogCodeSection } from './BacklogCodeSection';
import { NonCodeTypeSection } from './NonCodeTypeSection';
import { StagedIntentPanel } from './StagedIntentPanel';
import type { StagedIntent } from '../api/stagedIntents';
import { opsJournalApi } from '../api/opsJournal';
import { MODEL_OPTIONS, EFFORT_OPTIONS } from './Settings.helpers';
import { useDispatch } from '../hooks/useDispatch';
import { projectsApi } from '../api/projects';
import { sortByPriority } from '../utils/taskSort';
import { bareTaskId } from '../utils/taskId';
import styles from './TaskList.module.css';

interface Props {
  activeProjectId: string | null;
  boardId: string | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** Task list from App — single source of truth shared with the detail pane. */
  tasks: TaskView[];
  /** True while App is loading/refreshing the task list. */
  loading: boolean;
  /** Called when tasks are optimistically moved to In Progress after dispatch. */
  onOptimisticDispatch: (taskIds: string[]) => void;
  /** Called to force a REST re-fetch (used by Sync in non-milestone views). */
  onForceRefetch?: () => Promise<void>;
  /** Incremented when tasks_ready / pr_review_complete arrive — used to clear syncing indicator. */
  reviewRefreshTrigger?: number;
  /** refreshedAt timestamp from the latest task_cache_updated event for this board — clears the Sync spinner. */
  cacheUpdatedAt?: number;
  send: (msg: ClientMessage) => boolean;
  project: ProjectConfig | null;
}

// Code section groups, in display order. Ready/Backlog/Done are handled by their own
// dedicated sections below (ReadySection, BacklogCodeSection, the bottom Done section).
const CODE_GROUP_ORDER: DisplayStatus[] = [
  'needs_attention',
  'ready_to_merge',
  'in_progress',
  'in_review',
  'blocked',
  'deferred',
];

const GROUP_LABELS: Record<DisplayStatus, string> = {
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  in_progress: '🔄 In Progress',
  in_review: '👀 In Review',
  ready: '🗂️ Ready',
  done: '✔️ Done',
  backlog: '🔲 Backlog',
  blocked: '🚫 Blocked',
  deferred: '⏭️ Deferred',
};

// Task types eligible for the Ops(N) checkbox — 🧪 Testing here means observational
// Testing, which opsLoad.ts folds into the ops worklist alongside 🔧 Operational and
// 🔎 Investigation; authoring-Testing tasks are 💻 Code and are dropped server-side by
// /ops/launch's worklist.executable filter (the frontend can't see Mode to exclude them).
const OPS_TASK_TYPES = ['🔧 Operational', '🔎 Investigation', '🧪 Testing'];

// Task types eligible for the Design(N) checkbox — Ready/In Progress 📐 Design and
// 📋 Planning tasks. Backlog tasks of these types remain groomable instead (they
// need promotion to Ready first).
const DESIGN_TASK_TYPES = ['📐 Design', '📋 Planning'];

/**
 * Surfaces the sessions a Groom(N)/Ops(N)/Design(N) launch just started —
 * each launched task is already a live session in the session grid with
 * full controls, so this just links to it rather than staging a fake
 * Apply/Reject intent for something that was never actually staged.
 */
function LaunchedSessionsBanner({
  label,
  taskIds,
  tasks,
  onSelectTask,
  onDismiss,
  testId,
}: {
  label: string;
  taskIds: string[];
  tasks: TaskView[];
  onSelectTask: (taskId: string) => void;
  onDismiss: () => void;
  testId: string;
}) {
  if (taskIds.length === 0) return null;
  return (
    <div className={styles.launchedSessionsPanel} data-testid={testId}>
      <div className={styles.launchedSessionsHeader}>
        <span>{label}</span>
        <button
          className={styles.launchedSessionsDismiss}
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <div className={styles.launchedSessionsList}>
        {taskIds.map((taskId) => {
          const task = tasks.find((t) => t.taskId === taskId);
          return (
            <button
              key={taskId}
              className={styles.launchedSessionLink}
              onClick={() => onSelectTask(taskId)}
            >
              {task?.taskName ?? taskId}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Group tasks by wave number, returning a map of wave → sorted tasks. */
function groupByWave(tasks: TaskView[]): Map<number, TaskView[]> {
  const map = new Map<number, TaskView[]>();
  for (const task of tasks) {
    const wave = task.wave ?? 1;
    if (!map.has(wave)) map.set(wave, []);
    map.get(wave)!.push(task);
  }
  for (const [wave, waveTasks] of map) {
    map.set(wave, sortByPriority(waveTasks));
  }
  return map;
}

/** Compact wave-grouped section for Ready tasks with Select All / Launch controls. */
function ReadySection({
  tasks,
  onSelectTask,
  send,
  project,
  isExpanded,
  onToggleCollapse,
  onOptimisticDispatch,
}: {
  tasks: TaskView[];
  onSelectTask: (taskId: string) => void;
  send: (msg: ClientMessage) => boolean;
  project: ProjectConfig | null;
  isExpanded: boolean;
  onToggleCollapse: () => void;
  onOptimisticDispatch: (taskIds: string[]) => void;
}) {
  const dispatch = useDispatch(send, project);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  // Wave 2+ start collapsed by default; wave 1 starts expanded
  const [collapsedWaves, setCollapsedWaves] = useState<Set<number>>(() => {
    const initialMap = groupByWave(tasks);
    return new Set(Array.from(initialMap.keys()).filter((w) => w > 1));
  });

  const wave1CodeTasks = tasks.filter((t) => (t.wave ?? 1) === 1 && !t.blocked);
  const totalCount = tasks.length;
  const waveMap = groupByWave(tasks);
  const waveNumbers = Array.from(waveMap.keys()).sort((a, b) => a - b);

  function toggleCheck(taskId: string, checked: boolean) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  function handleSelectAll() {
    setCheckedIds(new Set(wave1CodeTasks.map((t) => t.taskId)));
  }

  function handleLaunch() {
    const toDispatch = wave1CodeTasks
      .filter((t) => checkedIds.has(t.taskId))
      .map((t) => ({
        notionUrl: t.notionUrl,
        taskId: t.taskId,
        taskType: t.taskType,
        taskName: t.taskName,
      }));
    if (toDispatch.length === 0) return;
    dispatch(toDispatch);
    if (project) {
      onOptimisticDispatch(
        wave1CodeTasks
          .filter((t) => checkedIds.has(t.taskId))
          .map((t) => t.taskId),
      );
    }
    setCheckedIds(new Set());
  }

  function toggleWaveCollapse(wave: number) {
    setCollapsedWaves((prev) => {
      const next = new Set(prev);
      if (next.has(wave)) next.delete(wave);
      else next.add(wave);
      return next;
    });
  }

  const checkedCount = wave1CodeTasks.filter((t) =>
    checkedIds.has(t.taskId),
  ).length;

  return (
    <div
      className={styles.group}
      data-status="ready"
      data-testid="ready-section"
    >
      <div
        className={`${styles.groupHeader} ${styles.groupHeaderToggle}`}
        onClick={onToggleCollapse}
        role="button"
        aria-expanded={isExpanded}
        data-testid="group-header-ready"
      >
        <span className={styles.toggle} aria-hidden="true">
          {isExpanded ? '▼' : '▶'}
        </span>
        <span className={styles.groupLabel}>{GROUP_LABELS.ready}</span>
        <span className={styles.groupCount}>{totalCount}</span>
        <div
          className={styles.launchControls}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={styles.selectAllBtn}
            onClick={handleSelectAll}
            disabled={wave1CodeTasks.length === 0}
            data-testid="select-all-btn"
          >
            Select All
          </button>
          <button
            className={styles.launchBtn}
            onClick={handleLaunch}
            disabled={checkedCount === 0}
            data-testid="launch-btn"
          >
            Launch ({checkedCount})
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className={styles.groupCards}>
          {waveNumbers.map((wave) => {
            const waveTasks = waveMap.get(wave)!;
            const isCollapsed = collapsedWaves.has(wave);
            const isWaveExpanded = !isCollapsed;

            return (
              <div
                key={wave}
                className={styles.waveGroup}
                data-testid={`wave-group-${wave}`}
              >
                <div
                  className={styles.waveHeader}
                  onClick={() => toggleWaveCollapse(wave)}
                  role="button"
                  aria-expanded={isWaveExpanded}
                  data-testid={`wave-header-${wave}`}
                >
                  <span className={styles.waveLabel}>
                    Wave {wave} ({waveTasks.length})
                  </span>
                  <span className={styles.waveToggle} aria-hidden="true">
                    {isWaveExpanded ? '▾' : '▸'}
                  </span>
                </div>

                {isWaveExpanded &&
                  waveTasks.map((task) => (
                    <CompactTaskCard
                      key={task.taskId}
                      task={task}
                      showCheckbox={
                        wave === 1 &&
                        !task.blocked &&
                        task.taskType.includes('💻')
                      }
                      checked={checkedIds.has(task.taskId)}
                      onCheckChange={toggleCheck}
                      onClick={() => onSelectTask(task.taskId)}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TaskList({
  activeProjectId,
  boardId,
  selectedTaskId,
  onSelectTask,
  tasks,
  loading,
  onOptimisticDispatch,
  onForceRefetch,
  reviewRefreshTrigger,
  cacheUpdatedAt,
  send,
  project,
}: Props) {
  const [syncing, setSyncing] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    new Set(['done', 'backlog']),
  );
  const [groomCheckedIds, setGroomCheckedIds] = useState<Set<string>>(
    new Set(),
  );
  // Task ids for sessions the Groom(N)/Ops(N)/Design(N) buttons just
  // launched, surfaced via LaunchedSessionsBanner — each is already a live
  // session in the session grid, so this just links to it.
  const [groomLaunchedIds, setGroomLaunchedIds] = useState<string[]>([]);
  const [groomLoading, setGroomLoading] = useState(false);
  const [groomError, setGroomError] = useState<string | null>(null);
  // Ops(N): launches one individual, dependency-ordered session per selected
  // task (mirrors the manual-UI launch path).
  const [opsLaunchedIds, setOpsLaunchedIds] = useState<string[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsCheckedIds, setOpsCheckedIds] = useState<Set<string>>(new Set());
  // Design(N): mirrors Ops(N) — launches one individual design/planning session
  // per selected task via the same unified planning-launch route.
  const [designLaunchedIds, setDesignLaunchedIds] = useState<string[]>([]);
  const [designLoading, setDesignLoading] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [designCheckedIds, setDesignCheckedIds] = useState<Set<string>>(
    new Set(),
  );
  // Per-launch model/effort override shared by the Groom(N)/Ops(N)/Design(N)
  // launch controls — '' falls back to the runtime setting for that session type.
  const [launchModel, setLaunchModel] = useState('');
  const [launchEffort, setLaunchEffort] = useState('');
  // Cross-milestone move: the shared staged-intent display renders whichever
  // task.move intent was most recently staged from a TaskCard on this board.
  const [moveIntent, setMoveIntent] = useState<StagedIntent | null>(null);

  // Reset the shared staged-intent display when the active milestone/project
  // changes so a stale intent from the previous board never carries over.
  useEffect(() => {
    setGroomLaunchedIds([]);
    setGroomError(null);
    setOpsLaunchedIds([]);
    setOpsError(null);
    setOpsCheckedIds(new Set());
    setDesignLaunchedIds([]);
    setDesignError(null);
    setDesignCheckedIds(new Set());
    setMoveIntent(null);
  }, [activeProjectId, boardId]);

  const toggleGroup = useCallback((status: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const NON_MILESTONE_BOARD_ID = '__non_milestone__';
  const isNonMilestoneView = boardId === NON_MILESTONE_BOARD_ID;

  // True while a user-initiated Sync is waiting for the tasks_ready → fetch cycle to complete.
  const syncPendingRef = useRef(false);

  // Clear syncing when tasks_ready arrives (the data refresh itself is handled by App.tsx).
  useEffect(() => {
    if (!reviewRefreshTrigger) return;
    if (!syncPendingRef.current) return;
    syncPendingRef.current = false;
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = null;
    }
    setSyncing(false);
  }, [reviewRefreshTrigger]);

  // Clear syncing when task_cache_updated fires for this board (Sync button flow).
  useEffect(() => {
    if (!cacheUpdatedAt) return;
    if (!syncPendingRef.current) return;
    syncPendingRef.current = false;
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
      // eslint-disable-next-line react-hooks/immutability -- Reason: deliberate ref mutation — syncTimeoutRef holds a timeout handle for bookkeeping, not a rendered value; clearing it imperatively is correct
      syncTimeoutRef.current = null;
    }
    setSyncing(false);
  }, [cacheUpdatedAt]);

  const handleOptimisticDispatch = useCallback(
    (taskIds: string[]) => {
      onOptimisticDispatch(taskIds);
    },
    [onOptimisticDispatch],
  );

  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Send WS fetch_tasks with skipCache=true and wait for the tasks_ready response before
  // reading from the REST endpoint. App.tsx handles the actual REST fetch via its effect.
  const handleSync = useCallback(() => {
    if (!activeProjectId || syncing) return;
    setSyncing(true);
    syncPendingRef.current = true;
    if (!boardId || isNonMilestoneView) {
      // Non-milestone view: delegate re-fetch to App.tsx via callback.
      if (onForceRefetch) {
        void onForceRefetch().finally(() => {
          syncPendingRef.current = false;
          setSyncing(false);
        });
      } else {
        syncPendingRef.current = false;
        setSyncing(false);
      }
      return;
    }
    const sent = send({
      type: 'fetch_tasks',
      projectId: activeProjectId,
      milestoneId: boardId,
      skipCache: true,
    });
    if (!sent) {
      // WS not open — clear immediately so the button doesn't stay stuck
      syncPendingRef.current = false;
      setSyncing(false);
      return;
    }
    // Safety timeout: clear syncing if no tasks_ready arrives within 5 seconds
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    // eslint-disable-next-line react-hooks/immutability -- Reason: deliberate ref mutation — syncTimeoutRef holds a timeout handle for bookkeeping; assigning it imperatively is the correct pattern
    syncTimeoutRef.current = setTimeout(() => {
      syncTimeoutRef.current = null;
      if (syncPendingRef.current) {
        syncPendingRef.current = false;
        setSyncing(false);
      }
    }, 5000);
  }, [
    activeProjectId,
    boardId,
    isNonMilestoneView,
    syncing,
    send,
    onForceRefetch,
  ]);

  const mergeReadyCount = tasks.filter(
    (t) =>
      t.pr !== null &&
      t.pr.state === 'open' &&
      t.review !== null &&
      t.review.verdict === 'approved' &&
      t.pauseReason === null &&
      t.pr.mergeState === 'clean',
  ).length;

  const handleMergeReady = useCallback(() => {
    if (!activeProjectId || !boardId) return;
    if (
      !window.confirm(
        `Merge ${mergeReadyCount} ready PR${mergeReadyCount === 1 ? '' : 's'}?`,
      )
    )
      return;
    void projectsApi.mergeReady(activeProjectId, boardId);
  }, [activeProjectId, boardId, mergeReadyCount]);

  const syncButton = (
    <div className={styles.listHeader}>
      {mergeReadyCount > 0 && (
        <button
          className={styles.mergeReadyBtn}
          onClick={handleMergeReady}
          data-testid="merge-ready-btn"
        >
          Merge Ready ({mergeReadyCount})
        </button>
      )}
      <button
        className={`${styles.syncBtn}${syncing ? ` ${styles.syncBtnLoading}` : ''}`}
        onClick={handleSync}
        disabled={syncing || !activeProjectId}
        aria-busy={syncing}
        title="Sync tasks from Notion"
        data-testid="sync-btn"
      >
        <span className={styles.syncIcon} aria-hidden="true">
          ↻
        </span>
        {syncing ? 'Syncing…' : 'Sync'}
      </button>
    </div>
  );

  if (loading) {
    return (
      <div className={styles.taskListContainer}>
        {syncButton}
        <div className={styles.loading} data-testid="task-list-loading">
          <span className={styles.loadingSpinner} aria-hidden="true" />
          <span>Loading tasks…</span>
        </div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className={styles.taskListContainer}>
        {syncButton}
        <div className={styles.empty} data-testid="task-list-empty">
          No active tasks found.
        </div>
      </div>
    );
  }

  const codeTasks = tasks.filter((t) => t.taskType.includes('💻'));
  const nonCodeTasks = tasks.filter((t) => !t.taskType.includes('💻'));

  const codeDoneTasks = codeTasks.filter((t) => t.displayStatus === 'done');
  const nonCodeDoneTasks = nonCodeTasks.filter(
    (t) => t.displayStatus === 'done',
  );
  const doneCount = codeDoneTasks.length + nonCodeDoneTasks.length;

  const codeNotDone = codeTasks.filter((t) => t.displayStatus !== 'done');
  const nonCodeNotDone = nonCodeTasks.filter((t) => t.displayStatus !== 'done');

  const readyCodeTasks = codeNotDone.filter((t) => t.displayStatus === 'ready');
  const backlogCodeTasks = codeNotDone.filter(
    (t) => t.displayStatus === 'backlog',
  );
  const backlogNonCodeTasks = nonCodeNotDone.filter(
    (t) => t.displayStatus === 'backlog',
  );
  const groomableTasks = [...backlogCodeTasks, ...backlogNonCodeTasks];
  const groomSelectedCount = groomableTasks.filter((t) =>
    groomCheckedIds.has(t.taskId),
  ).length;

  function toggleGroomCheck(taskId: string, checked: boolean) {
    setGroomCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  function handleGroomSelectAll() {
    setGroomCheckedIds(new Set(groomableTasks.map((t) => t.taskId)));
  }

  // Launches one individual grooming session per selected Backlog task via the
  // unified planning-launch route, mirroring handleOpsLaunch.
  async function handleGroomLaunch() {
    const selectedIds = groomableTasks
      .filter((t) => groomCheckedIds.has(t.taskId))
      .map((t) => t.taskId);
    if (!activeProjectId || !boardId || selectedIds.length === 0) return;
    setGroomLoading(true);
    setGroomError(null);
    try {
      const result = await opsJournalApi.launch(
        'groom',
        activeProjectId,
        boardId,
        selectedIds,
        launchModel,
        launchEffort,
      );
      const launchedIds = new Set(result.launched);
      setGroomLaunchedIds(
        selectedIds.filter((id) => launchedIds.has(bareTaskId(id))),
      );
      const notLaunched = selectedIds.filter(
        (id) => !result.launched.includes(bareTaskId(id)),
      );
      setGroomError(
        notLaunched.length > 0
          ? `${notLaunched.length} selected task${notLaunched.length === 1 ? '' : 's'} did not launch: ${notLaunched.join(', ')}`
          : null,
      );
      setGroomCheckedIds(new Set());
    } catch (err) {
      setGroomError(
        err instanceof Error
          ? err.message
          : 'Failed to launch grooming sessions',
      );
    } finally {
      setGroomLoading(false);
    }
  }

  // Ops(N) checkbox eligibility: mirrors the backend's executable predicate
  // (opsLoad.ts) — only 🗂️ Ready / 🔄 In Progress 🔧/🔎/observational-🧪 tasks are
  // launchable. Type-based only — the frontend can't see Mode, so an
  // authoring-Testing task also renders a checkbox here; /ops/launch drops it
  // server-side and handleOpsLaunch surfaces the gap via the launched[]
  // reconciliation below. Backlog ops-type tasks fall through to the Groom
  // checkbox instead (see groomableTasks above).
  function isOpsEligible(t: TaskView): boolean {
    return (
      OPS_TASK_TYPES.includes(t.taskType) &&
      (t.displayStatus === 'ready' || t.displayStatus === 'in_progress')
    );
  }
  const opsEligibleTasks = tasks.filter(isOpsEligible);
  const opsSelectedCount = opsEligibleTasks.filter((t) =>
    opsCheckedIds.has(t.taskId),
  ).length;

  function toggleOpsCheck(taskId: string, checked: boolean) {
    setOpsCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  function handleOpsSelectAll() {
    setOpsCheckedIds(new Set(opsEligibleTasks.map((t) => t.taskId)));
  }

  function handleOpsClearSelection() {
    setOpsCheckedIds(new Set());
  }

  // Launches one individual, dependency-ordered session per checked, ops-eligible
  // task via the backend ops launcher, then reads back the ops_journal rows to
  // render in the shared StagedIntentPanel. Launched sessions themselves render
  // on the right panel like any other session.
  async function handleOpsLaunch() {
    const selectedIds = opsEligibleTasks
      .filter((t) => opsCheckedIds.has(t.taskId))
      .map((t) => t.taskId);
    if (!activeProjectId || !boardId || selectedIds.length === 0) return;
    setOpsLoading(true);
    setOpsError(null);
    try {
      const result = await opsJournalApi.launch(
        'ops',
        activeProjectId,
        boardId,
        selectedIds,
        launchModel,
        launchEffort,
      );
      const launchedIds = new Set(result.launched);
      const deferredIds = new Set(result.deferred);
      setOpsLaunchedIds(
        selectedIds.filter((id) => launchedIds.has(bareTaskId(id))),
      );
      const deferred = selectedIds.filter((id) =>
        deferredIds.has(bareTaskId(id)),
      );
      const notLaunched = selectedIds.filter(
        (id) =>
          !launchedIds.has(bareTaskId(id)) && !deferredIds.has(bareTaskId(id)),
      );
      const messages: string[] = [];
      if (deferred.length > 0) {
        messages.push(
          `${deferred.length} selected task${deferred.length === 1 ? '' : 's'} waiting on dependencies — will launch when unblocked: ${deferred.join(', ')}`,
        );
      }
      if (notLaunched.length > 0) {
        messages.push(
          `${notLaunched.length} selected task${notLaunched.length === 1 ? '' : 's'} did not launch (not ops-executable): ${notLaunched.join(', ')}`,
        );
      }
      setOpsError(messages.length > 0 ? messages.join(' ') : null);
      setOpsCheckedIds(new Set());
    } catch (err) {
      setOpsError(
        err instanceof Error ? err.message : 'Failed to launch ops sessions',
      );
    } finally {
      setOpsLoading(false);
    }
  }

  // Design(N) checkbox eligibility: Ready/In Progress 📐 Design and 📋 Planning
  // tasks. Backlog tasks of these types fall through to the Groom checkbox
  // instead (see groomableTasks above).
  function isDesignEligible(t: TaskView): boolean {
    return (
      DESIGN_TASK_TYPES.includes(t.taskType) &&
      (t.displayStatus === 'ready' || t.displayStatus === 'in_progress')
    );
  }
  const designEligibleTasks = tasks.filter(isDesignEligible);
  const designSelectedCount = designEligibleTasks.filter((t) =>
    designCheckedIds.has(t.taskId),
  ).length;

  function toggleDesignCheck(taskId: string, checked: boolean) {
    setDesignCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  function handleDesignSelectAll() {
    setDesignCheckedIds(new Set(designEligibleTasks.map((t) => t.taskId)));
  }

  function handleDesignClearSelection() {
    setDesignCheckedIds(new Set());
  }

  // Launches one individual design/planning session per checked, design-eligible
  // task via the unified planning-launch route, mirroring handleOpsLaunch.
  async function handleDesignLaunch() {
    const selectedIds = designEligibleTasks
      .filter((t) => designCheckedIds.has(t.taskId))
      .map((t) => t.taskId);
    if (!activeProjectId || !boardId || selectedIds.length === 0) return;
    setDesignLoading(true);
    setDesignError(null);
    try {
      const result = await opsJournalApi.launch(
        'design',
        activeProjectId,
        boardId,
        selectedIds,
        launchModel,
        launchEffort,
      );
      const launchedIds = new Set(result.launched);
      const deferredIds = new Set(result.deferred);
      setDesignLaunchedIds(
        selectedIds.filter((id) => launchedIds.has(bareTaskId(id))),
      );
      const deferred = selectedIds.filter((id) =>
        deferredIds.has(bareTaskId(id)),
      );
      const notLaunched = selectedIds.filter(
        (id) =>
          !launchedIds.has(bareTaskId(id)) && !deferredIds.has(bareTaskId(id)),
      );
      const messages: string[] = [];
      if (deferred.length > 0) {
        messages.push(
          `${deferred.length} selected task${deferred.length === 1 ? '' : 's'} waiting on dependencies — will launch when unblocked: ${deferred.join(', ')}`,
        );
      }
      if (notLaunched.length > 0) {
        messages.push(
          `${notLaunched.length} selected task${notLaunched.length === 1 ? '' : 's'} did not launch (not design-executable): ${notLaunched.join(', ')}`,
        );
      }
      setDesignError(messages.length > 0 ? messages.join(' ') : null);
      setDesignCheckedIds(new Set());
    } catch (err) {
      setDesignError(
        err instanceof Error ? err.message : 'Failed to launch design sessions',
      );
    } finally {
      setDesignLoading(false);
    }
  }

  // Build per-status lookup for the remaining code groups (needs_attention, ready_to_merge,
  // in_progress, in_review, blocked, deferred) — ready/backlog/done have their own sections.
  const codeGroupMap = new Map<DisplayStatus, TaskView[]>();
  for (const status of CODE_GROUP_ORDER) {
    codeGroupMap.set(
      status,
      sortByPriority(codeNotDone.filter((t) => t.displayStatus === status)),
    );
  }

  return (
    <div className={styles.taskListContainer}>
      {syncButton}
      <div className={styles.taskList} data-testid="task-list">
        {/* 💻 Code */}
        {CODE_GROUP_ORDER.map((status) => {
          const groupTasks = codeGroupMap.get(status) ?? [];
          if (groupTasks.length === 0) return null;

          const isExpanded = !collapsed.has(status);
          const label = GROUP_LABELS[status];

          return (
            <div key={status} className={styles.group} data-status={status}>
              <div
                className={`${styles.groupHeader} ${styles.groupHeaderToggle}`}
                onClick={() => toggleGroup(status)}
                role="button"
                aria-expanded={isExpanded}
                data-testid={`group-header-${status}`}
              >
                <span className={styles.groupLabel}>{label}</span>
                <span className={styles.groupCount}>{groupTasks.length}</span>
                <span className={styles.toggle} aria-hidden="true">
                  {isExpanded ? '▼' : '▶'}
                </span>
              </div>

              {isExpanded && (
                <div className={styles.groupCards}>
                  {groupTasks.map((task) => (
                    <TaskCard
                      key={task.taskId}
                      task={task}
                      selected={task.taskId === selectedTaskId}
                      onClick={() => onSelectTask(task.taskId)}
                      send={send}
                      project={project}
                      boardId={boardId}
                      onMoveStaged={setMoveIntent}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {readyCodeTasks.length > 0 && (
          <ReadySection
            key="ready"
            tasks={readyCodeTasks}
            onSelectTask={onSelectTask}
            send={send}
            project={project}
            isExpanded={!collapsed.has('ready')}
            onToggleCollapse={() => toggleGroup('ready')}
            onOptimisticDispatch={handleOptimisticDispatch}
          />
        )}

        {/* 🔲 Backlog — Code */}
        <BacklogCodeSection
          tasks={backlogCodeTasks}
          isExpanded={!collapsed.has('backlog')}
          onToggleCollapse={() => toggleGroup('backlog')}
          onSelectTask={onSelectTask}
          groomCheckedIds={groomCheckedIds}
          onGroomCheckChange={toggleGroomCheck}
          groomableCount={groomableTasks.length}
          groomSelectedCount={groomSelectedCount}
          onGroomSelectAll={handleGroomSelectAll}
          onGroomLaunch={() => void handleGroomLaunch()}
          groomLoading={groomLoading}
          launchModel={launchModel}
          onLaunchModelChange={setLaunchModel}
          launchEffort={launchEffort}
          onLaunchEffortChange={setLaunchEffort}
        />
        {groomError && (
          <div className={styles.error} data-testid="groom-error">
            {groomError}
          </div>
        )}

        {/* 📋 Non-code, by type */}
        {nonCodeNotDone.length > 0 && (
          <div
            className={`${styles.group} ${styles.nonCodeGroup}`}
            data-testid="non-code-section"
          >
            <div className={styles.sectionHeading}>
              <span className={styles.groupLabel}>📋 Non-code</span>
              <span className={styles.groupCount}>{nonCodeNotDone.length}</span>
              {opsEligibleTasks.length > 0 && (
                <div className={styles.launchControls}>
                  <button
                    className={styles.selectAllBtn}
                    onClick={handleOpsSelectAll}
                    disabled={opsLoading}
                    data-testid="ops-select-all-btn"
                  >
                    Select All
                  </button>
                  <button
                    className={styles.selectAllBtn}
                    onClick={handleOpsClearSelection}
                    disabled={opsLoading || opsSelectedCount === 0}
                    data-testid="ops-clear-btn"
                  >
                    Clear
                  </button>
                  <select
                    className={styles.select}
                    value={launchModel}
                    onChange={(e) => setLaunchModel(e.target.value)}
                    disabled={opsLoading}
                    data-testid="ops-model-select"
                  >
                    {MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className={styles.select}
                    value={launchEffort}
                    onChange={(e) => setLaunchEffort(e.target.value)}
                    disabled={opsLoading}
                    data-testid="ops-effort-select"
                  >
                    {EFFORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className={styles.opsBtn}
                    onClick={() => void handleOpsLaunch()}
                    disabled={opsLoading || !boardId || opsSelectedCount === 0}
                    data-testid="ops-btn"
                  >
                    {opsLoading ? 'Loading…' : `Ops (${opsSelectedCount})`}
                  </button>
                </div>
              )}
              {designEligibleTasks.length > 0 && (
                <div className={styles.launchControls}>
                  <button
                    className={styles.selectAllBtn}
                    onClick={handleDesignSelectAll}
                    disabled={designLoading}
                    data-testid="design-select-all-btn"
                  >
                    Select All
                  </button>
                  <button
                    className={styles.selectAllBtn}
                    onClick={handleDesignClearSelection}
                    disabled={designLoading || designSelectedCount === 0}
                    data-testid="design-clear-btn"
                  >
                    Clear
                  </button>
                  <select
                    className={styles.select}
                    value={launchModel}
                    onChange={(e) => setLaunchModel(e.target.value)}
                    disabled={designLoading}
                    data-testid="design-model-select"
                  >
                    {MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className={styles.select}
                    value={launchEffort}
                    onChange={(e) => setLaunchEffort(e.target.value)}
                    disabled={designLoading}
                    data-testid="design-effort-select"
                  >
                    {EFFORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className={styles.opsBtn}
                    onClick={() => void handleDesignLaunch()}
                    disabled={
                      designLoading || !boardId || designSelectedCount === 0
                    }
                    data-testid="design-btn"
                  >
                    {designLoading
                      ? 'Loading…'
                      : `Design (${designSelectedCount})`}
                  </button>
                </div>
              )}
            </div>
            {opsError && (
              <div className={styles.error} data-testid="ops-error">
                {opsError}
              </div>
            )}
            {designError && (
              <div className={styles.error} data-testid="design-error">
                {designError}
              </div>
            )}
            <NonCodeTypeSection
              tasks={nonCodeNotDone}
              onSelectTask={onSelectTask}
              groomCheckedIds={groomCheckedIds}
              onGroomCheckChange={toggleGroomCheck}
              opsCheckedIds={opsCheckedIds}
              onOpsCheckChange={toggleOpsCheck}
              isOpsEligible={isOpsEligible}
              designCheckedIds={designCheckedIds}
              onDesignCheckChange={toggleDesignCheck}
              isDesignEligible={isDesignEligible}
            />
          </div>
        )}

        <LaunchedSessionsBanner
          label={`${groomLaunchedIds.length} grooming session${groomLaunchedIds.length === 1 ? '' : 's'} launched`}
          taskIds={groomLaunchedIds}
          tasks={tasks}
          onSelectTask={onSelectTask}
          onDismiss={() => setGroomLaunchedIds([])}
          testId="groom-launched-panel"
        />

        <LaunchedSessionsBanner
          label={`${opsLaunchedIds.length} ops session${opsLaunchedIds.length === 1 ? '' : 's'} launched`}
          taskIds={opsLaunchedIds}
          tasks={tasks}
          onSelectTask={onSelectTask}
          onDismiss={() => setOpsLaunchedIds([])}
          testId="ops-launched-panel"
        />

        <LaunchedSessionsBanner
          label={`${designLaunchedIds.length} design session${designLaunchedIds.length === 1 ? '' : 's'} launched`}
          taskIds={designLaunchedIds}
          tasks={tasks}
          onSelectTask={onSelectTask}
          onDismiss={() => setDesignLaunchedIds([])}
          testId="design-launched-panel"
        />

        {moveIntent && (
          <div className={styles.opsPlaceholderPanel} data-testid="move-panel">
            <StagedIntentPanel
              intent={moveIntent}
              onApplied={() => {
                setMoveIntent(null);
                // A move touches two milestones' task_cache rows server-side;
                // the WS task_cache_updated broadcast alone won't repaint this
                // view unless it happens to be one of the affected boards, so
                // force the same re-fetch path the Sync button uses.
                void onForceRefetch?.();
              }}
              onRejected={() => setMoveIntent(null)}
              onDismiss={() => setMoveIntent(null)}
            />
          </div>
        )}

        {/* ✅ Done — all Types, collapsed by default */}
        {doneCount > 0 && (
          <div
            className={styles.group}
            data-status="done"
            data-testid="done-section"
          >
            <div
              className={`${styles.groupHeader} ${styles.groupHeaderToggle}`}
              onClick={() => toggleGroup('done')}
              role="button"
              aria-expanded={!collapsed.has('done')}
              data-testid="group-header-done"
            >
              <span className={styles.toggle} aria-hidden="true">
                {!collapsed.has('done') ? '▼' : '▶'}
              </span>
              <span className={styles.groupLabel}>{GROUP_LABELS.done}</span>
              <span className={styles.groupCount}>{doneCount}</span>
            </div>
            {!collapsed.has('done') && (
              <div className={styles.groupCards}>
                {sortByPriority(codeDoneTasks).map((task) => (
                  <TaskCard
                    key={task.taskId}
                    task={task}
                    selected={task.taskId === selectedTaskId}
                    onClick={() => onSelectTask(task.taskId)}
                    send={send}
                    project={project}
                  />
                ))}
                {sortByPriority(nonCodeDoneTasks).map((task) => (
                  <CompactTaskCard
                    key={task.taskId}
                    task={task}
                    showCheckbox={false}
                    checked={false}
                    onCheckChange={() => {}}
                    onClick={() => onSelectTask(task.taskId)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
