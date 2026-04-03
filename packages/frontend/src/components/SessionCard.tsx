import type { SessionState } from '../hooks/useSessionStore';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { formatElapsed } from '../utils/sessionTimer';
import { summarizeEvent, isHiddenSystemEvent, tryParseJson } from '../utils/eventParsing';
import { formatTokenCount, formatCost, calculateCost } from '@claude-dashboard/backend/src/utils/usage';
import { StatusBadge } from './StatusBadge';
import styles from './SessionCard.module.css';

export const CARD_PREVIEW_LINES = 3;

interface Props {
  session: SessionState;
  selected: boolean;
  onClick: () => void;
  projectColor?: string;
  projectName?: string;
  onResume?: () => void;
  onToggleFavorite?: () => void;
  previewLines?: number;
  sessionMode?: string;
}

export function SessionCard({ session, selected, onClick, projectColor, projectName, onResume, onToggleFavorite, previewLines = CARD_PREVIEW_LINES, sessionMode }: Props) {
  const previewEvents = session.events
    .filter((e) => !(e.eventType === 'system' && isHiddenSystemEvent(tryParseJson(e.content))))
    .slice(-previewLines);
  const elapsed = formatElapsed(session);

  const isReview = session.sessionType === 'review';
  const isFavorited = session.favorited ?? false;
  const borderStyle = isFavorited
    ? { borderLeft: '3px solid #f9e2af' }
    : isReview
    ? undefined
    : projectColor
    ? { borderLeft: `3px solid ${projectColor}` }
    : undefined;

  return (
    <div
      className={`${styles['session-card']} ${selected ? styles.selected : ''} ${isReview ? styles.review : ''} ${isFavorited ? styles.favorited : ''}`}
      style={borderStyle}
      onClick={onClick}
    >
      <div className={styles['card-header']}>
        {session.taskType && (
          <span className={styles['type-icon']} title={session.taskType}>
            {taskTypeIcon(session.taskType)}
          </span>
        )}
        <span className={styles['task-name']}>{taskNameFromNotionUrl(session.taskName)}</span>
        <StatusBadge status={session.status} sessionType={session.sessionType} isRateLimited={session.isRateLimited} />
        {onToggleFavorite && (
          <button
            className={`${styles['favorite-btn']} ${isFavorited ? styles['favorite-btn--active'] : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
            aria-label={isFavorited ? 'Unfavorite session' : 'Favorite session'}
            title={isFavorited ? 'Unfavorite' : 'Favorite'}
          >
            {isFavorited ? '★' : '☆'}
          </button>
        )}
      </div>
      {projectName && (
        <div className={styles['project-tag']}>{projectName}</div>
      )}
      {session.status === 'needs_permission' && (
        <div className={styles['attention-badge']}>⚠️ Needs permission</div>
      )}
      {session.isRateLimited && (
        <div className={styles['rate-limited-row']}>
          <span className={styles['rate-limited-badge']}>⏸️ Rate limited — waiting for reset</span>
          {onResume && (
            <button
              className={styles['resume-button']}
              onClick={(e) => { e.stopPropagation(); onResume(); }}
            >
              Resume
            </button>
          )}
        </div>
      )}
      {session.status === 'retrying' && (
        <div className={styles['retrying-row']}>
          <span className={styles['retrying-badge']}>🔁 Retrying after transient API error…</span>
        </div>
      )}
      {isReview && session.prNumber != null && (
        <div className={styles['review-pr-tag']}>Review of #{session.prNumber}</div>
      )}
      {session.tags && session.tags.length > 0 && (
        <div className={styles['tag-pills']}>
          {session.tags.map((tag) => (
            <span key={tag} className={styles['tag-pill']}>{tag}</span>
          ))}
        </div>
      )}
      {previewEvents.length > 0 && (
        <div className={styles['last-event']}>
          {previewEvents.map((event, i) => (
            <div key={i} className={styles['preview-line']}>{summarizeEvent(event)}</div>
          ))}
        </div>
      )}
      <div className={styles['card-footer']}>
        <span className={styles.elapsed}>{elapsed}</span>
        {(session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0) > 0 && (
          <span
            className={styles['token-count']}
            title={`${formatTokenCount(session.totalInputTokens ?? 0)} input · ${formatTokenCount(session.totalOutputTokens ?? 0)} output`}
          >
            {sessionMode === 'api'
              ? formatCost(calculateCost(session.totalInputTokens ?? 0, session.totalOutputTokens ?? 0, session.model))
              : `${formatTokenCount((session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0))} tokens (~${formatCost(calculateCost(session.totalInputTokens ?? 0, session.totalOutputTokens ?? 0, session.model))} est.)`}
          </span>
        )}
        {session.model && (
          <span className={styles['model-badge']}>{formatModelName(session.model)}</span>
        )}
        <span className={styles['footer-right']}>
          {session.note && (
            <span className={styles['note-icon']} title={session.note}>📝</span>
          )}
          {session.prUrl && (
            <a href={session.prUrl} target="_blank" rel="noreferrer" className={styles['pr-link']}>
              PR ↗
            </a>
          )}
        </span>
      </div>
    </div>
  );
}

function taskTypeIcon(type: string): string {
  if (type.includes('💻')) return '💻';
  if (type.includes('📋')) return '📋';
  if (type.includes('🧪')) return '🧪';
  return '';
}

/** Strip the 'claude-' prefix for compact display, e.g. 'claude-sonnet-4-6' → 'sonnet-4-6'. */
export function formatModelName(model: string): string {
  return model.replace(/^claude-/, '');
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
