import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StagedIntentPanel } from '../StagedIntentPanel';
import type { StagedIntent } from '../../api/stagedIntents';

function makeIntent(overrides: Partial<StagedIntent> = {}): StagedIntent {
  return {
    id: 'intent-1',
    kind: 'task.patchBodySection',
    payload: {},
    projectId: 'proj-1',
    createdAt: 0,
    ...overrides,
  };
}

describe('StagedIntentPanel — task.patchBodySection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an append proposal with its new content and target section', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          payload: {
            taskId: 'notion:abc',
            section: 'Context',
            operation: 'append',
            content: 'New context line.',
          },
        })}
      />,
    );

    const preview = screen.getByTestId('staged-intent-patch-body-section');
    expect(preview.textContent).toContain('Context');
    const append = screen.getByTestId('staged-intent-patch-append');
    expect(append.textContent).toContain('New context line.');
  });

  it('renders a replace proposal as a compact find → replaceWith diff', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          payload: {
            taskId: 'notion:abc',
            section: 'Summary',
            operation: 'replace',
            find: 'old text',
            replaceWith: 'new text',
          },
        })}
      />,
    );

    const replace = screen.getByTestId('staged-intent-patch-replace');
    expect(replace.textContent).toContain('old text');
    expect(replace.textContent).toContain('new text');
  });

  it('renders a remove proposal by fetching and showing the current section content being deleted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        markdown: '## Context\nExisting line one.\nExisting line two.\n',
      }),
    } as Response);

    render(
      <StagedIntentPanel
        intent={makeIntent({
          payload: {
            taskId: 'notion:abc',
            section: 'Context',
            operation: 'remove',
          },
        })}
      />,
    );

    const remove = screen.getByTestId('staged-intent-patch-remove');
    expect(remove.textContent).toMatch(/remove/i);

    await waitFor(() => {
      expect(remove.textContent).toContain('Existing line one.');
    });
    expect(remove.textContent).toContain('Existing line two.');
  });

  it('falls back gracefully for an unknown/unhandled patch operation instead of crashing', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          payload: {
            taskId: 'notion:abc',
            section: 'Context',
            operation: 'rewrite-everything',
          },
        })}
      />,
    );

    expect(screen.queryByTestId('staged-intent-patch-body-section')).toBeNull();
    expect(screen.getByText(/rewrite-everything/)).toBeTruthy();
  });
});
