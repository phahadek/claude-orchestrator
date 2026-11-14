import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StagedIntentPanel } from '../StagedIntentPanel';
import type { AutoApproveVerdict, StagedIntent } from '../../api/stagedIntents';

const verdict: AutoApproveVerdict = {
  standard: 'code-auto-approve',
  outcome: 'ineligible',
  failed: [
    { id: 'size', value: { decision: 'no_split', loc: 1450, files: 3 } },
    {
      id: 'tripwire_clear',
      value: [{ class: 'deploy', term: 'deploy', where: 'deploy/deploy.sh' }],
    },
  ],
  status: null,
  error: null,
  at: 0,
  thresholds: { maxLoc: 1000, maxFiles: 40 },
};

function makeIntent(v: AutoApproveVerdict | null): StagedIntent {
  return {
    id: 'intent-1',
    kind: 'task.setStatus',
    payload: { taskId: 'notion:abc', status: 'Ready' },
    projectId: 'proj-1',
    createdAt: 0,
    autoApproveVerdict: v,
  };
}

describe('StagedIntentPanel — autoApproveVerdict', () => {
  it('renders the failed conditions with their values', () => {
    render(<StagedIntentPanel intent={makeIntent(verdict)} />);
    const el = screen.getByTestId('staged-intent-not-auto-approved');
    expect(el.textContent).toContain('Not auto-approved');
    expect(el.textContent).toContain('loc 1450 > 1000');
    expect(el.textContent).toContain('touches deploy/deploy.sh');
  });

  it('renders plain language for value-less conditions', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          ...verdict,
          failed: [
            { id: 'no_decision_pick_one', value: null },
            { id: 'readiness_and_gate', value: null },
          ],
        })}
      />,
    );
    const text = screen.getByTestId(
      'staged-intent-not-auto-approved',
    ).textContent;
    expect(text).toContain('the groom asked a decision question');
    expect(text).toContain('readiness or promotion gate not passing');
  });

  it('renders nothing when the verdict is null', () => {
    render(<StagedIntentPanel intent={makeIntent(null)} />);
    expect(screen.queryByTestId('staged-intent-not-auto-approved')).toBeNull();
  });
});
