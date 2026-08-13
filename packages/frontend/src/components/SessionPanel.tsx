import { useState, useEffect } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { ReviewDetailView } from './ReviewDetailView';
import { EventTranscript } from './EventTranscript';
import { DiffViewer } from './DiffViewer';
import { SessionControls } from './SessionControls';
import { Composer } from './Composer';
import { DecisionPanel } from './DecisionPanel';
import { useTestLaneRunStatus } from '../hooks/useTestLaneRunStatus';
import styles from './SessionDetail.module.css';

const TEST_LANE_OUTCOME_LABELS = {
  'in-flight': '🧪 Governed test run in progress',
  passed: '🧪 Governed test run passed',
  failed: '🧪 Governed test run failed',
  blocked: '🧪 Governed test run blocked',
} as const;

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
}: Props) {
  const [showReviewTranscript, setShowReviewTranscript] = useState(false);
  const [activeTab, setActiveTab] = useState<'transcript' | 'diff'>(
    'transcript',
  );

  useEffect(() => {
    setActiveTab('transcript');
  }, [session.sessionId]);

  const testLaneStatus = useTestLaneRunStatus({
    projectId: session.project_id ?? null,
    sessionId: session.sessionId,
  });

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

        {session.sessionType === 'review' ? (
          <>
            <ReviewDetailView session={session} />

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
      {testLaneStatus && (
        <div
          className={styles.testLaneDetail}
          data-testid="test-lane-detail"
          data-test-lane-outcome={testLaneStatus.outcome}
        >
          <span className={styles.testLaneOutcome}>
            {TEST_LANE_OUTCOME_LABELS[testLaneStatus.outcome]}
          </span>
          {testLaneStatus.outcome === 'failed' && testLaneStatus.output && (
            <pre className={styles.testLaneOutput}>{testLaneStatus.output}</pre>
          )}
          {testLaneStatus.note && (
            <span className={styles.testLaneNote} data-testid="test-lane-note">
              {testLaneStatus.note}
            </span>
          )}
        </div>
      )}
      {showDecisionPanel && <DecisionPanel sessionId={session.sessionId} />}
    </div>
  );
}
