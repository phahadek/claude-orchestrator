import { describe, it, expect } from 'vitest';
import { CrashBudget } from '../crashBudget';

describe('CrashBudget', () => {
  it('backs off with an escalating cooldown and escalates after N consecutive events', () => {
    const budget = new CrashBudget({
      backoffScheduleMs: [10, 20, 30],
      escalateAfter: 3,
    });

    const first = budget.recordEvent('task-1');
    expect(first).toEqual({ count: 1, escalated: false, cooldownMs: 10 });
    expect(budget.inCooldown('task-1')).toBe(true);

    const second = budget.recordEvent('task-1');
    expect(second).toEqual({ count: 2, escalated: false, cooldownMs: 20 });

    const third = budget.recordEvent('task-1');
    expect(third).toEqual({ count: 3, escalated: true, cooldownMs: 30 });

    // Beyond the schedule's length, the last cooldown window repeats.
    const fourth = budget.recordEvent('task-1');
    expect(fourth).toEqual({ count: 4, escalated: true, cooldownMs: 30 });
  });

  it('counts a terminal-with-nothing-staged (planning_first_turn_empty) event as a backoff event like any other', () => {
    const budget = new CrashBudget({ escalateAfter: 2 });

    // The caller doesn't pass a reason — any recognized failure signal
    // (launch failure, crash, or the planning terminal-with-nothing-staged
    // backstop) is recorded the same way.
    const first = budget.recordEvent('task-planning-first-turn-empty');
    expect(first.escalated).toBe(false);
    expect(budget.inCooldown('task-planning-first-turn-empty')).toBe(true);

    const second = budget.recordEvent('task-planning-first-turn-empty');
    expect(second.escalated).toBe(true);
  });

  it('clear() resets the budget so a fresh event starts back at count 1', () => {
    const budget = new CrashBudget({ backoffScheduleMs: [10] });
    budget.recordEvent('task-2');
    budget.clear('task-2');
    expect(budget.inCooldown('task-2')).toBe(false);
    expect(budget.recordEvent('task-2').count).toBe(1);
  });

  it('tracks separate budgets per task id', () => {
    const budget = new CrashBudget({ backoffScheduleMs: [10_000] });
    budget.recordEvent('task-a');
    expect(budget.inCooldown('task-a')).toBe(true);
    expect(budget.inCooldown('task-b')).toBe(false);
  });
});
