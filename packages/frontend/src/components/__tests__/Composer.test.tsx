import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Composer } from '../Composer';

describe('Composer', () => {
  it('send button is disabled when draft is empty', () => {
    render(<Composer sessionId="sess-1" send={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('send button is disabled when draft is whitespace only', () => {
    render(<Composer sessionId="sess-1" send={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(btn.disabled).toBe(true);
  });

  it('send button is enabled when draft has content', () => {
    render(<Composer sessionId="sess-1" send={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    expect(btn.disabled).toBe(false);
  });

  it('sends on Enter and clears draft', () => {
    const send = vi.fn();
    render(<Composer sessionId="sess-1" send={send} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(send).toHaveBeenCalledWith({
      type: 'send_message',
      sessionId: 'sess-1',
      message: 'hello',
    });
    expect(textarea.value).toBe('');
  });

  it('does not send on Shift+Enter', () => {
    const send = vi.fn();
    render(<Composer sessionId="sess-1" send={send} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send when draft is empty on Enter', () => {
    const send = vi.fn();
    render(<Composer sessionId="sess-1" send={send} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends on button click', () => {
    const send = vi.fn();
    render(<Composer sessionId="sess-1" send={send} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(send).toHaveBeenCalledWith({
      type: 'send_message',
      sessionId: 'sess-1',
      message: 'hi',
    });
  });
});
