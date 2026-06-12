import type { SessionState } from '../hooks/useSessionStore';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { SessionPanel } from './SessionPanel';

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
  if (!session) return null;
  return (
    <SessionPanel
      session={session}
      send={send}
      setSessionArchived={setSessionArchived}
      setSessionFavorited={setSessionFavorited}
      onDeleted={onDeleted}
      onResume={onResume}
      sessionMode={sessionMode}
      project={project}
      onClose={() => window.history.back()}
    />
  );
}
