import { describe, it, expect } from 'vitest';
import { deriveDeployStepStates } from '../deployStepState';
import type { DeployPlanStep, DeployRunEvent } from '../../api/deploy';

function makeEvent(overrides: Partial<DeployRunEvent>): DeployRunEvent {
  return {
    id: 1,
    run_id: 'run-1',
    step: 'fetch',
    event_type: 'step_started',
    disposition: null,
    detail: null,
    at: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('deriveDeployStepStates', () => {
  it('maps a step with no events to pending', () => {
    const plan: DeployPlanStep[] = [{ id: 'fetch', description: null }];
    const result = deriveDeployStepStates(plan, []);
    expect(result).toEqual([
      { id: 'fetch', description: null, state: 'pending', failureDetail: null },
    ]);
  });

  it('maps step_succeeded to succeeded', () => {
    const plan: DeployPlanStep[] = [{ id: 'fetch', description: null }];
    const events = [
      makeEvent({ id: 1, event_type: 'step_started' }),
      makeEvent({ id: 2, event_type: 'step_succeeded' }),
    ];
    const [cell] = deriveDeployStepStates(plan, events);
    expect(cell.state).toBe('succeeded');
  });

  it('maps step_started with no terminal event to running', () => {
    const plan: DeployPlanStep[] = [{ id: 'fetch', description: null }];
    const events = [makeEvent({ id: 1, event_type: 'step_started' })];
    const [cell] = deriveDeployStepStates(plan, events);
    expect(cell.state).toBe('running');
  });

  it('maps confirm_gate with no terminal event to awaiting-confirm', () => {
    const plan: DeployPlanStep[] = [{ id: 'confirm', description: null }];
    const events = [
      makeEvent({ id: 1, step: 'confirm', event_type: 'confirm_gate' }),
    ];
    const [cell] = deriveDeployStepStates(plan, events);
    expect(cell.state).toBe('awaiting-confirm');
  });

  it('maps step_failed to failed and carries its detail', () => {
    const plan: DeployPlanStep[] = [{ id: 'provision', description: null }];
    const events = [
      makeEvent({ id: 1, step: 'provision', event_type: 'step_started' }),
      makeEvent({
        id: 2,
        step: 'provision',
        event_type: 'step_failed',
        detail: 'sudo: unknown user deploy',
      }),
    ];
    const [cell] = deriveDeployStepStates(plan, events);
    expect(cell.state).toBe('failed');
    expect(cell.failureDetail).toBe('sudo: unknown user deploy');
  });

  it('renders one pending cell per plan entry given an empty event list', () => {
    const plan: DeployPlanStep[] = Array.from({ length: 10 }, (_, i) => ({
      id: `step-${i}`,
      description: null,
    }));
    const result = deriveDeployStepStates(plan, []);
    expect(result).toHaveLength(10);
    expect(result.every((cell) => cell.state === 'pending')).toBe(true);
  });
});
