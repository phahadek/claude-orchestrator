import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DispatchModal from '../DispatchModal';
import type { NotionTask } from '@claude-dashboard/backend/src/notion/types';

const mockProjects = [
  { name: 'Test Project', contextUrl: 'https://notion.so/ctx', boardId: 'board-1' },
];

function makeTasks(): NotionTask[] {
  return [
    { id: '1', title: 'Task A', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: 'https://notion.so/task-a' },
    { id: '2', title: 'Task B', status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: 'https://notion.so/task-b' },
  ];
}

describe('DispatchModal', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: () => Promise.resolve(mockProjects),
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('fetches /api/config on mount', async () => {
    render(<DispatchModal tasks={makeTasks()} onDispatch={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/config');
    });
  });

  it('uses contextUrl from config, not a hardcoded env var', async () => {
    const onDispatch = vi.fn();
    render(<DispatchModal tasks={makeTasks()} onDispatch={onDispatch} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/config');
    });

    // Select a task and dispatch
    const checkbox = screen.getAllByRole('checkbox')[0];
    checkbox.click();
    screen.getByText('Dispatch').click();

    expect(onDispatch).toHaveBeenCalledWith([
      { taskUrl: 'https://notion.so/task-a', projectContextUrl: 'https://notion.so/ctx' },
    ]);
  });

  it('does not reference VITE_PROJECT_CONTEXT_URL or VITE_NOTION_BOARD_ID', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'DispatchModal.tsx'),
      'utf-8',
    );
    expect(source).not.toContain('VITE_PROJECT_CONTEXT_URL');
    expect(source).not.toContain('VITE_NOTION_BOARD_ID');
    expect(source).not.toContain('import.meta.env');
  });

  it('shows error message when config fetch fails', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network'));
    render(<DispatchModal tasks={makeTasks()} onDispatch={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load project config')).toBeDefined();
    });
  });
});
