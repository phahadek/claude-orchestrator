import { useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';

interface FlakyTest {
  testId: string;
  name: string;
  sampleCount: number;
  transitionCount: number;
  remediationTaskOpen: boolean;
}

interface Props {
  projectId: string;
  onSelectTest: (testId: string) => void;
}

export function FlakiestTestsPanel({ projectId, onSelectTest }: Props) {
  const [tests, setTests] = useState<FlakyTest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTests(null);
    setError(null);
    let cancelled = false;
    apiRequest<{ tests: FlakyTest[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tests/flakiest`,
    )
      .then((res) => {
        if (!cancelled) setTests(res.tests);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Network error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const sorted = tests
    ? [...tests].sort((a, b) => b.transitionCount - a.transitionCount)
    : null;

  return (
    <section data-testid="flakiest-tests-panel">
      <h4>Flakiest tests</h4>
      {error && <div>Failed to load flaky tests: {error}</div>}
      {!error && !sorted && <p>Loading…</p>}
      {sorted && sorted.length === 0 && <p>No flaky tests flagged.</p>}
      {sorted?.map((t) => (
        <div
          key={t.testId}
          role="button"
          tabIndex={0}
          style={{ cursor: 'pointer' }}
          data-testid={`flaky-row-${t.testId}`}
          onClick={() => onSelectTest(t.testId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSelectTest(t.testId);
          }}
        >
          {t.name} — {t.transitionCount} flips / {t.sampleCount} samples
          {t.remediationTaskOpen && ' (remediation open)'}
        </div>
      ))}
    </section>
  );
}
