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
import styles from './SessionDetail.module.css';

// Re-export EventRow and groupSessionEvents for consumers (e.g. tests) that import
// them from this module.
export { EventRow, groupSessionEvents } from './EventTranscript';

// ── Props & component ─────────────────────────────────────────────

interface Props {
  session: SessionState | null;
  send: (msg: ClientMessage) => void;
  // onClose is kept in Props for API compatibility; close button calls history.back() directly
  onClose: () => void;
  setSessionArchived: (sessionId: string, archived: boolean) => void;
  setSessionFavorited: (sessionId: string, favorited: boolean) => void;
  onDeleted?: (sessionId: string) => void;
  onResume?: (sessionId: string) => void;
  sessionMode?: string;
  project?: ProjectConfig | null;
}

export function SessionDetail({
  session,
  send,
  setSessionArchived,
  setSessionFavorited,
  onDeleted,
  onResume,
  sessionMode,
  project = null,
}: Props) {
  const [showReviewTranscript, setShowReviewTranscript] = useState(false);
  const [activeTab, setActiveTab] = useState<'transcript' | 'diff'>(
    'transcript',
  );

  useEffect(() => {
    setActiveTab('transcript');
  }, [session?.sessionId]);

  if (!session) return null;

  const isActive =
    session.status === 'running' || session.status === 'needs_permission';

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.taskName}>
          {taskNameFromNotionUrl(session.taskName)}
        </span>
        <SessionControls
          session={session}
          send={send}
          sessionMode={sessionMode}
          project={project}
          setSessionArchived={setSessionArchived}
          setSessionFavorited={setSessionFavorited}
          onDeleted={onDeleted}
          onResume={onResume}
          onClose={() => window.history.back()}
        />
      </div>

      {session.sessionType === 'review' ? (
        <>
          <ReviewDetailView session={session} />

          <div className={styles.transcriptSection}>
            <div className={styles.transcriptHeader}>
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
  );
}
