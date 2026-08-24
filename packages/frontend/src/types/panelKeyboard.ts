import { useCallback, useEffect, useRef, useState } from 'react';
import type { TopView } from '../components/Header';

/** The minimal shape a ring-navigable item must carry — its stable identity. */
export interface PanelKeyboardItem {
  id: string;
}

/** One row of the panel's keyboard-shortcut hint list (e.g. shown in a ShortcutHint overlay). */
interface PanelKeyboardHint {
  key: string;
  description: string;
}

/**
 * The shared per-panel keyboard-declaration contract: whichever TopView is
 * active supplies (at most) one of these, and useKeyboardShortcuts reads
 * j/k/Enter from it instead of unconditionally targeting the session grid.
 * `onApprove`/`onOpenReject` are optional — a panel with no decision-card
 * ring (e.g. Tasks, PRs) has nothing to wire them to.
 */
export interface PanelKeyboardDeclaration<
  T extends PanelKeyboardItem = PanelKeyboardItem,
> {
  /** The ring's current ordered item list — read fresh on every keypress, never cached. */
  orderedItems: () => T[];
  onApprove?: (item: T) => void;
  onOpenReject?: (item: T) => void;
  hints: PanelKeyboardHint[];
}

export const ALL_TOP_VIEWS: readonly TopView[] = [
  'tasks',
  'sessions',
  'prs',
  'analytics',
  'gate',
  'architecture',
  'milestone',
  'settings',
  'tests',
  'fleet',
  'flow-health',
];

/** Every TopView must resolve to a declaration (or explicitly null, for views with no ring). */
export type PanelKeyboardRegistry = Record<
  TopView,
  PanelKeyboardDeclaration | null
>;

/**
 * Resolves the active declaration for `view`. The switch's `default` arm is
 * typed `never` — adding a TopView member without a matching case (and thus
 * without a registry entry) fails to compile.
 */
export function resolvePanelKeyboardDeclaration(
  view: TopView,
  registry: PanelKeyboardRegistry,
): PanelKeyboardDeclaration | null {
  switch (view) {
    case 'tasks':
    case 'sessions':
    case 'prs':
    case 'analytics':
    case 'gate':
    case 'architecture':
    case 'milestone':
    case 'settings':
    case 'tests':
    case 'fleet':
    case 'flow-health':
      return registry[view];
    default: {
      const exhaustive: never = view;
      throw new Error(
        `No panel keyboard declaration for view: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Runtime companion to the compile-time exhaustiveness check above — asserts
 * every TopView member has an entry (even if that entry is explicitly null)
 * so a registry built up piecemeal (e.g. via object spread) can't silently
 * drop a view.
 */
export function assertPanelKeyboardRegistryComplete(
  registry: Partial<PanelKeyboardRegistry>,
): asserts registry is PanelKeyboardRegistry {
  for (const view of ALL_TOP_VIEWS) {
    if (!(view in registry)) {
      throw new Error(`Missing panel keyboard declaration for view: ${view}`);
    }
  }
}

/** The next id in `items` after `currentId`, wrapping around; `direction` 1 = next, -1 = prev. */
export function nextRingId<T extends PanelKeyboardItem>(
  items: T[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (items.length === 0) return null;
  const idx = currentId ? items.findIndex((i) => i.id === currentId) : -1;
  if (idx === -1) {
    return direction === 1 ? items[0].id : items[items.length - 1].id;
  }
  const nextIdx = (idx + direction + items.length) % items.length;
  return items[nextIdx].id;
}

/**
 * Id-anchored ring highlight: tracks `highlightedId` against a live
 * `items` list. When the currently-highlighted item is removed from the
 * list (e.g. approved/rejected out from under the ring), the highlight
 * jumps to whatever now sits at that same position — never silently
 * redirecting an approve/reject onto an unrelated item by falling back to
 * an array index.
 */
export function useKeyboardRing<T extends PanelKeyboardItem>(items: T[]) {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const prevItemsRef = useRef<T[]>(items);

  useEffect(() => {
    const prevItems = prevItemsRef.current;
    if (highlightedId && !items.some((i) => i.id === highlightedId)) {
      if (items.length === 0) {
        setHighlightedId(null);
      } else {
        const prevIndex = prevItems.findIndex((i) => i.id === highlightedId);
        const clamped = Math.min(Math.max(prevIndex, 0), items.length - 1);
        setHighlightedId(items[clamped].id);
      }
    }
    prevItemsRef.current = items;
  }, [items, highlightedId]);

  const selectNext = useCallback(() => {
    setHighlightedId((id) => nextRingId(items, id, 1));
  }, [items]);
  const selectPrev = useCallback(() => {
    setHighlightedId((id) => nextRingId(items, id, -1));
  }, [items]);

  return { highlightedId, setHighlightedId, selectNext, selectPrev };
}

/**
 * Local keydown response for a single ring-highlighted card: 'a' fires
 * approve, 'r' moves focus into the reason field — both no-ops while the
 * card isn't the ring's current highlight, and both ignored while a
 * different input/textarea already has focus (consistent with
 * useKeyboardShortcuts' global input guard).
 */
export function useHighlightedCardKeyboardActions({
  highlighted,
  onApprove,
  onFocusReject,
}: {
  highlighted: boolean;
  onApprove?: () => void;
  onFocusReject?: () => void;
}): void {
  const onApproveRef = useRef(onApprove);
  const onFocusRejectRef = useRef(onFocusReject);
  useEffect(() => {
    onApproveRef.current = onApprove;
    onFocusRejectRef.current = onFocusReject;
  });

  useEffect(() => {
    if (!highlighted) return;

    function onKeyDown(event: KeyboardEvent) {
      const isInputField =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable);
      if (isInputField) return;

      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        onApproveRef.current?.();
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        onFocusRejectRef.current?.();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [highlighted]);
}
