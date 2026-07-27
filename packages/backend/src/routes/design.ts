import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  insertCompletenessDisposition,
  listCompletenessDispositions,
} from '../db/queries';
import type { CompletenessDispositionQuestion } from '../db/types';
import {
  computeTraceCoverage,
  type TraceCoverageInput,
} from '../design/completenessSignal';
import type { CodeWorklistOptions } from '../groom/codeWorklist';

/**
 * Thin /design surface: durable write-through + audit read for the
 * completeness-disposition record (OQ2), and the advisory trace-coverage
 * signal (OQ1). Both are /design-scoped and advisory-only — neither is a
 * promotion gate.
 */
export function createDesignRouter(): Router {
  const router = Router();

  // POST /api/design/:taskId/completeness-disposition
  // { project?, milestone?, questions: [{question, disposition, reason}], runAt }
  router.post(
    '/design/:taskId/completeness-disposition',
    (req: Request, res: Response) => {
      const taskId = String(req.params.taskId);
      const body = req.body as {
        project?: unknown;
        milestone?: unknown;
        questions?: unknown;
        runAt?: unknown;
      };
      if (!Array.isArray(body.questions)) {
        res.status(400).json({ error: 'questions must be an array' });
        return;
      }
      for (const q of body.questions) {
        if (
          typeof q !== 'object' ||
          q === null ||
          typeof (q as { question?: unknown }).question !== 'string' ||
          !['accepted', 'dismissed'].includes(
            (q as { disposition?: unknown }).disposition as string,
          ) ||
          typeof (q as { reason?: unknown }).reason !== 'string' ||
          ((q as { approvalStatus?: unknown }).approvalStatus !== undefined &&
            !['proposed', 'approved'].includes(
              (q as { approvalStatus?: unknown }).approvalStatus as string,
            ))
        ) {
          res.status(400).json({
            error:
              'each question requires {question, disposition: "accepted"|"dismissed", reason, ' +
              'approvalStatus?: "proposed"|"approved"}',
          });
          return;
        }
      }
      if (typeof body.runAt !== 'string') {
        res.status(400).json({ error: 'runAt is required' });
        return;
      }
      // Recorded is not approved — the critic pass writes every disposition
      // as `proposed` unless the caller says otherwise; only an operator
      // sign-off on the closing synthesis flips a question to `approved`.
      const questions = (
        body.questions as CompletenessDispositionQuestion[]
      ).map((q) => ({ approvalStatus: 'proposed' as const, ...q }));
      const row = insertCompletenessDisposition({
        source_task_id: taskId,
        project: typeof body.project === 'string' ? body.project : null,
        milestone: typeof body.milestone === 'string' ? body.milestone : null,
        questions: JSON.stringify(questions),
        run_at: body.runAt,
      });
      res.status(201).json({
        ...row,
        questions: JSON.parse(
          row.questions,
        ) as CompletenessDispositionQuestion[],
      });
    },
  );

  // GET /api/design/:taskId/completeness-disposition
  router.get(
    '/design/:taskId/completeness-disposition',
    (req: Request, res: Response) => {
      const taskId = String(req.params.taskId);
      const rows = listCompletenessDispositions(taskId).map((row) => ({
        ...row,
        questions: JSON.parse(
          row.questions,
        ) as CompletenessDispositionQuestion[],
      }));
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
