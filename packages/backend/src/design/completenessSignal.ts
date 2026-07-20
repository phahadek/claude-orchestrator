/**
 * Advisory trace-coverage signal for the /design completeness safeguard
 * (M12 "Design a completeness safeguard for design-task open-question sets").
 *
 * For a design task's outputs — the regions its filed follow-on Code tasks
 * touch, and its own acceptance criteria — this checks whether each output
 * traces back to at least one of the design's locked decisions. An output
 * that maps to no locked decision is surfaced as a "possibly-unasked-question"
 * flag for the /design critic to consider.
 *
 * This is advisory only: it never raises an error, never blocks a promotion,
 * and there is no question-count gate. It reuses the region-resolution built
 * for the grooming worklist (resolveTaskRegions) so a filed Code task's
 * region is computed the same way the promotion gate computes it.
 */

import {
  resolveTaskRegions,
  type CodeWorklistOptions,
  type WorklistTask,
} from '../groom/codeWorklist';

export interface LockedDecision {
  /** The open question this decision resolves. */
  question: string;
  /** The locked decision text. */
  decision: string;
}

export interface FollowOnCodeTask {
  id: string;
  title: string;
  filesSection: string;
  rawMarkdown: string;
}

export interface TraceCoverageInput {
  designTaskId: string;
  /** The design task's own acceptance-criteria bullets. */
  acceptanceCriteria: string[];
  /** The design task's locked decisions (open_questions[i].locked_decision, non-null). */
  lockedDecisions: LockedDecision[];
  /** Code tasks the design task filed as follow-ons. */
  followOnTasks: FollowOnCodeTask[];
  /** Region-resolution config, mirroring groomLoad's worklistOptions. */
  worklistOptions: CodeWorklistOptions;
}

export type TraceCoverageOutputKind = 'region' | 'acceptance_criterion';

export interface TraceCoverageFlag {
  kind: TraceCoverageOutputKind;
  /** Follow-on task id for a 'region' flag, or the criterion's index for 'acceptance_criterion'. */
  sourceId: string;
  /** The region path / package, or the acceptance-criterion text. */
  label: string;
  reason: string;
}

export interface TraceCoverageResult {
  /** Always true — this signal never blocks; callers must not gate on it. */
  advisory: true;
  flags: TraceCoverageFlag[];
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'for',
  'with',
  'without',
  'into',
  'from',
  'that',
  'this',
  'these',
  'those',
  'when',
  'where',
  'which',
  'who',
  'what',
  'how',
  'why',
  'not',
  'never',
  'always',
  'each',
  'every',
  'per',
  'its',
  'it',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'as',
  'if',
  'then',
  'than',
  'so',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'will',
  'would',
  'should',
  'could',
  'can',
  'must',
  'may',
  'might',
  'task',
  'tasks',
  'design',
  'code',
]);

function significantTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** True if any locked decision shares a significant token with the given output text. */
function tracesToADecision(
  outputText: string,
  decisions: LockedDecision[],
): boolean {
  const outputTokens = significantTokens(outputText);
  if (outputTokens.size === 0) return true; // nothing to check against — don't flag empty text
  for (const d of decisions) {
    const decisionTokens = significantTokens(`${d.question} ${d.decision}`);
    for (const t of outputTokens) {
      if (decisionTokens.has(t)) return true;
    }
  }
  return false;
}

/**
 * Computes the advisory trace-coverage signal for a design task: which of
 * its filed follow-on Code task regions, and which of its own acceptance
 * criteria, map to no locked decision.
 */
export function computeTraceCoverage(
  input: TraceCoverageInput,
): TraceCoverageResult {
  const flags: TraceCoverageFlag[] = [];

  for (const task of input.followOnTasks) {
    const worklistTask: WorklistTask = {
      id: task.id,
      title: task.title,
      filesSection: task.filesSection,
      rawMarkdown: task.rawMarkdown,
    };
    const regions = resolveTaskRegions(worklistTask, input.worklistOptions);
    const regionLabels =
      regions.packages.length > 0 ? regions.packages : regions.files;
    for (const label of regionLabels) {
      const outputText = `${task.title} ${label}`;
      if (!tracesToADecision(outputText, input.lockedDecisions)) {
        flags.push({
          kind: 'region',
          sourceId: task.id,
          label,
          reason: `Filed follow-on task "${task.title}" touches "${label}", which maps to no locked decision — possibly an unasked question.`,
        });
      }
    }
  }

  input.acceptanceCriteria.forEach((criterion, index) => {
    if (!tracesToADecision(criterion, input.lockedDecisions)) {
      flags.push({
        kind: 'acceptance_criterion',
        sourceId: String(index),
        label: criterion,
        reason: `Acceptance criterion "${criterion}" maps to no locked decision — possibly an unasked question.`,
      });
    }
  });

  return { advisory: true, flags };
}
