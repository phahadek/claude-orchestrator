import { useState, useEffect } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { apiRequest } from '../api/projects';
import { ReviewDetailView, type DepthReviewStatus } from './ReviewDetailView';
import { EventTranscript } from './EventTranscript';
import { DiffViewer } from './DiffViewer';
import { SessionControls } from './SessionControls';
import { Composer } from './Composer';
import { DecisionPanel } from './DecisionPanel';
import styles from './SessionDetail.module.css';

/** The subset of the GET /api/prs/depth-dispositions response item shape this hook needs. */
interface PrsApiItem {
  prNumber: number;
  depthVerdict: {
    verdict: string;
    escalated: boolean;
    sessionId: string | null;
    routeCount: number;
  } | null;
}

/**
 * Self-fetches the escalated/routed disposition for a single depth_review
 * session's own PR — mirrors useMilestoneDepthReviewStatusBySession
 * (MilestoneView.tsx) but scoped to one session instead of a whole
 * milestone's tasks, so SessionPanel renders the badge correctly wherever
 * it's reached (SessionDetail, TaskDetail, GateReadinessPanel) and not only
 * via the milestone drill-down, which already supplies the prop itself.
 */
function useDepthReviewStatus(
  projectId: string | null | undefined,
  prNumber: number | null | undefined,
  sessionId: string,
): DepthReviewStatus | null {
  const [status, setStatus] = useState<DepthReviewStatus | null>(null);

  useEffect(() => {
    if (!projectId || !prNumber) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    apiRequest<PrsApiItem[]>(
      `/api/prs/depth-dispositions?projectId=${encodeURIComponent(projectId)}&prNumbers=${prNumber}`,
    )
      .then((items) => {
        if (cancelled) return;
        const item = items.find((i) => i.prNumber === prNumber);
        const verdict = item?.depthVerdict;
        if (!verdict || verdict.verdict === 'pass' || verdict.sessionId !== sessionId) {
          setStatus(null);
          return;
        }
        setStatus({ escalated: verdict.escalated, routeCount: verdict.routeCount });
      })
      .catch(() => {
        if (cancelled) return;
        setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, prNumber, sessionId]);

  return status;
}

interface Props {
  session: SessionState;
  send: (msg: ClientMessage) => void;
  setSessionArchived: (sessionId: string, archived: boolean) => void;
  setSessionFavorited: (sessionId: string, favorited: boolean) => void;
  onDeleted?: (sessionId: string) => void;
  onResume?: (sessionId: string) => void;
  sessionMode?: string;
  project?: ProjectConfig | null;
  onClose?: () => void;
  showTaskName?: boolean;
  /** Opt out of the embedded proposals/decision block — for surfaces (e.g. the milestone drill-down) that already render the session's staged intents elsewhere. Defaults to shown. */
  showDecisionPanel?: boolean;
  /** Escalated/routed disposition for a depth_review session — not part of its own emitted JSON. When explicitly supplied (including `null`), used as-is — for callers like the milestone drill-down that already batch-fetch it. When left `undefined`, SessionPanel self-fetches it via useDepthReviewStatus. Ignored for other session types. */
  depthReviewStatus?: DepthReviewStatus | null;
}

export function SessionPanel({
  session,
  send,
  setSessionArchived,
  setSessionFavorited,
  onDeleted,
  onResume,
  sessionMode,
  project = null,
  onClose,
  showTaskName = true,
  showDecisionPanel = true,
  depthReviewStatus,
}: Props) {
  const [showReviewTranscript, setShowReviewTranscript] = useState(false);
  const [activeTab, setActiveTab] = useState<'transcript' | 'diff'>(
    'transcript',
  );

  useEffect(() => {
    setActiveTab('transcript');
  }, [session.sessionId]);

  const selfFetchedDepthReviewStatus = useDepthReviewStatus(
    session.project_id,
    session.sessionType === 'depth_review' ? session.prNumber : null,
    session.sessionId,
  );
  const resolvedDepthReviewStatus =
    depthReviewStatus !== undefined
      ? depthReviewStatus
      : selfFetchedDepthReviewStatus;

  const isActive =
    session.status === 'running' ||
    session.status === 'needs_permission' ||
    session.status === 'idle' ||
    session.status === 'paused';

  return (
    <div className={styles.layout}>
      <div className={styles.panel}>
        <div className={styles.header}>
          {showTaskName && (
            <span className={styles.taskName}>
              {taskNameFromNotionUrl(session.taskName)}
            </span>
          )}
          <SessionControls
            embedded
            session={session}
            send={send}
            sessionMode={sessionMode}
            project={project}
            setSessionArchived={setSessionArchived}
            setSessionFavorited={setSessionFavorited}
            onDeleted={onDeleted}
            onResume={onResume}
            onClose={onClose}
          />
        </div>

        {session.sessionType === 'review' ||
        session.sessionType === 'depth_review' ? (
          <>
            <ReviewDetailView
              session={session}
              depthReviewStatus={
                session.sessionType === 'depth_review'
                  ? resolvedDepthReviewStatus
                  : null
              }
            />

            <div className={styles.reviewTranscriptOuter}>
              <div className={styles.transcriptOverlay}>
                <button
                  className={styles.copyButton}
                  onClick={() => setShowReviewTranscript((v) => !v)}
                  aria-expanded={showReviewTranscript}
                >
                  {showReviewTranscript
                    ? '▼ Hide transcript'
                    : '▶ Show session transcript'}
                </button>
              </div>
              {showReviewTranscript && (
                <EventTranscript events={session.events} />
              )}
            </div>
          </>
        ) : (
          <>
            {session.prUrl != null && (
              <div className={styles.tabBar}>
                <button
                  className={`${styles.tabButton} ${activeTab === 'transcript' ? styles['tabButton--active'] : ''}`}
                  onClick={() => setActiveTab('transcript')}
                >
                  Transcript
                </button>
                <button
                  className={`${styles.tabButton} ${activeTab === 'diff' ? styles['tabButton--active'] : ''}`}
                  onClick={() => setActiveTab('diff')}
                >
                  Diff
                </button>
              </div>
            )}

            {activeTab === 'transcript' && (
              <EventTranscript
                events={session.events}
                permissionDenials={session.permissionDenials}
              />
            )}

            {activeTab === 'diff' &&
              session.prUrl != null &&
              (() => {
                const match = /\/pull\/(\d+)/.exec(session.prUrl);
                const prNumber = match ? parseInt(match[1], 10) : null;
                return prNumber != null ? (
                  <DiffViewer
                    prNumber={prNumber}
                    projectId={session.project_id}
                  />
                ) : (
                  <div className={styles.diffError}>
                    Could not parse PR number from URL.
                  </div>
                );
              })()}

            {activeTab === 'transcript' && isActive && (
              <Composer sessionId={session.sessionId} send={send} />
            )}
          </>
        )}
      </div>
      {showDecisionPanel && <DecisionPanel sessionId={session.sessionId} />}
    </div>
  );
}
