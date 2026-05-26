import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionEventLog } from '../PermissionEventLog';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDenial(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    session_id: 'sess-abc123',
    tool_name: 'Bash',
    tool_use_id: 'tu-1',
    tool_input: JSON.stringify({ command: 'ls -la' }),
    timestamp: Date.now() - 5000,
    task_url: null,
    ...overrides,
  };
}

describe('PermissionEventLog', () => {
  it('renders the table with Time / Session / Tool / Input column headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeDenial()]));
    render(<PermissionEventLog />);
    await waitFor(() => expect(screen.getByText('Bash')).toBeTruthy());
    expect(screen.getByText('Time')).toBeTruthy();
    expect(screen.getByText('Session')).toBeTruthy();
    expect(screen.getByText('Tool')).toBeTruthy();
    expect(screen.getByText('Input')).toBeTruthy();
  });

  it('shows empty status when there are no denials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    render(<PermissionEventLog />);
    await waitFor(() =>
      expect(
        screen.getByText(/No permission denials recorded yet/),
      ).toBeTruthy(),
    );
  });

  it('renders a row per denial with session and tool name', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([makeDenial({ session_id: 'abc12345', tool_name: 'Read' })]),
    );
    render(<PermissionEventLog />);
    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());
    expect(screen.getByText('abc12345')).toBeTruthy();
  });

  it('mobileInput span contains the full (untruncated) input text', async () => {
    const longCmd = 'cd ../../ && rm -rf /important/data && echo done';
    const toolInput = JSON.stringify({ command: longCmd });
    fetchMock.mockResolvedValueOnce(
      jsonResponse([makeDenial({ tool_input: toolInput })]),
    );
    const { container } = render(<PermissionEventLog />);
    await waitFor(() => expect(screen.getByText('Bash')).toBeTruthy());

    // The mobileInput span should contain the formatted JSON with the full command
    const mobileInputs = container.querySelectorAll('[class*="mobileInput"]');
    expect(mobileInputs.length).toBeGreaterThan(0);
    const mobileText = mobileInputs[0].textContent ?? '';
    expect(mobileText).toContain(longCmd);
  });

  it('Copy button calls navigator.clipboard.writeText', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse([makeDenial()]));
    render(<PermissionEventLog />);
    await waitFor(() => expect(screen.getByText('Bash')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledOnce());
  });

  it('Clear button shows confirmation modal then calls DELETE', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([makeDenial()]))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    render(<PermissionEventLog />);
    await waitFor(() => expect(screen.getByText('Bash')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText(/Clear 1 denial/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall?.[0]).toBe('/api/permission-denials');
    });
  });

  it('uses notion task name as session label when task_url is set', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        makeDenial({
          task_url:
            'https://www.notion.so/Fix-the-login-bug-abc123def456',
        }),
      ]),
    );
    render(<PermissionEventLog />);
    await waitFor(() => expect(screen.getByText('Bash')).toBeTruthy());
    // Session cell should show a task-name derived from the notion URL, not the raw session_id
    expect(screen.queryByText('sess-abc123')).toBeNull();
  });
});
