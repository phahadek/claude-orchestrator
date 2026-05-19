import { useEffect, useRef } from 'react';
import type { SessionState } from './useSessionStore';

const NOTIFICATIONS_ENABLED_KEY = 'notificationsEnabled';
const PERMISSION_REQUESTED_KEY = 'notificationPermissionRequested';

function isNotificationsEnabled(): boolean {
  return localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== 'false';
}

function requestPermissionOnce(): void {
  if (typeof Notification === 'undefined') return;
  if (localStorage.getItem(PERMISSION_REQUESTED_KEY)) return;
  localStorage.setItem(PERMISSION_REQUESTED_KEY, 'true');
  void Notification.requestPermission().then((permission) => {
    // Default notificationsEnabled to true when permission is granted
    if (permission === 'granted' && localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) === null) {
      localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, 'true');
    }
  });
}

function fireNotification(title: string, body: string, onClick?: () => void): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (!isNotificationsEnabled()) return;
  if (document.visibilityState === 'visible') return;

  const n = new Notification(title, { body, icon: '/favicon.ico' });
  if (onClick) {
    n.onclick = onClick;
  }
}

interface SessionSnapshot {
  status: string;
  pendingPermissionKey: string | null;
}

export function useNotifications(sessions: SessionState[], prReviewEvent?: { prNumber: number; verdict: string; summary: string; replay?: boolean } | null): void {
  const prevRef = useRef<Map<string, SessionSnapshot>>(new Map());
  const initialSyncDoneRef = useRef(false);
  const prevReviewEventRef = useRef<typeof prReviewEvent>(null);

  useEffect(() => {
    requestPermissionOnce();
  }, []);

  useEffect(() => {
    // First non-empty render = WebSocket initial sync. Snapshot existing sessions
    // into prevRef without firing notifications so we don't toast every active
    // done/error session on every dashboard load.
    if (!initialSyncDoneRef.current && sessions.length > 0) {
      const initial = new Map<string, SessionSnapshot>();
      for (const session of sessions) {
        const pendingPermissionKey = session.pendingPermission
          ? `${session.pendingPermission.toolName}:${session.pendingPermission.proposedAction}`
          : null;
        initial.set(session.sessionId, { status: session.status, pendingPermissionKey });
      }
      prevRef.current = initial;
      initialSyncDoneRef.current = true;
      return;
    }

    const prev = prevRef.current;
    const next = new Map<string, SessionSnapshot>();

    for (const session of sessions) {
      const { sessionId, taskName, status, pendingPermission, lastStatusReplay } = session;
      const pendingPermissionKey = pendingPermission
        ? `${pendingPermission.toolName}:${pendingPermission.proposedAction}`
        : null;

      next.set(sessionId, { status, pendingPermissionKey });

      const prevSnap = prev.get(sessionId);

      // Suppress notifications for transitions whose latest session_status
      // carried replay: true (sent during the WS reconnect burst). The
      // snapshot still advances via next.set above so a later non-replay
      // transition notifies correctly.
      if (!lastStatusReplay) {
        if (status === 'done' && prevSnap?.status !== 'done') {
          fireNotification('✅ Session done', `${taskName} finished successfully.`);
        } else if (status === 'error' && prevSnap?.status !== 'error') {
          fireNotification('❌ Session failed', `${taskName} encountered an error.`);
        }
      }

      if (
        pendingPermissionKey &&
        pendingPermissionKey !== prevSnap?.pendingPermissionKey
      ) {
        const toolName = pendingPermission!.toolName;
        fireNotification(
          '🔔 Approval needed',
          `${toolName} requested in ${taskName}. Click to review.`,
          () => {
            window.focus();
            window.dispatchEvent(new CustomEvent('selectSession', { detail: { sessionId } }));
          },
        );
      }
    }

    prevRef.current = next;
  }, [sessions]);

  useEffect(() => {
    if (!prReviewEvent) return;
    if (prevReviewEventRef.current === prReviewEvent) return;
    prevReviewEventRef.current = prReviewEvent;

    // Replayed pr_review_complete from the WS reconnect burst — advance the
    // ref so subsequent live events still fire, but skip the notification.
    if (prReviewEvent.replay) return;

    const { prNumber, verdict, summary } = prReviewEvent;
    let title: string;
    let body: string;
    if (verdict === 'approved') {
      title = '✅ PR approved';
      body = `PR #${prNumber} approved`;
    } else if (verdict === 'needs_changes') {
      title = '⚠️ PR needs changes';
      body = `PR #${prNumber}: ${summary.slice(0, 80)}`;
    } else if (verdict === 'incomplete') {
      title = '❌ PR incomplete';
      body = `PR #${prNumber}: ${summary}`;
    } else {
      title = '⏰ Review failed';
      body = `Review failed for PR #${prNumber}`;
    }

    fireNotification(title, body, () => {
      window.focus();
      window.dispatchEvent(new CustomEvent('navigateToPRs'));
    });
  }, [prReviewEvent]);
}
