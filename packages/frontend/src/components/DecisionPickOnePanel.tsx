import { useState } from 'react';
import type {
  StagedIntent,
  DecisionPickOnePayload,
} from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import styles from './StagedIntentPanel.module.css';
import pickOneStyles from './DecisionPickOnePanel.module.css';

interface Props {
  intent: StagedIntent;
  onAnswered?: (intent: StagedIntent, result: StagedIntent) => void;
  onDismiss?: (intent: StagedIntent) => void;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}

/**
 * The decision.pickOne question-intent surface: a multi-option question a
 * dispatched session poses to the operator (modeled on Claude's
 * AskUserQuestion shape). Single-select for v1 — one radio per option, plus
 * a free-form panel when the payload allows it. Submitting answers the
 * intent via POST /staged-intents/:id/answer, which re-turns the
 * originating session; the panel never writes the task store itself.
 */
export function DecisionPickOnePanel({ intent, onAnswered, onDismiss }: Props) {
  const payload = intent.payload as DecisionPickOnePayload;
  const [chosenLabel, setChosenLabel] = useState<string | null>(null);
  const [freeForm, setFreeForm] = useState('');
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = Boolean(chosenLabel) || freeForm.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setInFlight(true);
    setError(null);
    try {
      const { intent: resolved } = await stagedIntentsApi.answer(intent.id, {
        chosenLabel,
        freeForm: freeForm.trim() || undefined,
      });
      onAnswered?.(intent, resolved);
    } catch (err) {
      if (isNotFoundError(err)) {
        onDismiss?.(intent);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to submit answer');
    } finally {
      setInFlight(false);
    }
  };

  return (
    <div className={styles.panel} data-testid="decision-pick-one-panel">
      <div className={styles.header}>
        <span className={styles.kind}>{intent.kind}</span>
        {intent.state && (
          <span className={styles.stateBadge}>{intent.state}</span>
        )}
      </div>

      <p className={styles.text}>{payload.prompt}</p>
      {intent.decisionProposal && (
        <p className={styles.rationale}>{intent.decisionProposal}</p>
      )}

      <div
        className={pickOneStyles.options}
        role="radiogroup"
        aria-label="Options"
      >
        {payload.options.map((option) => (
          <label key={option.label} className={pickOneStyles.option}>
            <input
              type="radio"
              name={`pick-one-${intent.id}`}
              checked={chosenLabel === option.label}
              onClick={() =>
                setChosenLabel((prev) =>
                  prev === option.label ? null : option.label,
                )
              }
              onChange={() => setChosenLabel(option.label)}
            />
            <span>
              <strong>{option.label}</strong>
              <span className={pickOneStyles.optionDescription}>
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>

      {payload.allowFreeForm && (
        <textarea
          className={styles.feedbackInput}
          placeholder="Write in your own answer…"
          value={freeForm}
          onChange={(e) => setFreeForm(e.target.value)}
        />
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.permissionButtons}>
        <button
          type="button"
          className={styles.approveButton}
          disabled={inFlight || !canSubmit}
          onClick={() => void handleSubmit()}
        >
          {inFlight ? 'Submitting...' : '✓ Submit'}
        </button>
      </div>
    </div>
  );
}
