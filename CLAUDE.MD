# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix: Tasks panel detail pane shows "Select a task to view details" for a selected task
- **Notion task**: https://www.notion.so/Fix-Tasks-panel-detail-pane-shows-Select-a-task-to-view-details-for-a-selected-task-36e22f9152f38197a78af71a5e11a3da
- **Project context**: https://www.notion.so/33222f9152f38188b65fd912e40890a2

---

## Lifecycle

Follow these steps in order — every session:

> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — the task content has
> already been injected by the orchestrator. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Create your task branch from the current HEAD: `git checkout -b feature/<task-name>`.
3. Implement the task per the acceptance criteria.
4. Pass the pre-PR gate (see Pre-PR Gate section below).
5. Open a draft PR targeting `dev` using the required body template.
6. **Stop and wait.** The dashboard sends review feedback as follow-up messages.
   Address findings by pushing additional commits, then wait again.

---

## Status Ownership

**Do NOT update Notion task status.**
**Do NOT call any Notion API to change task status.**
The orchestrator backend handles all status transitions (In Progress → In Review → Done).

---

## Efficiency Rules

This session runs in `--print` mode with no human watching the output.
Optimize for speed and token efficiency:

- **Do NOT use TodoWrite.** No one sees the todo list. Track your progress internally.
- **Do NOT use Agent subagents for exploration.** Use Glob and Grep directly.
- **Minimize tool calls.** Batch independent reads. Don't re-read files you already read.
- **Keep commit messages and PR descriptions concise.** One sentence summaries, not essays.

---

## PR Format Standards

- **Title**: `feat: <task-name>` — no scope prefix like `(backend)`, no milestone tags.
- **How to create the PR**: Use the `mcp__github__create_pull_request` MCP tool.
  Do NOT use `gh pr create` — the `gh` CLI is not on PATH.
  Pass `draft: true`, `base: "dev"`, and the full body as the `body` parameter.
- **Required body sections** (no omissions, no reordering):

```
## Summary
<1-3 sentences: what changed and why>

## Notion Task
<link to the Notion task page>

## Automated Tests
<list tests added/modified, or "No test changes">

## Files Changed
<bulleted list of files with brief description of each change>
```

---

## Branch Rules

- Branch name: `feature/<task-name>` — created from the worktree's current HEAD
- Never commit directly to `dev` or `main`
- Never merge your own PR
- One task per session — no scope creep

---

## Commit Attribution

Every commit **must** include the following trailer (replace `<model>` and `<session-id>` with your actual model ID and session ID):

```
AI-Authored-By: <model> (session: <session-id>)
```

Example: `AI-Authored-By: claude-sonnet-4-6 (session: f98ff4ec)`

The backend verifies this trailer server-side. In corporate mode, missing trailers pause the task.

---

## Pre-PR Gate

Run in order — all must pass before opening the PR:

1. Stash CLAUDE.md before rebasing: `git stash push CLAUDE.md`
2. Rebase onto `dev` and resolve any conflicts.
3. Restore CLAUDE.md: `git stash pop`
4. `npx tsc --noEmit -p packages/frontend/tsconfig.json` — must pass.
5. `npx tsc --noEmit -p packages/backend/tsconfig.json` — must pass.
6. `npm run build` — must pass.
7. Stage only your implementation files for commit — never stage `CLAUDE.md`.

---

## Forbidden Actions

- Never push directly to `main`
- Never force push (`--force`)
- Never delete branches that live outside this worktree
- Never run `git reset --hard` on the main repository directory
- Never skip pre-commit hooks (`--no-verify`)
- Never stage or commit `CLAUDE.md` — it contains orchestrator-injected content that must not appear in PRs. Use `git add <specific files>` instead of `git add .`.

---

## Git Isolation

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\70efd070-6f2c-45c3-9c20-8216dcc565f9`.**
> This is your `cwd`. All commands run here. Never navigate to or operate on any parent directory.

- All git commands must run inside the worktree directory (your `cwd`)
- Never use `git -C <path>` pointing outside this worktree
- Never use `--work-tree` or `--git-dir` flags pointing outside this worktree
- Never run `git checkout` or `git switch` targeting a branch in the main repo directory
- The backend records the main repo branch before each session and will warn if it drifts

---

## Filesystem Isolation (Personal Mode)

> ⚠️ **Personal mode has no structural sandbox** — there is no docker, chroot, or
> namespace to prevent writes outside the worktree. All isolation is prompt-level.
> Violating these rules can corrupt the developer's live environment.

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\70efd070-6f2c-45c3-9c20-8216dcc565f9`).

- **Never write to the project root or any path above the worktree.**
  Scripts, tools, and generated outputs must target paths under the worktree, not the parent repo.
- **Dev state (SQLite databases, log files, generated artifacts) must use worktree-relative paths.**
  Do not reference absolute paths to project-root databases or output files.
  Use paths like `<worktree>/.dev-state/<file>` or resolve paths relative to `cwd`.
- **Before running any script that writes files or opens a database, verify the target path is inside the worktree.**
  If a script hardcodes an absolute project-root path, patch it to accept an env var or relative path before executing.

---

## Bash Rules (Permission System)

Your Bash commands are authorized by prefix matching on the **first token**.
Violating these rules causes **silent denial** — the command fails with no error message.

**Rule 1 — One command per Bash call.**
Never chain with `&&`, `;`, or `||`. Split into separate Bash calls.

**Rule 2 — Never prefix with `cd path &&`.**
You are already in the worktree directory. Just run the command directly.

**Rule 3 — No heredoc subshells in git commit.**
`git commit -m "$(cat <<'EOF'...)"` is denied. Use a simple `-m "message"` instead.
For multiline commit messages, write the message to `.claude/.commit-msg` with the Write tool, then run `git commit -F .claude/.commit-msg`. **Use that exact path** — the `.claude/` directory is gitignored, so the scratch file is never accidentally staged. Do not invent other filenames (`commit-msg.txt`, `.git-commit-msg.txt`, etc.) — they will leak into the PR diff.

**Rule 4 — Do not write to `/tmp/` or paths outside the worktree.**
Use the Write tool for any file creation. Never use `cat >`, `printf >`, or `echo >` redirects.

**Rule 5 — Use `npx` instead of bare tool names.**
`tsc` → `npx tsc`. Bare commands may not be on PATH.

---

## Task Spec

> This is the full task specification, pre-fetched by the orchestrator.
> Do NOT re-fetch this from Notion — use the content below as your source of truth.

## Summary
When a task in the Tasks panel is clicked (selection becomes visible in the list with the blue/yellow border), the detail pane on the right sometimes renders the empty placeholder ("Select a task to view details") instead of the TaskDetail component. Observed on the polimarket-analyser M2 board for a task in IN REVIEW status. Most likely root cause: TaskList and App.tsx maintain separate state copies of /api/tasks/active, fetched on different triggers — the user can click a task that is in TaskList.tasks but not yet in App.taskViews.
## Dependencies
None. Frontend-only fix. Should be verified once the running backend is restarted to include PR #411 (board-cache fix); the bug may be a stale-running-backend artifact only.
## Context
### Observed behavior
[Screenshot attached in original chat: polimarket M2 board, 3a-i: Thin CLI wrappers... task in IN REVIEW is selected (highlighted with yellow border), but the right pane shows Select a task to view details. The task is currently being worked on by an active session.]
### Code path
packages/frontend/src/App.tsx:921:
```typescript
{selectedTaskId &&
 taskViews.find((t) => t.taskId === selectedTaskId) ? (
  <ErrorBoundary name="TaskDetail">
    <TaskDetail task={taskViews.find((t) => t.taskId === selectedTaskId)!} ... />
  </ErrorBoundary>
) : (
  /* placeholder */
)}
```
App.taskViews is loaded by an effect (App.tsx:336):
```typescript
useEffect(() => {
  // ... fetch /api/tasks/active ... setTaskViews(data)
}, [activeProjectId, activeBoardId, tasksReady, taskListRefreshTrigger]);
```
TaskList.tsx:272 has its own tasks state, fetched independently from the same endpoint (TaskList.tsx:303):
```typescript
const [tasks, setTasks] = useState<TaskView[]>([]);
// ...
const fetchTasks = useCallback(async () => {
  // ... fetch /api/tasks/active ... setTasks(data)
}, [activeProjectId, boardId, isNonMilestoneView]);
```
TaskList re-fetches on its own reviewRefreshTrigger prop and on Sync button presses; App.tsx re-fetches on tasksReady (WS) and taskListRefreshTrigger. These trigger sets are similar but not identical, so the two states can drift.
### Why this manifests now
The data shape from /api/tasks/active is fine post-PR #411 (we confirmed via curl that the polimarket M2 board returns 59 task rows with prefixed taskId fields). The selected task IS in the response. But if TaskList re-fetched after a WS-driven update and App.tsx did not, App's taskViews is stale (or empty after an initial load failure that never retried).
### Hypotheses to confirm during implementation
1. Sync gap: TaskList has the task; App.taskViews does not because the trigger sets diverge. Fix: lift taskViews to a shared source (a context or a single hook) so both consumers read from the same store.
1. Shape mismatch: TaskList passes a taskId form (e.g., raw) that App.taskViews stores in a different form (e.g., prefixed). Fix: normalize at the boundary or assert both sides agree. Less likely now that PR #411 has unified prefixing, but worth verifying with a quick console log post-restart.
1. Race on initial mount: App.tsx's effect runs after the user clicks, but the click resolved against TaskList's earlier-loaded state. Fix: gate the rendering by waiting for both to be loaded, OR show a transient loading state in the detail pane instead of the misleading empty placeholder.
### Verification step before implementation
Restart the orchestrator (the running backend is on f92b734; latest dev has 4 more commits including the worktree-sync + push-detected fixes). Then reproduce: open the Tasks panel for polimarket M2, click any task that's in IN REVIEW or RUNNING state, and check whether the detail pane renders. If the bug persists post-restart, proceed with the lift-to-shared-state fix. If it disappears, downgrade priority or close as a stale-cache artifact.
### What changes (assuming bug confirmed post-restart)
1. Lift taskViews to a single source. Either:
1. Render an explicit loading state in the detail pane when selectedTaskId is set but taskViews is still loading (or empty). The current empty-placeholder is misleading when a task IS selected.
1. Add a defensive console.warn in the detail-pane render when selectedTaskId is set but no matching task is found in taskViews, to surface future drift in dev mode.
### Out of scope
- Migrating to a global state library (Redux/Zustand) — unnecessary for this bug.
- The TaskList sync trigger refactor (reviewRefreshTrigger) — separate concern.
- The board-cache fix from PR #411 — already merged; this task assumes its behavior on the running backend.
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for the frontend package.
- Unit test: when selectedTaskId is set and the matching task exists in the shared task-views source, TaskDetail renders with the task data.
- Unit test: when selectedTaskId is set and no matching task exists, the loading-state placeholder renders (NOT the misleading empty placeholder).
- Unit test: after a fetch refresh that brings in the previously-missing task, the detail pane swaps from loading-state to TaskDetail.
- Component test (or integration): TaskList click handler propagates the same taskId form that's used as the key in the shared task-views source (regression for shape mismatch).
## Files / paths affected
- packages/frontend/src/App.tsx (update — lift taskViews to be the single source; remove the duplicate fetch in TaskList if going with option (a))
- packages/frontend/src/components/TaskList.tsx (update — accept tasks as a prop, remove local state + fetch, if option (a))
- packages/frontend/src/components/TaskDetail.tsx (update if rendering a loading state vs empty placeholder)
- packages/frontend/src/components/__tests__/TaskDetail.test.tsx (update — add the cases above)
- packages/frontend/src/__tests__/AppMilestoneRaceCondition.test.tsx or equivalent (update — add the regression case)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/frontend/src/App.tsx`
```
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { EnrollmentFlow } from './auth/EnrollmentFlow';
import type { ConnectionState } from './hooks/useWebSocket';
import { useSessionStore } from './hooks/useSessionStore';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNotifications } from './hooks/useNotifications';
import { useIsMobile } from './hooks/useIsMobile';
import { Header } from './components/Header';
import type { TopView } from './components/Header';
import { SessionGrid } from './components/SessionGrid';
import { HistoryGrid } from './components/HistoryGrid';
import { SessionDetail } from './components/SessionDetail';
import { PRPanel } from './components/PRPanel';
import { DispatchModal } from './components/DispatchModal';
import { PermissionEventLog } from './components/PermissionEventLog';
import { TaskList } from './components/TaskList';
import { TaskDetail } from './components/TaskDetail';
import { Settings } from './components/Settings';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { Notifications } from './components/Notifications';
import { ShortcutHint } from './components/ShortcutHint';
import { SessionFilterBar } from './components/SessionFilterBar';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { NotificationItem } from './components/Notifications';
import type { ServerMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { calculateCost } from '@claude-orchestrator/backend/src/utils/usage';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type {
  Session,
  EventType,
} from '@claude-orchestrator/backend/src/db/types';
import styles from './App.module.css';

interface ArchivedSessionEvent {
  eventType: EventType;
  content: string;
  timestamp: number;
  messageId?: string;
}

interface ArchivedSessionResponse {
  session: Session;
  events: ArchivedSessionEvent[];
}

const DEFAULT_DETAIL_WIDTH = 40;
const MIN_DETAIL_WIDTH_PCT = 20;
const MAX_DETAIL_WIDTH_PCT = 80;
const MIN_LEFT_PANEL_PX = 300;
const MIN_RIGHT_PANEL_PX = 300;

const ACTIVE_PROJECT_KEY = 'activeProjectId';
const ACTIVE_MILESTONE_KEY_PREFIX = 'activeMilestone_';

function getMilestoneKey(projectId: string) {
  return `${ACTIVE_MILESTONE_KEY_PREFIX}${projectId}`;
}

function getDefaultBoardId(project: ProjectConfig): string {
  return project.boards?.[0]?.id ?? project.boardId;
}

function resolveActiveBoardId(project: ProjectConfig): string {
  const stored = localStorage.getItem(getMilestoneKey(project.id));
  const boards = project.boards ?? [];
  if (stored && boards.some((b) => b.id === stored)) {
    return stored;
  }
  return getDefaultBoardId(project);
}

export default function App() {
  const [needsEnrollment, setNeedsEnrollment] = useState(false);

  useEffect(() => {
    const handler = () => setNeedsEnrollment(true);
    window.addEventListener('device-unauthorized', handler);
    return () => window.removeEventListener('device-unauthorized', handler);
  }, []);

  const {
    sessions,
    tasks,
    tasksReady,
    synced,
    readyCount,
    blockedCount,
    dispatch,
    resetTasks,
    deleteSession,
    setSessionArchived,
    setSessionFavorited,
    prRefreshTrigger,
    lastPrReviewEvent,
    lastPrMergedEvent,
    lastPrClosedEvent,
    lastPrStateChangedEvent,
    lastPrMergeabilityChangedEvent,
    lastReviewEscalation,
    lastReviewFailed,
    lastStuckNotification,
    lastStuckPaused,
    lastStuckKilled,
    lastApiOverloadedPaused,
    incompleteReviews,
    lastTaskUpdate,
    taskListRefreshTrigger,
    lastAutofixEvent,
    lastReviewStartedEvent,
  } = useSessionStore();
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [activeView, setActiveView] = useState<
    'sessions' | 'history' | 'denials'
  >('sessions');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const notifiedRef = useRef<Set<string>>(new Set());
  const [showReconnected, setShowReconnected] = useState(false);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const prevConnectionState = useRef<ConnectionState>('disconnected');

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const handleWsMessage = useCallback(
    (msg: Parameters<typeof dispatch>[0]) => {
      if (msg.type === 'error') {
        const notifId = crypto.randomUUID();
        setNotifications((prev) => [
          ...prev,
          { id: notifId, message: msg.message, status: 'error' },
        ]);
        setTimeout(() => dismissNotification(notifId), 10_000);
        return;
      }
      dispatch(msg);
    },
    [dispatch, dismissNotification],
  );

  const { send, connectionState } = useWebSocket(handleWsMessage);

  const [cardPreviewLines, setCardPreviewLines] = useState<number>(3);
  const [sessionMode, setSessionMode] = useState<string>('cli');
  const [autoLaunchCap, setAutoLaunchCap] = useState<number>(1);
  const [autoLaunchPollIntervalMs, setAutoLaunchPollIntervalMs] =
    useState<number>(60000);

  const [detailWidthPct, setDetailWidthPct] = useState<number>(() => {
    const saved = localStorage.getItem('sessionDetailWidth');
    if (saved) {
      const n = Number(saved);
      if (n >= MIN_DETAIL_WIDTH_PCT && n <= MAX_DETAIL_WIDTH_PCT) return n;
    }
    return DEFAULT_DETAIL_WIDTH;
  });
  const [isDragging, setIsDragging] = useState(false);
  const detailWidthRef = useRef(detailWidthPct);

  const [topView, setTopView] = useState<TopView>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskViews, setTaskViews] = useState<TaskView[]>([]);
  const settingsInitialTab = 'general' as const;
  const isMobile = useIsMobile();

  useEffect(() => {
    detailWidthRef.current = detailWidthPct;
  }, [detailWidthPct]);

  // Send fetch_tasks after React commits state — covers user switches and WS reconnects
  useEffect(() => {
    if (connectionState !== 'connected' || !activeProjectId || !activeBoardId)
      return;
    send({
      type: 'fetch_tasks',
      projectId: activeProjectId,
      milestoneId: activeBoardId,
    });
  }, [connectionState, activeProjectId, activeBoardId, send]);

  useEffect(() => {
    if (connectionState === 'connected') {
      if (hasConnectedOnce) {
        setShowReconnected(true);
        const timer = setTimeout(() => setShowReconnected(false), 3000);
        return () => clearTimeout(timer);
      }
      setHasConnectedOnce(true);
    }
    prevConnectionState.current = connectionState;
  }, [connectionState, hasConnectedOnce]);

  const handleArchiveAll = useCallback(async () => {
    await fetch('/api/sessions/archive-finished', { method: 'POST' });
    for (const s of sessions) {
      if (!s.archived && ['done', 'error', 'killed'].includes(s.status)) {
        setSessionArchived(s.sessionId, true);
      }
    }
  }, [sessions, setSessionArchived]);

  const RESUME_MESSAGE = 'Limits have reset. Continue where you left off.';

  const handleResume = useCallback(
    (sessionId: string) => {
      send({ type: 'send_message', sessionId, message: RESUME_MESSAGE });
  
[... truncated]
```

### `packages/frontend/src/components/TaskList.tsx`
```
import { useState, useEffect, useCallback, useRef } from 'react';
import type { TaskView, DisplayStatus } from '../types/taskView';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { TaskCard } from './TaskCard';
import { CompactTaskCard } from './CompactTaskCard';
import { useDispatch } from '../hooks/useDispatch';
import { projectsApi } from '../api/projects';
import styles from './TaskList.module.css';

interface Props {
  activeProjectId: string | null;
  boardId: string | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** Latest task_updated WS message — merges a single task in-place without a full re-fetch. */
  lastTaskUpdate?: TaskView | null;
  /** Incremented when a review session starts or pr_review_complete arrives — triggers a full re-fetch. */
  reviewRefreshTrigger?: number;
  send: (msg: ClientMessage) => boolean;
  project: ProjectConfig | null;
}

const GROUP_ORDER: DisplayStatus[] = [
  'needs_attention',
  'ready_to_merge',
  'in_progress',
  'in_review',
  'ready',
  'done',
];

const GROUP_LABELS: Record<DisplayStatus, string> = {
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  in_progress: '🔄 In Progress',
  in_review: '👀 In Review',
  ready: '🗂️ Ready',
  done: '✔️ Done',
  backlog: '🗂️ Backlog',
};

const PRIORITY_RANK: Record<string, number> = {
  '🔴 High': 0,
  '🟡 Medium': 1,
  '🟢 Low': 2,
};

function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? 99;
}

/** Group tasks by wave number, returning a map of wave → sorted tasks. */
function groupByWave(tasks: TaskView[]): Map<number, TaskView[]> {
  const map = new Map<number, TaskView[]>();
  for (const task of tasks) {
    const wave = task.wave ?? 1;
    if (!map.has(wave)) map.set(wave, []);
    map.get(wave)!.push(task);
  }
  for (const [, waveTasks] of map) {
    waveTasks.sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
    );
  }
  return map;
}

/** Compact wave-grouped section for Ready tasks with Select All / Launch controls. */
function ReadySection({
  tasks,
  nonCodeTasks,
  onSelectTask,
  send,
  project,
  isExpanded,
  onToggleCollapse,
  onOptimisticDispatch,
}: {
  tasks: TaskView[];
  nonCodeTasks: TaskView[];
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
  const totalCount = tasks.length + nonCodeTasks.length;
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
      .map((t) => ({ taskId: t.taskId, taskType: t.taskType }));
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

          {nonCodeTasks.length > 0 && (
            <div className={styles.waveGroup} data-testid="non-code-wave-group">
              <div
                className={styles.waveHeader}
                data-testid="non-code-wave-header"
              >
                <span className={styles.waveLabel}>Non-Code</span>
              </div>
              {nonCodeTasks
                .sort(
                  (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
                )
                .map((task) => (
                  <CompactTaskCard
                    key={task.taskId}
                    task={task}
                    showCheckbox={false}
                    checked={false}
                    onCheckChange={() => {}}
                    onC
[... truncated]
```

### `packages/frontend/src/components/TaskDetail.tsx`
```
import { useState, useRef, useEffect, useCallback } from 'react';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { DisplayStatus } from '@claude-orchestrator/backend/src/tasks/TaskStatusEngine';
import type { SessionState } from '../hooks/useSessionStore';
import { StatusBadge } from './StatusBadge';
import { EventTranscript } from './EventTranscript';
import { DiffViewer } from './DiffViewer';
import { SessionDetail } from './SessionDetail';
import { parseReviewResultFromEvents } from './ReviewDetailView';
import { formatTokenCount } from '@claude-orchestrator/backend/src/utils/usage';
import { sessionsApi } from '../api/projects';
import { useIsMobile } from '../hooks/useIsMobile';
import styles from './TaskDetail.module.css';

// ── Display status helpers ─────────────────────────────────────────

const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  ready: '🗂️ Ready',
  in_progress: '🔄 In Progress',
  in_review: '🔍 In Review',
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  done: '✓ Done',
  backlog: '🗂️ Backlog',
};

const DISPLAY_STATUS_CSS_KEYS: Record<DisplayStatus, string> = {
  ready: 'status--ready',
  in_progress: 'status--in-progress',
  in_review: 'status--in-review',
  needs_attention: 'status--needs-attention',
  ready_to_merge: 'status--ready-to-merge',
  done: 'status--done',
  backlog: 'status--backlog',
};

const VERDICT_LABELS: Record<string, string> = {
  approved: '✅ Approved',
  needs_changes: '⚠️ Needs Changes',
  incomplete: '❌ Incomplete',
  error: '⚠️ Review Error',
};

const VERDICT_CSS_KEYS: Record<string, string> = {
  approved: 'verdict--approved',
  needs_changes: 'verdict--needs-changes',
  incomplete: 'verdict--incomplete',
  error: 'verdict--error',
};

// ── PR state helpers ───────────────────────────────────────────────

function prStateLabel(state: string, draft: boolean): string {
  if (draft) return 'Draft';
  switch (state) {
    case 'open':
      return 'Open';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    default:
      return state;
  }
}

// ── Parse owner/repo from GitHub PR URL ───────────────────────────

function parseOwnerRepo(prUrl: string): { owner: string; repo: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// ── Inline composer ───────────────────────────────────────────────

interface ComposerProps {
  sessionId: string;
  send: (msg: ClientMessage) => void;
}

function InlineComposer({ sessionId, send }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSend() {
    if (!draft.trim()) return;
    send({ type: 'send_message', sessionId, message: draft });
    setDraft('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  return (
    <div className={styles.composer}>
      <textarea
        ref={textareaRef}
        className={styles.composerInput}
        value={draft}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder="Send a message to the session…"
      />
      <button
        className={styles.sendButton}
        onClick={handleSend}
        disabled={!draft.trim()}
      >
        Send
      </button>
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────

interface Props {
  task: TaskView;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
  sessions?: SessionState[];
  projectId?: string;
  /** When true, shows the "Mark Merged" button for local-only projects. */
  isLocalOnly?: boolean;
  /** When true, hides the "Mark Merged" button — AutoMerger handles merging. */
  autoMergeEnabled?: boolean;
}

// ── TaskDetail ────────────────────────────────────────────────────

export function TaskDetail({
  task,
  send,
  onClose,
  sessions = [],
  projectId,
  isLocalOnly = false,
  autoMergeEnabled = false,
}: Props) {
  const isMobile = useIsMobile();
  const [showReviewSection, setShowReviewSection] = useState(true);
  const [mobileOpenSection, setMobileOpenSection] = useState<
    'review' | 'pr' | null
  >('review');
  const [showReviewDimensions, setShowReviewDimensions] = useState(false);
  const [reviewInFlight, setReviewInFlight] = useState(false);
  const [mergeInFlight, setMergeInFlight] = useState(false);
  const [markMergedInFlight, setMarkMergedInFlight] = useState(false);
  const [fixConflictsInFlight, setFixConflictsInFlight] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [optimisticDisplayStatus, setOptimisticDisplayStatus] =
    useState<DisplayStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'diff'>('overview');
  const [sessionOverlayOpen, setSessionOverlayOpen] = useState(false);

  // Reset state when task changes
  useEffect(() => {
    setShowReviewSection(true);
    setMobileOpenSection('review');
    setShowReviewDimensions(false);
    setReviewError(null);
    setFixConflictsInFlight(false);
    setOptimisticDisplayStatus(null);
    setActiveTab('overview');
    setSessionOverlayOpen(false);
  }, [task.taskId]);

  // Look up live session state for event transcripts
  const codeSession = task.codeSession
    ? (sessions.find((s) => s.sessionId === task.codeSession!.sessionId) ??
      null)
    : null;
  const reviewSession = task.review
    ? (sessions.find((s) => s.sessionId === task.review!.sessionId) ?? null)
    : null;

  const liveStatus = codeSession?.status ?? task.codeSession?.status;
  const isCodeActive =
    liveStatus === 'running' || liveStatus === 'needs_permission';

  function handleKill() {
    if (!task.codeSession || !isCodeActive) return;
    if (confirm('Kill this session? It will have 15 seconds to wrap up.')) {
      send({ type: 'kill', sessionId: task.codeSession.sessionId });
    }
  }

  const effectiveDisplayStatus = optimisticDisplayStatus ?? task.displayStatus;
  const displayStatusLabel =
    DISPLAY_STATUS_LABELS[effectiveDisplayStatus] ?? effectiveDisplayStatus;
  const displayStatusClass =
    DISPLAY_STATUS_CSS_KEYS[effectiveDisplayStatus] ?? '';

  async function handleRunReview() {
    if (!task.pr) return;
    setReviewInFlight(true);
    setReviewError(null);
    try {
      const url = projectId
        ? `/api/prs/${task.pr.prNumber}/review?projectId=${encodeURIComponent(projectId)}`
        : `/api/prs/${task.pr.prNumber}/review`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setReviewError(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setReviewInFlight(false);
    }
  }

  async function handleFixConflicts() {
    if (!task.pr) return;
    setFixConflictsInFlight(true);
    setReviewError(null);
    try {
      const ownerRepo = parseOwnerRepo(task.pr.prUrl);
      if (!ownerRepo) {
        setReviewError('Could not parse owner/repo from PR URL.');
        return;
      }
      const res = await fetch(
        `/api/prs/${ownerRepo.owner}/${ownerRepo.repo}/${task.pr.prNumber}/fix-conflicts`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setReviewError(body.error ?? `HTTP ${r
[... truncated]
```

### `packages/frontend/src/components/__tests__/TaskDetail.test.tsx`
```
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TaskDetail } from '../TaskDetail';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { SessionState } from '../../hooks/useSessionStore';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Implement something',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '🔴 High',
    notionUrl: 'https://notion.so/task-1',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    ...overrides,
  };
}

function makeSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: 'sess-1',
    taskName: 'Test Task',
    notionTaskUrl: 'https://notion.so/task',
    status: 'running',
    events: [],
    ...overrides,
  };
}

function makeCodeSession(
  overrides?: Partial<NonNullable<TaskView['codeSession']>>,
): NonNullable<TaskView['codeSession']> {
  return {
    sessionId: 'sess-1',
    status: 'running',
    startedAt: Date.now() - 60000,
    endedAt: null,
    lastMessage: 'Working on implementation…',
    inputTokens: 1000,
    outputTokens: 500,
    ...overrides,
  };
}

function makePr(
  overrides?: Partial<NonNullable<TaskView['pr']>>,
): NonNullable<TaskView['pr']> {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'feat: implement something',
    headBranch: 'feature/something',
    baseBranch: 'dev',
    state: 'open',
    draft: false,
    mergeState: null,
    ...overrides,
  };
}

function makeReview(
  overrides?: Partial<NonNullable<TaskView['review']>>,
): NonNullable<TaskView['review']> {
  return {
    sessionId: 'review-sess-1',
    status: 'done',
    verdict: 'approved',
    summary: 'All checks pass.',
    iterationCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

// ── useIsMobile mock ────────────────────────────────────────────────
// Controls the mobile/desktop mode for each test without touching browser globals.
let isMobileValue = false;
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileValue,
}));

// jsdom does not implement matchMedia — provide a default desktop stub.
beforeEach(() => {
  isMobileValue = false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false, // desktop by default
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('TaskDetail', () => {
  it('renders task name', () => {
    render(<TaskDetail task={makeTask()} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Implement something')).toBeTruthy();
  });

  it('renders display status badge', () => {
    render(
      <TaskDetail
        task={makeTask({ displayStatus: 'in_progress' })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('🔄 In Progress')).toBeTruthy();
  });

  it('renders priority badge', () => {
    render(
      <TaskDetail
        task={makeTask({ priority: '🔴 High' })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('🔴 High')).toBeTruthy();
  });

  it('renders Notion link', () => {
    render(<TaskDetail task={makeTask()} send={vi.fn()} onClose={vi.fn()} />);
    const link = screen.getByText('Notion ↗');
    expect(link.getAttribute('href')).toBe('https://notion.so/task-1');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<TaskDetail task={makeTask()} send={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ── Code session section ──

  it('does not render code session section when codeSession is null', () => {
    render(
      <TaskDetail
        task={makeTask({ codeSession: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Code Session')).toBeNull();
  });

  it('renders code session section header with status', () => {
    const codeSession = makeCodeSession();
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Code Session')).toBeTruthy();
    // The full transcript replaces the lastMessage preview when the session is
    // available in the sessions prop (otherwise a "not loaded" placeholder).
    expect(screen.getByText(/Transcript not available/)).toBeTruthy();
  });

  it('renders elapsed time in code session section', () => {
    const codeSession = makeCodeSession({
      startedAt: Date.now() - 65000,
      endedAt: null,
    });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Some elapsed time should be shown (1m 5s or similar)
    expect(screen.getByText('Code Session')).toBeTruthy();
  });

  it('shows message composer for active code session', () => {
    const codeSession = makeCodeSession({ status: 'running' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
  });

  it('does not show composer for finished code session', () => {
    const codeSession = makeCodeSession({ status: 'done' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByPlaceholderText('Send a message to the session…'),
    ).toBeNull();
  });

  it('sends send_message when composer is submitted', () => {
    const send = vi.fn();
    const codeSession = makeCodeSession({
      status: 'running',
      sessionId: 'sess-abc',
    });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={send}
        onClose={vi.fn()}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      'Send a message to the session…',
    );
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Send'));
    expect(send).toHaveBeenCalledWith({
      type: 'send_message',
      sessionId: 'sess-abc',
      message: 'hello',
    } as ClientMessage);
  });

  // The full transcript is now always shown inline (no toggle button).

  // ── PR section ──

  it('does not render PR section when pr is null', () => {
    render(
      <TaskDetail
        task={makeTask({ pr: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Pull Request')).toBeNull();
  });

  it('renders PR number and title', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.getByText('feat: implement something')).toBeTruthy();
  });

  it('renders PR branch info', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('feature/something → dev')).toBeTruthy();
  });

  it('renders GitHub link for PR', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    const link = screen.getByText('G
[... truncated]
```

---

## Local Context

> Host-local context loaded from `.claude/local-context.md`.

# Local Context — host-specific configuration

This file is **gitignored**. It contains environment-specific URLs, IDs, and
references that should never be committed to the repo.

The orchestrator backend automatically appends the contents of this file to the
merged `CLAUDE.md` written into each session worktree.

---

## Project Context

- **Project Context page** (Notion): https://www.notion.so/Claude-Code-Dashboard-33222f9152f38188b65fd912e40890a2
- **Active Task Board** (Notion): https://www.notion.so/3edf1af401744a158c0e116810a8ce07

## Design & Architecture

- **Product Design Doc**: https://www.notion.so/33222f9152f381b99db7ead36cfcf057
- **Technical Architecture**: https://www.notion.so/33222f9152f3812681a3c9be7ae4270c
- **Dev Setup & Git**: https://www.notion.so/33222f9152f381098a9ffc16a8bd46cb
- **Coding Guidelines**: https://www.notion.so/33322f9152f3811ca9e7de3be99c2e06
- **Task Writing Guidelines**: https://www.notion.so/33222f9152f381738b77e8e972be7419
- **Backlog Grooming Sessions**: https://www.notion.so/33622f9152f3811d8e4de56b74fb0eb4

## Boards (per milestone)

- **M1 — MVP (Session Browser + Streaming UI)**: https://www.notion.so/cc16d2649d594a2dbc6ca7b056d095b0 — ✅ Done (2026-03-31)
- **M2 — Multi-Project & Interactive Sessions**: https://www.notion.so/4c30510be98448e49ffa6f7917650ee6 — ✅ Done (2026-04-02)
- **M2a — Orchestrator & Lifecycle Automation**: https://www.notion.so/19287f317923488b8533f02704f1396e — ✅ Done (2026-04-03)
- **M3 — Polish & Public Release**: https://www.notion.so/ca4d62a52c1a468bb23f2419dc8cc94b — 🔲 Active
- **M4 — Stabilize for Full-Auto**: https://www.notion.so/58383a0cf4424fa3a23223eebee97459 — ✅ Done (2026-05-22)
- **M5 — Privacy, Bit-rot & UX Polish**: https://www.notion.so/2932df9453ea47d7827b8c17758d77d8 — ✅ Done (2026-05-26)
- **M6 — Enterprise Adoption Readiness**: https://www.notion.so/3edf1af401744a158c0e116810a8ce07 — 🔲 Active

## Notes

- Current phase: **M6 — Enterprise Adoption Readiness**
- Filter the active task board to `💻 Code` type tasks unless instructed otherwise.