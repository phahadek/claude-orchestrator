import styles from './TaskDetail.module.css';

interface Props {
  taskId: string | null;
  onClose: () => void;
}

export function TaskDetail({ taskId: _taskId, onClose: _onClose }: Props) {
  return (
    <div className={styles.placeholder}>
      <p>Task detail coming soon.</p>
    </div>
  );
}
