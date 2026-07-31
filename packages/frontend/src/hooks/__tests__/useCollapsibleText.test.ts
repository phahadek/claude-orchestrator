import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCollapsibleText } from '../useCollapsibleText';

describe('useCollapsibleText', () => {
  it('does not collapse text under the threshold', () => {
    const { result } = renderHook(() => useCollapsibleText('a short line', 5));
    expect(result.current.shouldCollapse).toBe(false);
    expect(result.current.displayText).toBe('a short line');
    expect(result.current.expanded).toBe(false);
  });

  it('collapses text exceeding the threshold by default', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const { result } = renderHook(() => useCollapsibleText(text, 5));
    expect(result.current.shouldCollapse).toBe(true);
    expect(result.current.expanded).toBe(false);
    expect(result.current.displayText).toBe(
      Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n'),
    );
  });

  it('toggle expands and re-collapses local state only', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const { result } = renderHook(() => useCollapsibleText(text, 5));

    act(() => result.current.toggle());
    expect(result.current.expanded).toBe(true);
    expect(result.current.displayText).toBe(text);

    act(() => result.current.toggle());
    expect(result.current.expanded).toBe(false);
  });

  it('treats null/undefined text as empty', () => {
    const { result } = renderHook(() => useCollapsibleText(undefined, 5));
    expect(result.current.shouldCollapse).toBe(false);
    expect(result.current.displayText).toBe('');
  });
});
