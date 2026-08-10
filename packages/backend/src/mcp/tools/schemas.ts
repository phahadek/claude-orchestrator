import { z } from 'zod';
import { TRIAGE_VERDICTS } from '../../planning/triage';
import { GATE_ITEM_TIER_SELECTION_GUIDANCE } from '../../gate/gateItemClassificationGuidance';

/**
 * Shared zod schemas for the stage-proposal MCP tool surface — one shape per
 * staged-intent payload field the command layer already validates deeply
 * (TaskWriteCommands / groomGate / readinessGate). These schemas exist to
 * reject structurally malformed input at the tool-call boundary, not to
 * duplicate the command layer's own invariants.
 */

/** Canonical Type vocabulary — see TaskWriteCommands.ts's TaskType. */
export const taskTypeSchema = z.enum([
  '💻 Code',
  '📐 Design',
  '🔧 Operational',
  '🔎 Investigation',
]);

/** Canonical status vocabulary — see statusCanonical.ts's TaskStatus. */
export const taskStatusSchema = z.enum([
  'Backlog',
  'Ready',
  'In Progress',
  'In Review',
  'Blocked',
  'Deferred',
  'Done',
]);

/** GateItemClassification, plus the two non-classifying accretion dispositions. */
export const gateContributionDecisionSchema = z
  .enum([
    'Read-Only',
    'Prod-Mutating',
    'Human-Observation',
    'needs-triage',
    'none',
    'n/a',
  ])
  .describe(
    `${GATE_ITEM_TIER_SELECTION_GUIDANCE} "needs-triage" defers the tier ` +
      'decision to a human. "none" and "n/a" are not tiers — they are the ' +
      'bare accretion dispositions for a source task with nothing runtime-' +
      'observable to contribute.',
  );

export const seedContributionDecisionSchema = z.enum(['seeds', 'none', 'n/a']);

const archUnitKindSchema = z.enum([
  'subsystem',
  'invariant',
  'decision',
  'contract',
  'reference',
]);

const archUnitStatusSchema = z.enum(['active', 'deferred', 'superseded']);

/** OpsJournalState — see ops/opsJournal.ts. */
export const opsStateSchema = z.enum([
  'pending',
  'candidate',
  'staged-proposal',
  'applied-pending-confirm',
  'blocked',
  'incident-frozen',
  'resolved',
]);

/**
 * OpsReconciliationAssertion — db/types.ts. Required on the Operational
 * completing intent (journal.setState -> "applied-pending-confirm"): a
 * declaration of what must be true once the change applies, evaluated
 * automatically once this intent applies (see stagedIntents.ts's
 * reconcileOpsCompletion). The session performs the actual check itself
 * (re-reading a config row, counting a backfill) and reports the outcome
 * here — `passed` is the session's own verdict, not re-derived by the
 * orchestrator.
 */
export const opsReconciliationAssertionSchema = z.object({
  description: z
    .string()
    .describe('What must be true once the change applies.'),
  passed: z
    .boolean()
    .describe('Whether the session confirmed the assertion holds.'),
  mismatch: z
    .string()
    .optional()
    .describe('What was actually observed instead, when passed is false.'),
});

/** bodyRender.ts's BlockModel union — the Context section's structured content model. */
const blockModelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string() }),
  z.object({ type: z.literal('heading_3'), text: z.string() }),
  z.object({ type: z.literal('bulleted_list_item'), text: z.string() }),
  z.object({ type: z.literal('numbered_list_item'), text: z.string() }),
  z.object({ type: z.literal('quote'), text: z.string() }),
  z.object({
    type: z.literal('code'),
    text: z.string(),
    language: z.string().optional(),
  }),
]);

/** The /groom skill's structured Ready-flip proposal — see stagedIntents.ts's GroomProposalFields. */
const groomProposalSchema = z.object({
  achieves: z.string(),
  openQuestions: z.string(),
  automatedTests: z.string(),
  manualVerification: z.string(),
  operationalSeed: z.string(),
});

/** The intent envelope fields shared by every stage-proposal tool, alongside its kind-specific payload. */
export const intentEnvelopeShape = {
  groupId: z.string().optional(),
  decisionProposal: z.string().optional(),
  /**
   * The file:line / arch-page-section / API-result evidence a
   * decision.pickOne's decisionProposal recommendation rests on — carried
   * separately so decisionProposal itself stays at design altitude (the
   * named recommendation and its load-bearing reason).
   */
  investigation: z.string().optional(),
  groomProposal: groomProposalSchema.optional(),
  /**
   * Explicitly retires a prior intent this one replaces — the only way to
   * supersede a task.create/arch.createUnit draft whose title is also
   * changing, since title-based dedup alone can't identify it.
   */
  supersedes: z.string().optional(),
};

const ENVELOPE_FIELD_NAMES = new Set(Object.keys(intentEnvelopeShape));

/**
 * Flags every key in `value` that isn't in `knownKeys` — a key matching one
 * of the intent-envelope's own field names (groupId, decisionProposal,
 * investigation, groomProposal, supersedes) gets a message naming it as the
 * mistake this exists to catch: that field belongs alongside payload, as a
 * sibling parameter, not nested inside it.
 */
function addUnknownPayloadKeyIssues(
  value: Record<string, unknown>,
  knownKeys: Set<string>,
  ctx: z.RefinementCtx,
): void {
  for (const key of Object.keys(value)) {
    if (knownKeys.has(key)) continue;
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: ENVELOPE_FIELD_NAMES.has(key)
        ? `Unrecognized key "${key}" in payload — "${key}" is an envelope field and belongs alongside payload as a sibling parameter, not nested inside it.`
        : `Unrecognized key "${key}" in payload.`,
    });
  }
}

/**
 * Wraps a payload shape so any key it doesn't declare fails validation by
 * name instead of Zod's default of silently stripping it — the fix for a
 * misplaced envelope field (e.g. groomProposal nested inside payload)
 * discarding itself with no error.
 */
export function rejectUnknownPayloadKeys<T extends z.ZodRawShape>(shape: T) {
  const known = new Set(Object.keys(shape));
  return z
    .object(shape)
    .loose()
    .superRefine((value, ctx) =>
      addUnknownPayloadKeyIssues(value as Record<string, unknown>, known, ctx),
    );
}

const patchBodySectionShapesByOperation = {
  append: {
    taskId: z.string(),
    section: z.string(),
    operation: z.literal('append'),
    content: z.string(),
  },
  replace: {
    taskId: z.string(),
    section: z.string(),
    operation: z.literal('replace'),
    find: z.string(),
    replaceWith: z.string(),
  },
  remove: {
    taskId: z.string(),
    section: z.string(),
    operation: z.literal('remove'),
  },
} as const;

/**
 * task.patchBodySection's payload — TaskBackend.ts's PatchBodySectionOperation
 * discriminated by `operation`, plus the targeted `section` heading text.
 * append carries `content`; replace carries `find`/`replaceWith`; remove
 * carries neither. Each variant rejects keys outside its own operation's
 * shape (checked post-discrimination, since the variants don't share a
 * field set to validate against up front).
 */
export const patchBodySectionPayloadSchema = z
  .discriminatedUnion('operation', [
    z.object(patchBodySectionShapesByOperation.append).loose(),
    z.object(patchBodySectionShapesByOperation.replace).loose(),
    z.object(patchBodySectionShapesByOperation.remove).loose(),
  ])
  .superRefine((value, ctx) =>
    addUnknownPayloadKeyIssues(
      value as unknown as Record<string, unknown>,
      new Set(Object.keys(patchBodySectionShapesByOperation[value.operation])),
      ctx,
    ),
  );

/**
 * bodyRender.ts's TaskBodySections — the full required section set (Summary,
 * Dependencies, Context, Acceptance criteria, Files/Notion pages affected).
 * A caller omitting a required section fails schema validation here rather
 * than landing a structurally incomplete body.
 */
export const taskBodySectionsSchema = z.object({
  summary: z.string(),
  dependencies: z.array(z.string()),
  context: z.array(blockModelSchema),
  automatedCriteria: z.array(z.string()),
  manualCriteria: z.array(z.string()),
  filesAffected: z.array(z.string()).optional(),
  notionPagesAffected: z.array(z.string()).optional(),
  taskType: z.string().optional(),
});

/** groomGate.ts's GroomingGateEntry — deep validation stays with checkGroomingPromotionGate. */
export const groomingGateEntrySchema = z
  .object({
    size_check: z
      .object({
        decision: z.enum(['no_split', 'split_now', 'unsplittable', 'n/a']),
        files: z.number().optional(),
        loc: z.number().optional(),
        loc_method: z.string().optional(),
        split_into: z.array(z.unknown()).optional(),
        reason: z.string().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    type_check: z.record(z.string(), z.unknown()).nullable().optional(),
    type: z.string().optional(),
    regions: z.unknown().optional(),
    constraintsDispositioned: z.record(z.string(), z.unknown()).optional(),
    filesPathsEntries: z.array(z.unknown()).optional(),
    dependsOnTasks: z.array(z.unknown()).optional(),
    triage: z
      .object({
        proposedVerdict: z.enum(TRIAGE_VERDICTS),
        hasOpenQuestionsHeading: z.boolean(),
      })
      .optional(),
    /** Structural fact: whether the pre-groom body carried a `## Operational seed` section — see groomGate.ts's GroomingGateEntry. */
    hasOperationalSeedSection: z.boolean().optional(),
    /** Per-line triage of the pre-groom `## Operational seed` section's candidates — see groomGate.ts's GroomingGateEntry.seedContributionCandidates. */
    seedContributionCandidates: z
      .array(
        z.object({
          spec: z.string(),
          classification: z
            .enum(['operational-seed', 'in-pr', 'needs-triage'])
            .optional(),
        }),
      )
      .optional(),
    /** Per-line triage of the pre-groom `### 👁️ Manual verification` section's candidates — see groomGate.ts's GroomingGateEntry.gateContributionCandidates. */
    gateContributionCandidates: z
      .array(
        z.object({
          text: z.string(),
          classification: z
            .enum([
              'runtime-observable',
              'config-or-code-determined',
              'needs-triage',
            ])
            .optional(),
        }),
      )
      .optional(),
  })
  .optional();

export const gateContributionSourceTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string(),
  milestone: z.string(),
});

export const gateContributionItemInputSchema = z.object({
  text: z.string(),
  classification: z
    .enum(['Read-Only', 'Prod-Mutating', 'Human-Observation', 'needs-triage'])
    .optional()
    .describe(
      `${GATE_ITEM_TIER_SELECTION_GUIDANCE} Overrides the batch-level ` +
        'classification for this item only; omit to inherit it — a batch ' +
        'mixing a rendered-UI check with record-query checks can tier each ' +
        'item correctly in one call.',
    ),
});

export const seedContributionSourceTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string(),
  milestone: z.string(),
});

export const seedContributionItemInputSchema = z.object({
  spec: z.string(),
});

export const archUnitMetadataSchema = z.object({
  kind: archUnitKindSchema,
  topic: z.string(),
  regions: z.array(z.string()),
  status: archUnitStatusSchema.optional(),
});

export const archCreateUnitPayloadSchema = z.object({
  title: z.string(),
  metadata: archUnitMetadataSchema,
  body: z.string(),
});

export const decisionPickOneOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
});

/** ParsedDispositionItem's disposition vocabulary — see AgentSession.ts's recordReviewDisposition. */
export const reviewDispositionSchema = z.enum([
  'addressed',
  'wont_fix',
  'out_of_scope',
]);

/** VerifiedFlakyDisposition's gate vocabulary — see AgentSession.ts's recordVerifiedFlakyDisposition. */
export const flakyGateSchema = z.enum(['ci', 'f2', 'analyze']);

/** GateVerifyDisposition's disposition vocabulary — see AgentSession.ts's recordGateVerifyDisposition. */
export const gateVerifyDispositionSchema = z.enum([
  'pass',
  'fail',
  'needs-setup',
]);

/** AgentSession.ts's VERIFIER_RECLASSIFY_TARGETS — the only reclassify targets a gate-verify session may propose. */
export const gateVerifyReclassifyToSchema = z.enum([
  'Human-Observation',
  'needs-triage',
]);

export const gateVerifyReclassifySchema = z.object({
  to: gateVerifyReclassifyToSchema,
  reason: z.string(),
});

/** One line, no exceptions — the cap that forces gate.verify evidence terse rather than prose. */
const GATE_VERIFY_EVIDENCE_LINE_MAX = 240;

const gateVerifyEvidenceLineSchema = z
  .string()
  .max(
    GATE_VERIFY_EVIDENCE_LINE_MAX,
    `must be a single line, ${GATE_VERIFY_EVIDENCE_LINE_MAX} characters or fewer`,
  );

/**
 * gate.verify's evidence contract — expected/found/query are always
 * required and each capped to one line, replacing the old free-prose
 * evidence.explanation. `source` (a file:line reference) is admissible only
 * when the sibling `disposition` is `fail`; see gateVerifyPayloadSchema for
 * that cross-field enforcement, since this schema alone can't see
 * `disposition`.
 */
export const gateVerifyEvidenceSchema = z.object({
  expected: gateVerifyEvidenceLineSchema,
  found: gateVerifyEvidenceLineSchema,
  query: gateVerifyEvidenceLineSchema,
  source: gateVerifyEvidenceLineSchema.optional(),
});

/**
 * The full gate.verify tool-call shape, used to enforce the one rule that
 * spans both sibling fields: `evidence.source` is admissible only on a
 * `fail` disposition. The MCP tool registration also declares
 * disposition/evidence/reclassify individually (for the JSON schema the
 * calling agent sees), but the handler re-validates the assembled args
 * against this schema so the fail-only-source rule is actually enforced.
 */
export const gateVerifyPayloadSchema = z
  .object({
    gateItemId: z.string(),
    disposition: gateVerifyDispositionSchema,
    evidence: gateVerifyEvidenceSchema.optional(),
    reclassify: gateVerifyReclassifySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.evidence?.source !== undefined && value.disposition !== 'fail') {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence', 'source'],
        message:
          'evidence.source is only permitted when disposition is "fail".',
      });
    }
  });

/**
 * gate.verify's success response — echoes the staged intent's id and its
 * recorded milestone, the same shape journal.setState already echoes, so a
 * caller can see how its write was actually recorded (which gate_item it
 * resolved to, and whether it landed attributed to a milestone) instead of
 * a bare acknowledgement.
 */
export const gateVerifyResultSchema = z.object({
  status: z.literal('ok'),
  id: z.string(),
  milestone: z.string().nullable(),
});

/** AgenticVerdict — see DeployOrchestrator.ts and AgentSession.ts's recordDeployAgenticVerdict. */
export const deployAgenticVerdictSchema = z.enum([
  'approved',
  'rejected',
  'inconclusive',
]);
