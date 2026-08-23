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

  it('collapses a single-line string over the character threshold', () => {
    const text = 'word '.repeat(180).trim(); // 900 chars, no newlines
    const { result } = renderHook(() => useCollapsibleText(text));
    expect(result.current.shouldCollapse).toBe(true);
    expect(result.current.collapseReason).toBe('chars');
  });

  it('does not collapse a single-line string under the character threshold', () => {
    const text = 'word '.repeat(40).trim(); // 200 chars, no newlines
    const { result } = renderHook(() => useCollapsibleText(text));
    expect(result.current.shouldCollapse).toBe(false);
    expect(result.current.displayText).toBe(text);
  });

  it('still collapses a 20-line string of short lines via the line-count trigger', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const { result } = renderHook(() => useCollapsibleText(text));
    expect(result.current.shouldCollapse).toBe(true);
    expect(result.current.collapseReason).toBe('lines');
  });

  it('truncates a character-triggered collapse at a word boundary', () => {
    const text = 'word '.repeat(180).trim(); // 900 chars, no newlines
    const { result } = renderHook(() => useCollapsibleText(text));
    expect(result.current.displayText.length).toBeLessThanOrEqual(600);
    expect(result.current.displayText.endsWith(' ')).toBe(false);
    expect(text.startsWith(result.current.displayText)).toBe(true);
    // truncation lands on a full word, not mid-word
    expect(result.current.displayText).toMatch(/^(word ?)*word$/);
  });

  it('does not claim a line count in the collapse reason when triggered by length', () => {
    const text = 'word '.repeat(180).trim();
    const { result } = renderHook(() => useCollapsibleText(text));
    expect(result.current.collapseReason).toBe('chars');
    expect(result.current.collapseReason).not.toBe('lines');
  });
});
