import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  buildCompletenessDispositionRow,
  insertCompletenessDisposition,
  listCompletenessDispositions,
  getTaskCache,
} from '../db/queries';
import {
  COMPLETENESS_PROBED_GAP_CLASSES,
  type CompletenessDispositionQuestion,
  type CompletenessDispositionRecord,
  type CompletenessProbedGapClass,
} from '../db/types';
import {
  computeTraceCoverage,
  type TraceCoverageInput,
} from '../design/completenessSignal';
import type { CodeWorklistOptions } from '../groom/codeWorklist';
import { normalizeTaskId } from '../tasks/taskId';

const NAMED_DISPOSITIONS = [
  'resolved',
  'out-of-scope',
  'not-a-decision',
  'fold',
  'file-sibling',
  'sibling-owned',
];

function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Thin /design surface: durable write-through + audit read for the
 * completeness-disposition record (OQ2), and the advisory trace-coverage
 * signal (OQ1). Both are /design-scoped and advisory-only — neither is a
 * promotion gate.
 */
export function createDesignRouter(): Router {
  const router = Router();

  // POST /api/design/:taskId/completeness-disposition
  // { project?, milestone?, probed: [<gap classes checked>], questions: [{question, disposition, reason}], runAt }
  router.post(
    '/design/:taskId/completeness-disposition',
    (req: Request, res: Response) => {
      const taskId = normalizeTaskId(String(req.params.taskId));
      const body = req.body as {
        project?: unknown;
        milestone?: unknown;
        probed?: unknown;
        questions?: unknown;
        runAt?: unknown;
      };
      if (
        !Array.isArray(body.probed) ||
        body.probed.length === 0 ||
        !body.probed.every(
          (p) =>
            typeof p === 'string' &&
            (COMPLETENESS_PROBED_GAP_CLASSES as readonly string[]).includes(p),
        )
      ) {
        res.status(400).json({
          error:
            'probed must be a non-empty array drawn from the named gap classes — ' +
            `an affirmative statement of what the critic checked, even on a clean pass (one of: ${COMPLETENESS_PROBED_GAP_CLASSES.join(', ')})`,
        });
        return;
      }
      if (!Array.isArray(body.questions)) {
        res.status(400).json({ error: 'questions must be an array' });
        return;
      }
      for (const q of body.questions) {
        if (
          typeof q !== 'object' ||
          q === null ||
          typeof (q as { question?: unknown }).question !== 'string' ||
          !NAMED_DISPOSITIONS.includes(
            (q as { disposition?: unknown }).disposition as string,
          ) ||
          typeof (q as { reason?: unknown }).reason !== 'string' ||
          ((q as { approvalStatus?: unknown }).approvalStatus !== undefined &&
            !['proposed', 'approved', 'rejected'].includes(
              (q as { approvalStatus?: unknown }).approvalStatus as string,
            ))
        ) {
          res.status(400).json({
            error:
              `each question requires {question, disposition: one of ${NAMED_DISPOSITIONS.join('|')}, reason, ` +
              'approvalStatus?: "proposed"|"approved"|"rejected"}',
          });
          return;
        }
      }
      if (typeof body.runAt !== 'string' || !isValidTimestamp(body.runAt)) {
        res
          .status(400)
          .json({ error: 'runAt is required and must be a valid timestamp' });
        return;
      }
      if (!getTaskCache(taskId)) {
        res.status(400).json({
          error: `task "${taskId}" does not resolve — no cached task with this id exists`,
        });
        return;
      }
      // Recorded is not approved — the critic pass writes every disposition
      // as `proposed` unless the caller says otherwise; only approving the
      // completeness.disposition staged intent this run produces flips a
      // question to `approved` (a rejection deletes the row instead — see
      // deleteCompletenessDisposition) — see buildCompletenessDispositionRow,
      // shared with the completeness.disposition MCP tool so the two
      // writers can never diverge in shape.
      const row = insertCompletenessDisposition(
        buildCompletenessDispositionRow({
          taskId,
          project: typeof body.project === 'string' ? body.project : null,
          milestone: typeof body.milestone === 'string' ? body.milestone : null,
          probed: body.probed as CompletenessProbedGapClass[],
          questions: body.questions as CompletenessDispositionQuestion[],
          runAt: body.runAt,
        }),
      );
      const record = JSON.parse(row.questions) as CompletenessDispositionRecord;
      res.status(201).json({
        ...row,
        probed: record.probed,
        questions: record.questions,
      });
    },
  );

  // GET /api/design/:taskId/completeness-disposition
  router.get(
    '/design/:taskId/completeness-disposition',
    (req: Request, res: Response) => {
      const taskId = String(req.params.taskId);
      const rows = listCompletenessDispositions(taskId).map((row) => {
        const record = JSON.parse(
          row.questions,
        ) as CompletenessDispositionRecord;
        return { ...row, probed: record.probed, questions: record.questions };
      });
      res.json({ runs: rows });
    },
  );

  // POST /api/design/:taskId/trace-coverage
  // { acceptanceCriteria, lockedDecisions, followOnTasks, worklistOptions }
  router.post(
    '/design/:taskId/trace-coverage',
    (req: Request, res: Response) => {
      const taskId = String(req.params.taskId);
      const body = req.body as Partial<
        Omit<TraceCoverageInput, 'designTaskId'>
      >;
      if (
        !Array.isArray(body.acceptanceCriteria) ||
        !Array.isArray(body.lockedDecisions) ||
        !Array.isArray(body.followOnTasks) ||
        typeof body.worklistOptions !== 'object' ||
        body.worklistOptions === null
      ) {
        res.status(400).json({
          error:
            'acceptanceCriteria, lockedDecisions, followOnTasks (arrays) and worklistOptions (object) are required',
        });
        return;
      }
      const trackedFiles = (body.worklistOptions as CodeWorklistOptions)
        .trackedFiles;
      if (
        !Array.isArray(trackedFiles) ||
        !trackedFiles.every((f) => typeof f === 'string')
      ) {
        res.status(400).json({
          error:
            'worklistOptions.trackedFiles (array of repo-relative paths) is required',
        });
        return;
      }
      const result = computeTraceCoverage({
        designTaskId: taskId,
        acceptanceCriteria: body.acceptanceCriteria,
        lockedDecisions: body.lockedDecisions,
        followOnTasks: body.followOnTasks,
        worklistOptions: body.worklistOptions,
      });
      res.json(result);
    },
  );

  return router;
}
