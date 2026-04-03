import styles from './TaskList.module.css';

interface Props {
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}

export function TaskList({ selectedTaskId: _selectedTaskId, onSelect: _onSelect }: Props) {
  return (
    <div className={styles.placeholder}>
      <p>Task list coming soon.</p>
    </div>
  );
}
