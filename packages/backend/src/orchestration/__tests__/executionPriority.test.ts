import { describe, it, expect } from 'vitest';
import {
  computeExecutionRanks,
  compareExecutionRank,
  countEffectiveUrgent,
  executionSortKey,
  type RankInputTask,
  type RankInputFlags,
  type AssignedPriority,
} from '../executionPriority';

const T = (
  id: string,
  dependsOn: string[] = [],
  status = '🔲 Ready',
  priority: AssignedPriority = null,
): RankInputTask => ({ id, status, dependsOn, priority });

const flags = (o: Record<string, Partial<RankInputFlags>>) =>
  new Map(
    Object.entries(o).map(([k, v]) => [
      k,
      { urgent: false, executeNowReason: null, executeNowSetAt: null, ...v },
    ]),
  );

describe('computeExecutionRanks', () => {
  it('propagates urgency to unfinished ancestors and drops Done', () => {
    const f = flags({ C: { urgent: true } });
    const r = computeExecutionRanks([T('A'), T('B', ['A']), T('C', ['B'])], f);
    expect(r.get('A')!.urgentInherited).toBe(true);
    expect(r.get('A')!.urgentVia).toContain('C');
    expect(r.get('B')!.urgentInherited).toBe(true);
    expect(r.get('C')!.urgent).toBe(true);
    const r2 = computeExecutionRanks(
      [T('A', [], '✅ Done'), T('B', ['A']), T('C', ['B'])],
      f,
    );
    expect(r2.get('A')!.group).not.toBe('urgent');
    expect(r2.get('A')!.urgentInherited).toBe(false);
  });

  it('counts transitive unfinished dependents; Deferred counts, Done does not', () => {
    const r = computeExecutionRanks(
      [
        T('A'),
        T('B', ['A']),
        T('C', ['A']),
        T('D', ['B']),
        T('E', ['A'], '✅ Done'),
        T('F', ['C'], '⏭️ Deferred'),
      ],
      new Map(),
    );
    expect(r.get('A')!.blocksCount).toBe(4);
    expect(r.get('B')!.blocksCount).toBe(1);
  });

  it('ignores edges to absent ids', () => {
    const r = computeExecutionRanks([T('A', ['X'])], new Map());
    expect(r.get('A')!.blocksCount).toBe(0);
    expect(r.get('X')).toBeUndefined();
  });

  it('terminates on cycles with finite counts', () => {
    const r = computeExecutionRanks(
      [T('A', ['B']), T('B', ['A'])],
      flags({ A: { urgent: true } }),
    );
    expect(r.get('A')!.blocksCount).toBe(1);
    expect(r.get('B')!.blocksCount).toBe(1);
    expect(r.get('B')!.urgentInherited).toBe(true);
  });

  it('group precedence ignores assigned Priority', () => {
    const r = computeExecutionRanks(
      [
        T('N', [], '🔲 Ready', 'low'),
        T('U', [], '🔲 Ready', 'low'),
        T('K', [], '🔲 Ready', 'low'),
        T('P', [], '🔲 Ready', 'high'),
        T('D', ['K']),
      ],
      flags({
        N: { executeNowReason: 'whatever', executeNowSetAt: 1 },
        U: { urgent: true },
      }),
    );
    const g = (id: string) => r.get(id)!.group;
    expect([g('N'), g('U'), g('K'), g('P')]).toEqual([
      'execute_now',
      'urgent',
      'blocker',
      'priority',
    ]);
  });
});

describe('compareExecutionRank', () => {
  const sorted = (
    ts: RankInputTask[],
    f: ReturnType<typeof flags>,
    tb?: (id: string) => (number | string)[],
  ) => {
    const r = computeExecutionRanks(ts, f);
    return [...r.entries()]
      .map(([id, rank]) => ({ id, ...rank, tieBreak: tb ? tb(id) : [id] }))
      .sort(compareExecutionRank)
      .map((x) => x.id);
  };

  it('orders execute_now by setAt ascending', () => {
    expect(
      sorted(
        [T('a'), T('b')],
        flags({
          a: { executeNowReason: 'x', executeNowSetAt: 20 },
          b: { executeNowReason: 'y', executeNowSetAt: 10 },
        }),
      ),
    ).toEqual(['b', 'a']);
  });

  it('urgent: direct before inherited regardless of priority, then priority', () => {
    expect(
      sorted(
        [
          T('dep', [], '🔲 Ready', 'high'),
          T('top', ['dep'], '🔲 Ready', 'low'),
          T('top2', [], '🔲 Ready', 'medium'),
        ],
        flags({ top: { urgent: true }, top2: { urgent: true } }),
      ),
    ).toEqual(['top2', 'top', 'dep']);
  });

  it('blocker: blocksCount desc then priority; priority group high>medium>low>null', () => {
    expect(
      sorted(
        [
          T('a', [], '🔲 Ready', 'high'),
          T('b', [], '🔲 Ready', 'low'),
          T('c', ['b']),
          T('d', ['b']),
          T('e', ['a']),
        ],
        new Map(),
      ).slice(0, 2),
    ).toEqual(['b', 'a']);
    expect(
      sorted(
        [
          T('n'),
          T('l', [], '🔲 Ready', 'low'),
          T('m', [], '🔲 Ready', 'medium'),
          T('h', [], '🔲 Ready', 'high'),
        ],
        new Map(),
      ),
    ).toEqual(['h', 'm', 'l', 'n']);
  });

  it('falls back to tieBreak and is stable under shuffling', () => {
    const ts = [T('a'), T('b'), T('c')];
    const tb = (id: string) =>
      id === 'b' ? [5, id] : id === 'a' ? [Infinity, id] : [Infinity, id];
    const expected = ['b', 'a', 'c'];
    expect(sorted(ts, new Map(), tb)).toEqual(expected);
    expect(sorted([...ts].reverse(), new Map(), tb)).toEqual(expected);
  });
});

describe('countEffectiveUrgent', () => {
  it('counts direct and effective', () => {
    const r = computeExecutionRanks(
      [T('A'), T('B', ['A']), T('C', ['B'])],
      flags({ C: { urgent: true } }),
    );
    expect(countEffectiveUrgent(r.values())).toEqual({
      direct: 1,
      effective: 3,
    });
  });
});

describe('executionSortKey', () => {
  it('sorts a mixed board like compareExecutionRank + AutoLauncher tie-break, after a JSON round-trip', () => {
    const tasks: RankInputTask[] = [
      T('A1', [], '🔲 Ready', 'low'),
      T('A2', [], '🔲 Ready', 'high'),
      T('A3', [], '🔲 Ready', 'medium'),
      T('A4', [], '🔲 Ready', null),
      T('A5', [], '🔲 Ready', 'high'),
      T('B1'),
      T('B2', ['B1']),
      T('B3', ['B1']),
      T('C1'),
      T('C2', ['C1']),
      T('D1', ['C1']),
      T('D2'),
      T('E1'),
      T('E2'),
    ];
    const f = flags({
      E1: { executeNowReason: 'x', executeNowSetAt: 2000 },
      E2: { executeNowReason: 'y', executeNowSetAt: null },
      D2: { urgent: true },
      D1: { urgent: true },
    });
    const ranks = computeExecutionRanks(tasks, f);
    const createdAt = new Map<string, number | undefined>([
      ['A4', 5],
      ['A5', undefined],
      ['A2', 10],
    ]);
    const entries = tasks.map((t) => {
      const rank = ranks.get(t.id)!;
      return {
        id: t.id,
        rank,
        tieBreak: [createdAt.get(t.id) ?? Infinity, t.id] as Array<
          number | string
        >,
        key: JSON.parse(
          JSON.stringify(executionSortKey(rank, createdAt.get(t.id), t.id)),
        ) as (number | string)[],
      };
    });
    const byRank = [...entries]
      .sort((a, b) =>
        compareExecutionRank(
          { ...a.rank, tieBreak: a.tieBreak },
          { ...b.rank, tieBreak: b.tieBreak },
        ),
      )
      .map((e) => e.id);
    const cmp = (a: (number | string)[], b: (number | string)[]) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        return a[i] < b[i] ? -1 : 1;
      }
      return a.length - b.length;
    };
    const byKey = [...entries]
      .sort((a, b) => cmp(a.key, b.key))
      .map((e) => e.id);
    expect(byKey).toEqual(byRank);
    expect(entries.every((e) => e.key.every((k) => k !== null))).toBe(true);
  });
});
