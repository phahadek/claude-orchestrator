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
    'Opportunistic',
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

/**
 * task.patchBodySection's payload — TaskBackend.ts's PatchBodySectionOperation
 * discriminated by `operation`, plus the targeted `section` heading text.
 * append carries `content`; replace carries `find`/`replaceWith`; remove
 * carries neither.
 */
export const patchBodySectionPayloadSchema = z.discriminatedUnion('operation', [
  z.object({
    taskId: z.string(),
    section: z.string(),
    operation: z.literal('append'),
    content: z.string(),
  }),
  z.object({
    taskId: z.string(),
    section: z.string(),
    operation: z.literal('replace'),
    find: z.string(),
    replaceWith: z.string(),
  }),
  z.object({
    taskId: z.string(),
    section: z.string(),
    operation: z.literal('remove'),
  }),
]);

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
    size_check: z.record(z.string(), z.unknown()).nullable().optional(),
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
  })
  .optional();

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
  groomProposal: groomProposalSchema.optional(),
  /**
   * Explicitly retires a prior intent this one replaces — the only way to
   * supersede a task.create/arch.createUnit draft whose title is also
   * changing, since title-based dedup alone can't identify it.
   */
  supersedes: z.string().optional(),
};

export const gateContributionSourceTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string(),
  milestone: z.string(),
});

export const gateContributionItemInputSchema = z.object({
  text: z.string(),
  classification: z
    .enum([
      'Read-Only',
      'Prod-Mutating',
      'Opportunistic',
      'Human-Observation',
      'needs-triage',
    ])
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
export const flakyGateSchema = z.enum(['ci', 'f2']);

/** GateVerifyDisposition's disposition vocabulary — see AgentSession.ts's recordGateVerifyDisposition. */
export const gateVerifyDispositionSchema = z.enum([
  'pass',
  'fail',
  'needs-setup',
]);

/** AgentSession.ts's VERIFIER_RECLASSIFY_TARGETS — the only reclassify targets a gate-verify session may propose. */
const gateVerifyReclassifyToSchema = z.enum([
  'Human-Observation',
  'needs-triage',
]);

export const gateVerifyReclassifySchema = z.object({
  to: gateVerifyReclassifyToSchema,
  reason: z.string(),
});
