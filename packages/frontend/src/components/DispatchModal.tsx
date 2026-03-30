import { useEffect, useState } from 'react';
import type { NotionTask } from '@claude-dashboard/backend/src/notion/types';

interface ProjectConfig {
  name: string;
  contextUrl: string;
  boardId: string;
}

interface DispatchModalProps {
  tasks: NotionTask[];
  onDispatch: (tasks: { taskUrl: string; projectContextUrl: string }[]) => void;
  onClose: () => void;
}

export default function DispatchModal({ tasks, onDispatch, onClose }: DispatchModalProps) {
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json() as Promise<ProjectConfig[]>)
      .then((projects) => {
        if (projects.length > 0) setProjectConfig(projects[0]);
      })
      .catch(() => setError('Failed to load project config'));
  }, []);

  function toggleTask(notionUrl: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(notionUrl)) next.delete(notionUrl);
      else next.add(notionUrl);
      return next;
    });
  }

  function handleDispatch() {
    if (!projectConfig) return;
    const payload = [...selected].map((taskUrl) => ({
      taskUrl,
      projectContextUrl: projectConfig.contextUrl,
    }));
    onDispatch(payload);
    onClose();
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Dispatch tasks">
      <h2>Dispatch Tasks</h2>
      {error && <p>{error}</p>}
      {!projectConfig && !error && <p>Loading project config…</p>}
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(task.notionUrl)}
                onChange={() => toggleTask(task.notionUrl)}
              />
              {task.title}
            </label>
          </li>
        ))}
      </ul>
      <button type="button" onClick={handleDispatch} disabled={selected.size === 0 || !projectConfig}>
        Dispatch
      </button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
