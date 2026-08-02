import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  ALL_TOP_VIEWS,
  assertPanelKeyboardRegistryComplete,
  resolvePanelKeyboardDeclaration,
  nextRingId,
  useKeyboardRing,
  type PanelKeyboardRegistry,
} from '../panelKeyboard';

function emptyRegistry(): PanelKeyboardRegistry {
  const registry = {} as PanelKeyboardRegistry;
  for (const view of ALL_TOP_VIEWS) {
    registry[view] = null;
  }
  return registry;
}

describe('panelKeyboard contract', () => {
  it('resolves a declaration for every TopView member without throwing', () => {
    const registry = emptyRegistry();
    for (const view of ALL_TOP_VIEWS) {
      expect(() => resolvePanelKeyboardDeclaration(view, registry)).not.toThrow();
    }
  });

  it('assertPanelKeyboardRegistryComplete throws when a TopView is missing an entry', () => {
    const incomplete: Partial<PanelKeyboardRegistry> = emptyRegistry();
    delete incomplete.milestone;
    expect(() => assertPanelKeyboardRegistryComplete(incomplete)).toThrow(
      /milestone/,
    );
  });

  it('assertPanelKeyboardRegistryComplete accepts a fully-populated registry', () => {
    const registry = emptyRegistry();
    expect(() => assertPanelKeyboardRegistryComplete(registry)).not.toThrow();
  });

  describe('nextRingId', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    it('wraps forward past the end', () => {
      expect(nextRingId(items, 'c', 1)).toBe('a');
    });

    it('wraps backward past the start', () => {
      expect(nextRingId(items, 'a', -1)).toBe('c');
    });

    it('starts at the first item when nothing is highlighted', () => {
      expect(nextRingId(items, null, 1)).toBe('a');
    });

    it('returns null for an empty list', () => {
      expect(nextRingId([], 'a', 1)).toBeNull();
    });
  });

  describe('useKeyboardRing', () => {
    it('moves the highlight to the next remaining item when the highlighted item is removed', () => {
      const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      const { result, rerender } = renderHook(
        ({ items }) => useKeyboardRing(items),
        { initialProps: { items } },
      );

      act(() => {
        result.current.setHighlightedId('b');
      });
      expect(result.current.highlightedId).toBe('b');

      // 'b' is removed mid-navigation — the highlight should land on
      // whatever now sits at that same position ('c'), not jump back to
      // the array's start and not silently redirect onto 'a'.
      rerender({ items: [{ id: 'a' }, { id: 'c' }] });
      expect(result.current.highlightedId).toBe('c');
    });

    it('clears the highlight when the list becomes empty', () => {
      const items = [{ id: 'a' }];
      const { result, rerender } = renderHook(
        ({ items }) => useKeyboardRing(items),
        { initialProps: { items } },
      );

      act(() => {
        result.current.setHighlightedId('a');
      });
      rerender({ items: [] });
      expect(result.current.highlightedId).toBeNull();
    });
  });
});
