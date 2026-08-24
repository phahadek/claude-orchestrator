import { useEffect, useState, type ReactNode } from 'react';
import { authedFetch } from '../api/projects';
import { useGateVerifyFleet } from '../hooks/useGateVerifyFleet';
import styles from './FleetView.module.css';

const TICK_INTERVAL_MS = 1000;

interface SessionStartedEvent {
  taskId: string;
  sessionId: string;
}

interface SessionStatusEvent {
  sessionId: string;
  status: string;
}

interface SessionEndedEvent {
  taskId: string;
  sessionId: string;
  status: string;
  prUrl?: string;
}

interface StagedIntentChange {
  id: string;
}

interface Props {
  lastSessionStartedEvent?: SessionStartedEvent | null;
  lastSessionStatusEvent?: SessionStatusEvent | null;
  lastSessionEndedEvent?: SessionEndedEvent | null;
  lastStagedIntentChange?: StagedIntentChange | null;
}

/** A destination section — currently just gate-verify, built so a second in-flight surface can register alongside it later. */
interface FleetSection {
  key: string;
  title: string;
  liveCount: number;
  content: ReactNode;
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function FleetView({
  lastSessionStartedEvent,
  lastSessionStatusEvent,
  lastSessionEndedEvent,
  lastStagedIntentChange,
}: Props) {
  // Mirrors MilestoneView's invalidationKey composite — bumped by the
  // existing session_started/session_status/session_ended and
  // staged_intent_changed WS messages, no new WS message type.
  const invalidationKey = [
    lastSessionStartedEvent?.sessionId ?? '',
    lastSessionStatusEvent?.sessionId ?? '',
    lastSessionStatusEvent?.status ?? '',
    lastSessionEndedEvent?.sessionId ?? '',
    lastStagedIntentChange?.id ?? '',
  ].join(':');

  const { fleetState, loading, error } = useGateVerifyFleet(invalidationKey);

  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    authedFetch('/api/settings')
      .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
      .then((data) => {
        const raw = (data as { max_concurrent_verify_sessions?: string } | null)
          ?.max_concurrent_verify_sessions;
        if (raw == null) return;
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) setCap(parsed);
      })
      .catch(() => {
        /* cap display is best-effort; the live count still renders without it */
      });
  }, []);

  // `now` is read during render but only ever written from inside an
  // effect — Date.now() itself is never called in the render body, so
  // elapsed/remaining stay derived state instead of an impure render read.
  // Ticks every second so elapsed/remaining update locally, computed from
  // each session's startedAt + its fetched budget window — never re-fetched
  // on tick.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const sessions = fleetState?.sessions ?? [];
  const liveCount = fleetState?.liveCount ?? sessions.length;

  const sections: FleetSection[] = [
    {
      key: 'gate-verify',
      title: 'Gate Verify',
      liveCount,
      content:
        sessions.length === 0 ? (
          <p className={styles.emptyState}>
            No in-flight gate-verify sessions across any project.
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Project</th>
                <th>Milestone</th>
                <th>Gate item</th>
                <th>Elapsed</th>
                <th>Remaining</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                // budgetMs is derived from the fetched elapsed+remaining
                // (fixed at fetch time), so ticking never needs the
                // verifier's DEFAULT_BUDGET_MS constant duplicated here.
                const budgetMs = session.elapsedMs + session.remainingMs;
                const liveElapsedMs =
                  now != null ? now - session.startedAt : session.elapsedMs;
                const liveRemainingMs =
                  now != null
                    ? Math.max(0, budgetMs - liveElapsedMs)
                    : session.remainingMs;
                return (
                  <tr key={session.sessionId}>
                    <td>{session.project}</td>
                    <td>{session.milestone}</td>
                    <td>{session.text}</td>
                    <td>{formatMs(liveElapsedMs)}</td>
                    <td>{formatMs(liveRemainingMs)}</td>
                    <td>
                      {session.suspended ? (
                        <span className={styles.suspendedBadge}>Suspended</span>
                      ) : (
                        session.status
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ),
    },
  ];

  if (loading && !fleetState) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyState}>Loading fleet state…</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Fleet</h2>
        <span className={styles.liveCount} data-testid="fleet-live-count">
          {liveCount} live{cap != null ? ` / cap ${cap}` : ''}
        </span>
      </div>
      {error && (
        <div className={styles.errorBanner}>
          Failed to load fleet state: {error}
        </div>
      )}
      {sections.map((section) => (
        <section key={section.key} className={styles.section}>
          <h3 className={styles.sectionTitle}>{section.title}</h3>
          {section.content}
        </section>
      ))}
    </div>
  );
}
