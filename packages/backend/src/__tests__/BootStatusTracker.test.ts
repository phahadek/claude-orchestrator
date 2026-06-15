import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BootStatusTracker } from '../bootSequence';
import type { ServerMessage } from '../ws/types';

function makeBroadcast() {
  const messages: ServerMessage[] = [];
  const broadcast = vi.fn((msg: ServerMessage) => {
    messages.push(msg);
  });
  return { broadcast, messages };
}

describe('BootStatusTracker', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('startSequence', () => {
    it('broadcasts boot_reconciliation_started with steps and started_at', () => {
      const { broadcast, messages } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      const steps = ['step_a', 'step_b'];
      tracker.startSequence(steps);

      expect(messages).toHaveLength(1);
      const msg = messages[0];
      expect(msg.type).toBe('boot_reconciliation_started');
      if (msg.type === 'boot_reconciliation_started') {
        expect(msg.steps).toEqual(steps);
        expect(typeof msg.started_at).toBe('string');
        expect(new Date(msg.started_at).getTime()).toBeGreaterThan(0);
      }
    });
  });

  describe('runStep', () => {
    it('broadcasts started then completed on success', async () => {
      const { broadcast, messages } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      tracker.startSequence(['my_step']);

      await tracker.runStep('my_step', async () => {});

      const stepMsgs = messages.filter((m) => m.type === 'boot_reconciliation_step');
      expect(stepMsgs).toHaveLength(2);
      expect(stepMsgs[0]).toMatchObject({ type: 'boot_reconciliation_step', step: 'my_step', status: 'started' });
      expect(stepMsgs[1]).toMatchObject({ type: 'boot_reconciliation_step', step: 'my_step', status: 'completed' });
      if (stepMsgs[1].type === 'boot_reconciliation_step') {
        expect(typeof stepMsgs[1].duration_ms).toBe('number');
      }
    });

    it('broadcasts started then failed on error (non-fatal)', async () => {
      const { broadcast, messages } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      tracker.startSequence(['my_step']);

      const err = new Error('something broke');
      await tracker.runStep('my_step', async () => { throw err; });

      const stepMsgs = messages.filter((m) => m.type === 'boot_reconciliation_step');
      expect(stepMsgs).toHaveLength(2);
      expect(stepMsgs[1]).toMatchObject({
        type: 'boot_reconciliation_step',
        step: 'my_step',
        status: 'failed',
        error: 'something broke',
      });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('calls process.exit(1) on failure when fatalOnError is true', async () => {
      const { broadcast } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      tracker.startSequence(['fatal_step']);

      const err = new Error('fatal');
      await expect(
        tracker.runStep('fatal_step', async () => { throw err; }, { fatalOnError: true }),
      ).rejects.toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('completeSequence', () => {
    it('broadcasts boot_reconciliation_completed with duration_ms and completed_at', async () => {
      const { broadcast, messages } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      tracker.startSequence(['a']);
      await tracker.runStep('a', async () => {});
      tracker.completeSequence();

      const completed = messages.find((m) => m.type === 'boot_reconciliation_completed');
      expect(completed).toBeDefined();
      if (completed?.type === 'boot_reconciliation_completed') {
        expect(typeof completed.duration_ms).toBe('number');
        expect(completed.duration_ms).toBeGreaterThanOrEqual(0);
        expect(typeof completed.completed_at).toBe('string');
      }
    });
  });

  describe('event ordering', () => {
    it('emits started → step(started) → step(completed) → completed in order', async () => {
      const { broadcast, messages } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      tracker.startSequence(['s1', 's2']);
      await tracker.runStep('s1', async () => {});
      await tracker.runStep('s2', async () => {});
      tracker.completeSequence();

      const types = messages.map((m) => {
        if (m.type === 'boot_reconciliation_step') return `step:${m.step}:${m.status}`;
        return m.type;
      });

      expect(types).toEqual([
        'boot_reconciliation_started',
        'step:s1:started',
        'step:s1:completed',
        'step:s2:started',
        'step:s2:completed',
        'boot_reconciliation_completed',
      ]);
    });
  });

  describe('getSnapshot', () => {
    it('returns null when idle', () => {
      const { broadcast } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      expect(tracker.getSnapshot()).toBeNull();
    });

    it('returns all emitted events while in_progress', async () => {
      const { broadcast, messages } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      tracker.startSequence(['step1']);
      await tracker.runStep('step1', async () => {});

      const snapshot = tracker.getSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot).toEqual(messages);
    });

    it('includes completed event in snapshot after completeSequence', async () => {
      const { broadcast } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      tracker.startSequence(['step1']);
      await tracker.runStep('step1', async () => {});
      tracker.completeSequence();

      const snapshot = tracker.getSnapshot();
      expect(snapshot).not.toBeNull();
      const lastMsg = snapshot![snapshot!.length - 1];
      expect(lastMsg.type).toBe('boot_reconciliation_completed');
    });

    it('returns a copy (mutations do not affect internal state)', () => {
      const { broadcast } = makeBroadcast();
      const tracker = new BootStatusTracker(broadcast);
      tracker.startSequence(['s1']);
      const snap1 = tracker.getSnapshot()!;
      snap1.push({ type: 'error', message: 'injected' });
      const snap2 = tracker.getSnapshot()!;
      expect(snap2).toHaveLength(1); // still only the started event
    });
  });
});

describe('sendInitialStateBurst — boot snapshot', () => {
  it('emits boot snapshot messages to the send callback when tracker has in-progress state', async () => {
    vi.resetModules();
    vi.mock('../db/queries', () => ({
      getActiveSessions: vi.fn().mockReturnValue([]),
      getEventsBySession: vi.fn().mockReturnValue([]),
      getDenialsBySession: vi.fn().mockReturnValue([]),
      getPRByNotionTaskId: vi.fn().mockReturnValue(null),
    }));
    vi.mock('../security/scrubSecrets', () => ({
      scrubSecrets: (s: string) => s,
    }));

    const { sendInitialStateBurst } = await import('../ws/initialStateBurst');

    const snapshotMsgs: ServerMessage[] = [
      {
        type: 'boot_reconciliation_started',
        steps: ['jsonl_import'],
        started_at: new Date().toISOString(),
      },
      {
        type: 'boot_reconciliation_step',
        step: 'jsonl_import',
        status: 'started',
      },
    ];

    const mockTracker = {
      getSnapshot: vi.fn().mockReturnValue(snapshotMsgs),
    };

    const sent: ServerMessage[] = [];
    sendInitialStateBurst((msg) => sent.push(msg), mockTracker);

    expect(mockTracker.getSnapshot).toHaveBeenCalled();
    expect(sent).toEqual(expect.arrayContaining(snapshotMsgs));
  });

  it('emits nothing for boot snapshot when tracker returns null', async () => {
    vi.resetModules();
    vi.mock('../db/queries', () => ({
      getActiveSessions: vi.fn().mockReturnValue([]),
      getEventsBySession: vi.fn().mockReturnValue([]),
      getDenialsBySession: vi.fn().mockReturnValue([]),
      getPRByNotionTaskId: vi.fn().mockReturnValue(null),
    }));
    vi.mock('../security/scrubSecrets', () => ({
      scrubSecrets: (s: string) => s,
    }));

    const { sendInitialStateBurst } = await import('../ws/initialStateBurst');

    const mockTracker = { getSnapshot: vi.fn().mockReturnValue(null) };

    const sent: ServerMessage[] = [];
    sendInitialStateBurst((msg) => sent.push(msg), mockTracker);

    expect(sent).toHaveLength(0);
  });
});
