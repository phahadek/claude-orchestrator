import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  insertSession,
  enqueueFeedbackItem,
  listUndeliveredInboxItems,
  markInboxItemsDelivered,
  listSessionsWithUndeliveredInboxItems,
} from '../db/queries.js';

function makeSession(sessionId: string, status: string): void {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: null,
    status: status as 'running',
    started_at: Date.now() - 60_000,
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    session_type: 'standard',
    task_name: null,
  });
}

beforeEach(() => {
  db.exec('DELETE FROM session_feedback_inbox');
  db.exec('DELETE FROM sessions');
});

describe('feedbackInbox queries', () => {
  it('listUndeliveredInboxItems returns items ordered by enqueued_at', () => {
    makeSession('sess-1', 'idle');
    // Enqueue with slight delay to distinguish timestamps
    enqueueFeedbackItem('sess-1', 'ai-reviewer', 'first message');
    enqueueFeedbackItem('sess-1', 'human:alice', 'second message');
    enqueueFeedbackItem('sess-1', 'ai-reviewer', 'third message');

    const items = listUndeliveredInboxItems('sess-1');
    expect(items).toHaveLength(3);
    // Ordered by enqueued_at ascending
    expect(items[0].payload).toBe('first message');
    expect(items[1].payload).toBe('second message');
    expect(items[2].payload).toBe('third message');
  });

  it('items from multiple sources are tagged with their source', () => {
    makeSession('sess-2', 'idle');
    enqueueFeedbackItem('sess-2', 'ai-reviewer', 'review verdict');
    enqueueFeedbackItem('sess-2', 'human:bob', 'human comment');

    const items = listUndeliveredInboxItems('sess-2');
    expect(items).toHaveLength(2);
    expect(items[0].source).toBe('ai-reviewer');
    expect(items[1].source).toBe('human:bob');
  });

  it('markInboxItemsDelivered stamps delivered_at and excludes items from subsequent list', () => {
    makeSession('sess-3', 'idle');
    enqueueFeedbackItem('sess-3', 'ai-reviewer', 'payload A');
    enqueueFeedbackItem('sess-3', 'ai-reviewer', 'payload B');

    const before = listUndeliveredInboxItems('sess-3');
    expect(before).toHaveLength(2);

    markInboxItemsDelivered([before[0].id]);

    const after = listUndeliveredInboxItems('sess-3');
    expect(after).toHaveLength(1);
    expect(after[0].payload).toBe('payload B');
  });

  it('already-delivered item is never re-delivered', () => {
    makeSession('sess-4', 'idle');
    enqueueFeedbackItem('sess-4', 'ai-reviewer', 'delivered payload');

    const [item] = listUndeliveredInboxItems('sess-4');
    markInboxItemsDelivered([item.id]);

    // Re-mark already-delivered item — no-op
    markInboxItemsDelivered([item.id]);

    const items = listUndeliveredInboxItems('sess-4');
    expect(items).toHaveLength(0);
  });

  it('markInboxItemsDelivered is a no-op for empty ids array', () => {
    expect(() => markInboxItemsDelivered([])).not.toThrow();
  });

  it('listSessionsWithUndeliveredInboxItems returns distinct session ids', () => {
    makeSession('sess-5', 'idle');
    makeSession('sess-6', 'idle');
    enqueueFeedbackItem('sess-5', 'ai-reviewer', 'p1');
    enqueueFeedbackItem('sess-5', 'ai-reviewer', 'p2');
    enqueueFeedbackItem('sess-6', 'human:alice', 'p3');

    const ids = listSessionsWithUndeliveredInboxItems();
    expect(ids).toContain('sess-5');
    expect(ids).toContain('sess-6');
    // Only listed once per session
    expect(ids.filter((id) => id === 'sess-5')).toHaveLength(1);
  });

  it('listSessionsWithUndeliveredInboxItems excludes sessions with all items delivered', () => {
    makeSession('sess-7', 'idle');
    enqueueFeedbackItem('sess-7', 'ai-reviewer', 'delivered');
    const [item] = listUndeliveredInboxItems('sess-7');
    markInboxItemsDelivered([item.id]);

    const ids = listSessionsWithUndeliveredInboxItems();
    expect(ids).not.toContain('sess-7');
  });
});

describe('inbox boot reconciliation', () => {
  it('undelivered items survive a simulated restart and are re-delivered', async () => {
    makeSession('sess-boot-1', 'idle');
    enqueueFeedbackItem('sess-boot-1', 'ai-reviewer', 'restart payload');

    // Simulate restart: undelivered item still exists
    const before = listUndeliveredInboxItems('sess-boot-1');
    expect(before).toHaveLength(1);
    expect(before[0].delivered_at).toBeNull();

    // Boot reconciliation: deliver all undelivered items for the session
    const deliveredMessages: Array<{ sessionId: string; text: string }> = [];
    const mockSendOrResume = vi.fn(
      async (sessionId: string, text: string): Promise<string | null> => {
        deliveredMessages.push({ sessionId, text });
        return sessionId;
      },
    );

    // Simulate reconcileInboxAtBoot logic inline (without full SessionManager)
    const sessionIds = listSessionsWithUndeliveredInboxItems();
    for (const sessionId of sessionIds) {
      const items = listUndeliveredInboxItems(sessionId);
      if (items.length === 0) continue;
      const combined = items
        .map((item) => `[${item.source}]\n${item.payload}`)
        .join('\n\n');
      markInboxItemsDelivered(items.map((i) => i.id));
      await mockSendOrResume(sessionId, combined);
    }

    // Item is now marked delivered
    const after = listUndeliveredInboxItems('sess-boot-1');
    expect(after).toHaveLength(0);

    // sendOrResume was called with the correct payload
    expect(deliveredMessages).toHaveLength(1);
    expect(deliveredMessages[0].sessionId).toBe('sess-boot-1');
    expect(deliveredMessages[0].text).toContain('[ai-reviewer]');
    expect(deliveredMessages[0].text).toContain('restart payload');
  });

  it('multiple sources coalesce into a single delivery in enqueued_at order', async () => {
    makeSession('sess-boot-2', 'idle');
    enqueueFeedbackItem('sess-boot-2', 'ai-reviewer', 'verdict text');
    enqueueFeedbackItem('sess-boot-2', 'human:alice', 'human feedback');

    const deliveredMessages: string[] = [];
    const mockSendOrResume = vi.fn(
      async (_sessionId: string, text: string): Promise<string | null> => {
        deliveredMessages.push(text);
        return _sessionId;
      },
    );

    const sessionIds = listSessionsWithUndeliveredInboxItems();
    for (const sessionId of sessionIds.filter((id) => id === 'sess-boot-2')) {
      const items = listUndeliveredInboxItems(sessionId);
      const combined = items
        .map((item) => `[${item.source}]\n${item.payload}`)
        .join('\n\n');
      markInboxItemsDelivered(items.map((i) => i.id));
      await mockSendOrResume(sessionId, combined);
    }

    expect(deliveredMessages).toHaveLength(1);
    const msg = deliveredMessages[0];
    // Both sources present, ai-reviewer first (enqueued first)
    expect(msg.indexOf('[ai-reviewer]')).toBeLessThan(
      msg.indexOf('[human:alice]'),
    );
    expect(msg).toContain('verdict text');
    expect(msg).toContain('human feedback');
  });
});

describe('turn-boundary delivery', () => {
  it('feedback arriving between turns coalesces into a single delivery', () => {
    makeSession('sess-turn-1', 'running');
    // Simulate two items enqueued during a turn
    enqueueFeedbackItem('sess-turn-1', 'ai-reviewer', 'first verdict');
    enqueueFeedbackItem('sess-turn-1', 'ai-reviewer', 'second verdict');

    // At turn boundary: list undelivered, combine, mark delivered
    const items = listUndeliveredInboxItems('sess-turn-1');
    expect(items).toHaveLength(2);

    const combined = items
      .map((item) => `[${item.source}]\n${item.payload}`)
      .join('\n\n');
    markInboxItemsDelivered(items.map((i) => i.id));

    // Exactly one combined delivery was made
    expect(combined).toContain('first verdict');
    expect(combined).toContain('second verdict');

    // No items remain undelivered
    expect(listUndeliveredInboxItems('sess-turn-1')).toHaveLength(0);
  });
});
