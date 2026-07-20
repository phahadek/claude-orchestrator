import { useState, useEffect, useMemo } from 'react';
import type { TaskView } from '../types/taskView';
import type { ProjectMilestone } from '../api/projects';
import { projectsApi, authedFetch } from '../api/projects';
import { taskMoveApi } from '../api/taskMove';
import { stagedIntentsApi, type StagedIntent } from '../api/stagedIntents';
import { toCanonicalStatus } from '@claude-orchestrator/backend/src/tasks/statusCanonical';
import type { MoveTaskContent } from '@claude-orchestrator/backend/src/tasks/TaskWriteCommands';
import styles from './TaskMoveDialog.module.css';

interface Props {
  task: TaskView;
  projectId: string;
  /** The board (Notion database) id the task's current milestone is sourced from. */
  currentBoardId: string | null;
  onClose: () => void;
  onStaged: (intent: StagedIntent) => void;
}

type Disposition = 'archive' | 'defer';

/**
 * Confirm UI for a cross-milestone task move: pick the target milestone and
 * disposition, preview the intra-milestone dependency impact (cascade set for
 * a later move, refusal reason for a blocked earlier move), then stage a
 * task.move intent through the general staged-intent surface. Never writes
 * directly — apply/reject happens through the shared StagedIntentPanel.
 */
export function TaskMoveDialog({
  task,
  projectId,
  currentBoardId,
  onClose,
  onStaged,
}: Props) {
  const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
  const [milestonesLoading, setMilestonesLoading] = useState(true);
  const [targetMilestoneId, setTargetMilestoneId] = useState<string>('');
  const [disposition, setDisposition] = useState<Disposition>('archive');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [cascadeSet, setCascadeSet] = useState<string[]>([]);
  const [isLaterMove, setIsLaterMove] = useState(false);
  const [refusalReason, setRefusalReason] = useState<string | null>(null);
  const [cascadeConfirmed, setCascadeConfirmed] = useState(false);
  const [staging, setStaging] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMilestonesLoading(true);
    projectsApi
      .listMilestones(projectId)
      .then((list) => {
        if (cancelled) return;
        setMilestones(list);
      })
      .finally(() => {
        if (!cancelled) setMilestonesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const currentMilestone = useMemo(
    () => milestones.find((m) => m.id === currentBoardId) ?? null,
    [milestones, currentBoardId],
  );

  const targetOptions = useMemo(
    () => milestones.filter((m) => m.id !== currentMilestone?.id),
    [milestones, currentMilestone],
  );

  useEffect(() => {
    setCascadeConfirmed(false);
    setRefusalReason(null);
    setCascadeSet([]);
    if (!currentMilestone || !targetMilestoneId) return;
    let cancelled = false;
    setPreviewLoading(true);
    taskMoveApi
      .preview({
        projectId,
        taskId: task.taskId,
        sourceMilestoneId: currentMilestone.id,
        targetMilestoneId,
      })
      .then((preview) => {
        if (cancelled) return;
        setIsLaterMove(preview.isLaterMove);
        setCascadeSet(preview.cascadeSet);
      })
      .catch((err) => {
        if (cancelled) return;
        setRefusalReason(
          err instanceof Error ? err.message : 'Move cannot be planned',
        );
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, task.taskId, currentMilestone, targetMilestoneId]);

  const targetMilestone = targetOptions.find((m) => m.id === targetMilestoneId);
  // Cascade confirmation is only required when the move actually pulls
  // dependents along; a later move with no dependents has nothing to confirm.
  const hasCascadeImpact = isLaterMove && cascadeSet.length > 0;
  const canStage =
    !!currentMilestone &&
    !!targetMilestone &&
    !refusalReason &&
    !previewLoading &&
    (!hasCascadeImpact || cascadeConfirmed) &&
    !staging;

  async function handleStage() {
    if (!currentMilestone || !targetMilestone) return;
    setStaging(true);
    setStageError(null);
    try {
      const res = await authedFetch(
        `/api/tasks/${encodeURIComponent(task.taskId)}/page?projectId=${encodeURIComponent(projectId)}`,
      );
      const body = (await res.json().catch(() => ({}))) as {
        markdown?: string;
      };
      const content: MoveTaskContent = {
        title: task.taskName,
        // The task body has no structured section parser (only a renderer),
        // so the full spec markdown is carried verbatim in `summary` — the
        // moved page's other sections stay empty rather than lossily guessed.
        sections: {
          summary: body.markdown ?? '',
          dependencies: [],
          context: [],
          automatedCriteria: [],
          manualCriteria: [],
        },
        type: task.taskType,
        priority: task.priority,
        status: toCanonicalStatus(task.notionStatus) ?? 'Backlog',
      };

      const payload = {
        taskId: task.taskId,
        content,
        sourceMilestone: {
          id: currentMilestone.id,
          displayOrder: currentMilestone.displayOrder,
        },
        targetMilestone: {
          id: targetMilestone.id,
          displayOrder: targetMilestone.displayOrder,
          databaseId: targetMilestone.sourceId ?? '',
        },
        originalDisposition: disposition,
        // Display-only extras for the shared staged-intent panel — ignored by
        // the backend apply path, which recomputes the plan from live data.
        taskName: task.taskName,
        sourceMilestoneName: currentMilestone.name,
        targetMilestoneName: targetMilestone.name,
        isLaterMove,
        cascadeSet,
      };

      const intent = await stagedIntentsApi.stage(
        'task.move',
        payload,
        projectId,
      );
      onStaged(intent);
      onClose();
    } catch (err) {
      setStageError(
        err instanceof Error ? err.message : 'Failed to stage move',
      );
    } finally {
      setStaging(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h2>Move Task</h2>
        <p className={styles.taskName}>{task.taskName}</p>

        {milestonesLoading ? (
          <p className={styles.loading}>Loading milestones…</p>
        ) : (
          <>
            <label className={styles.field}>
              <span>Target milestone</span>
              <select
                value={targetMilestoneId}
                onChange={(e) => setTargetMilestoneId(e.target.value)}
              >
                <option value="">Select a milestone…</option>
                {targetOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className={styles.field}>
              <legend>Original task disposition</legend>
              <label>
                <input
                  type="radio"
                  name="disposition"
                  value="archive"
                  checked={disposition === 'archive'}
                  onChange={() => setDisposition('archive')}
                />
                Archive (clean)
              </label>
              <label>
                <input
                  type="radio"
                  name="disposition"
                  value="defer"
                  checked={disposition === 'defer'}
                  onChange={() => setDisposition('defer')}
                />
                Defer (tombstone, points to the new page)
              </label>
            </fieldset>

            {previewLoading && (
              <p className={styles.loading}>Checking dependency impact…</p>
            )}

            {refusalReason && (
              <div
                className={styles.refusalBanner}
                data-testid="move-refusal-reason"
              >
                Move refused: {refusalReason}
              </div>
            )}

            {!refusalReason && isLaterMove && targetMilestone && (
              <div className={styles.cascadeBox} data-testid="move-cascade-set">
                <p>
                  {cascadeSet.length > 0
                    ? `${cascadeSet.length} dependent task(s) will move with it:`
                    : 'No dependents will be pulled along.'}
                </p>
                {cascadeSet.length > 0 && (
                  <ul>
                    {cascadeSet.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                )}
                {hasCascadeImpact && (
                  <label className={styles.confirmCascade}>
                    <input
                      type="checkbox"
                      checked={cascadeConfirmed}
                      onChange={(e) => setCascadeConfirmed(e.target.checked)}
                    />
                    I confirm moving this whole set
                  </label>
                )}
              </div>
            )}

            {stageError && (
              <div className={styles.errorBanner}>{stageError}</div>
            )}
          </>
        )}

        <div className={styles.footer}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canStage}
            onClick={() => void handleStage()}
          >
            {staging ? 'Staging…' : 'Stage Move'}
          </button>
        </div>
      </div>
    </div>
  );
}
