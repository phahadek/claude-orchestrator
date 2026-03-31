import styles from './Notifications.module.css';

export interface NotificationItem {
  id: string;
  taskName: string;
  status: 'done' | 'error';
  prUrl?: string;
}

interface NotificationsProps {
  notifications: NotificationItem[];
  onDismiss: (id: string) => void;
}

export function Notifications({ notifications, onDismiss }: NotificationsProps) {
  if (notifications.length === 0) return null;

  return (
    <div className={styles.container}>
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`${styles.toast} ${n.status === 'error' ? styles.toastError : styles.toastDone}`}
          role="alert"
        >
          <div className={styles.body}>
            <span className={styles.taskName}>{n.taskName}</span>
            {n.status === 'done' && n.prUrl ? (
              <span className={styles.message}>
                PR opened —{' '}
                <a href={n.prUrl} target="_blank" rel="noreferrer" className={styles.prLink}>
                  view PR
                </a>
              </span>
            ) : n.status === 'done' ? (
              <span className={styles.message}>Session complete</span>
            ) : (
              <span className={styles.messageError}>Session errored</span>
            )}
          </div>
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => onDismiss(n.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
