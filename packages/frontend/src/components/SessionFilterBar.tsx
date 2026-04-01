import { useEffect, useRef, useState } from 'react';
import styles from './SessionFilterBar.module.css';

const STATUS_OPTIONS: { label: string; value: string | null }[] = [
  { label: 'All', value: null },
  { label: 'Running', value: 'running' },
  { label: 'Idle', value: 'idle' },
  { label: 'Error', value: 'error' },
  { label: 'Killed', value: 'killed' },
  { label: 'Pending', value: 'pending' },
];

interface SessionFilterBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  statusFilter: string | null;
  onStatusChange: (status: string | null) => void;
  tagFilter: string | null;
  onTagChange: (tag: string | null) => void;
  availableTags: string[];
  resultCount: number;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

export function SessionFilterBar({
  searchText,
  onSearchChange,
  statusFilter,
  onStatusChange,
  tagFilter,
  onTagChange,
  availableTags,
  resultCount,
  searchInputRef,
}: SessionFilterBarProps) {
  const [inputValue, setInputValue] = useState(searchText);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const internalRef = useRef<HTMLInputElement | null>(null);
  const inputRef = searchInputRef ?? internalRef;

  // Sync external searchText changes (e.g. clear filters) back to local input
  useEffect(() => {
    setInputValue(searchText);
  }, [searchText]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setInputValue(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearchChange(val);
    }, 150);
  }

  return (
    <div className={styles.bar}>
      <input
        ref={inputRef}
        type="text"
        className={styles.searchInput}
        placeholder="Search sessions..."
        value={inputValue}
        onChange={handleInputChange}
      />

      <select
        className={styles.dropdown}
        value={statusFilter ?? ''}
        onChange={(e) => onStatusChange(e.target.value === '' ? null : e.target.value)}
      >
        {STATUS_OPTIONS.map((opt) => (
          <option key={opt.value ?? '__all'} value={opt.value ?? ''}>
            {opt.label}
          </option>
        ))}
      </select>

      <select
        className={styles.dropdown}
        value={tagFilter ?? ''}
        onChange={(e) => onTagChange(e.target.value === '' ? null : e.target.value)}
        disabled={availableTags.length === 0}
      >
        <option value="">{availableTags.length === 0 ? 'No tags yet' : 'All tags'}</option>
        {availableTags.map((tag) => (
          <option key={tag} value={tag}>{tag}</option>
        ))}
      </select>

      <span className={styles.resultCount}>
        {resultCount === 1 ? '1 session' : `${resultCount} sessions`}
      </span>
    </div>
  );
}
