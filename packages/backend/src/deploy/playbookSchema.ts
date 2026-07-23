/**
 * Typed model for a project's in-repo `.claude-deploy-playbook.yml` — the
 * machine-readable form of the `/deploy` playbook contract (see
 * `config-template/procedures.md` § Deployment). Host-agnostic: no host,
 * absolute path, or secret is ever embedded here — that binding stays in
 * `context.md`.
 */

/** A glob matched against repo-relative diff paths (e.g. `packages/frontend/**`). */
export type PathGlob = string;

export type StepKind = 'shell' | 'agentic' | 'validation' | 'confirm-gate';

export interface StepDescriptor {
  /** Stable identifier for the step, referenced by `rollback_ref`. */
  id: string;
  kind: StepKind;
  /** The exact shell command (kind `shell`/`validation`/`confirm-gate`) or agent prompt (kind `agentic`). */
  command_or_prompt: string;
  /** The runtime user the step must run as, if constrained. */
  run_as?: string;
  /** When set, the step is conditional — only runs if these globs match the deployed→target diff. */
  changed_paths?: PathGlob[];
  /** Whether this step mutates production — gates the confirm-before-run rule. */
  is_prod_mutating: boolean;
  /** Whether the step supports a read-only preview invocation. */
  supports_dry_run?: boolean;
  /** A condition description/command to poll until satisfied (e.g. health check settling). */
  poll_until?: string;
  /** The step `id` to roll back to / reference on failure. */
  rollback_ref?: string;
}

export interface FailureDiagnosis {
  symptom: string;
  cause: string;
  action: string;
}

export interface CompanionDecl {
  name: string;
  /** Where the companion is deployed, if not co-located (advisory text, not an address). */
  host?: string;
  /** Source path(s) whose change in the deployed→target diff means this companion likely needs redeploying. */
  trigger_paths: PathGlob[];
  redeploy_instruction: string;
  hazards?: string[];
}

export interface DeployPlaybook {
  steps: StepDescriptor[];
  hazards: string[];
  failure_diagnoses: FailureDiagnosis[];
  companions: CompanionDecl[];
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

const STEP_KINDS: StepKind[] = [
  'shell',
  'agentic',
  'validation',
  'confirm-gate',
];

/** Kinds whose `command_or_prompt` (and `poll_until`) run verbatim in a shell — must be executable, not prose. */
const EXECUTABLE_KINDS: StepKind[] = ['shell', 'validation'];

const EXECUTABLE_TOKEN_RE = /^(sudo )?[A-Za-z0-9_./-]+$/;

/**
 * Function words that show up in prose instructions ("rsync the built
 * workspace into the runtime directory...") but essentially never appear as
 * bare words in a shell command line — their presence is a stronger prose
 * signal than the first token alone, since a real command's own name (e.g.
 * `rsync`) can itself pass the first-token executable-shape check.
 */
const PROSE_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'into',
  'using',
  'excluding',
  'including',
  'then',
  'please',
]);

/** True when `command` looks like an executable invocation rather than a natural-language instruction. */
function looksExecutable(command: string): boolean {
  const trimmed = command.trim();
  const firstToken = trimmed.split(/\s+/)[0];
  if (firstToken === undefined || !EXECUTABLE_TOKEN_RE.test(firstToken)) {
    return false;
  }
  const words = trimmed.toLowerCase().match(/[a-z']+/g) ?? [];
  return !words.some((word) => PROSE_STOPWORDS.has(word));
}

/** Validates and narrows a raw parsed value to a `StepDescriptor`; returns an error message on failure. */
function validateStep(raw: unknown, index: number): StepDescriptor | string {
  if (raw === null || typeof raw !== 'object') {
    return `steps[${index}] must be an object`;
  }
  const step = raw as Record<string, unknown>;
  if (!isString(step.id) || step.id.length === 0) {
    return `steps[${index}].id must be a non-empty string`;
  }
  if (!isString(step.kind) || !STEP_KINDS.includes(step.kind as StepKind)) {
    return `steps[${index}].kind must be one of ${STEP_KINDS.join(', ')}`;
  }
  if (
    !isString(step.command_or_prompt) ||
    step.command_or_prompt.length === 0
  ) {
    return `steps[${index}].command_or_prompt must be a non-empty string`;
  }
  if (
    EXECUTABLE_KINDS.includes(step.kind as StepKind) &&
    !looksExecutable(step.command_or_prompt)
  ) {
    return `steps[${index}].command_or_prompt for a ${step.kind} step must be an executable command, not prose`;
  }
  if (typeof step.is_prod_mutating !== 'boolean') {
    return `steps[${index}].is_prod_mutating must be a boolean`;
  }
  if (step.run_as !== undefined && !isString(step.run_as)) {
    return `steps[${index}].run_as must be a string`;
  }
  if (step.changed_paths !== undefined && !isStringArray(step.changed_paths)) {
    return `steps[${index}].changed_paths must be an array of strings`;
  }
  if (
    step.supports_dry_run !== undefined &&
    typeof step.supports_dry_run !== 'boolean'
  ) {
    return `steps[${index}].supports_dry_run must be a boolean`;
  }
  if (step.poll_until !== undefined && !isString(step.poll_until)) {
    return `steps[${index}].poll_until must be a string`;
  }
  if (
    step.kind === 'validation' &&
    isString(step.poll_until) &&
    !looksExecutable(step.poll_until)
  ) {
    return `steps[${index}].poll_until for a validation step must be an executable command, not prose`;
  }
  if (step.rollback_ref !== undefined && !isString(step.rollback_ref)) {
    return `steps[${index}].rollback_ref must be a string`;
  }
  return {
    id: step.id,
    kind: step.kind as StepKind,
    command_or_prompt: step.command_or_prompt,
    run_as: step.run_as as string | undefined,
    changed_paths: step.changed_paths as string[] | undefined,
    is_prod_mutating: step.is_prod_mutating,
    supports_dry_run: step.supports_dry_run as boolean | undefined,
    poll_until: step.poll_until as string | undefined,
    rollback_ref: step.rollback_ref as string | undefined,
  };
}

function validateFailureDiagnosis(
  raw: unknown,
  index: number,
): FailureDiagnosis | string {
  if (raw === null || typeof raw !== 'object') {
    return `failure_diagnoses[${index}] must be an object`;
  }
  const diag = raw as Record<string, unknown>;
  if (!isString(diag.symptom) || diag.symptom.length === 0) {
    return `failure_diagnoses[${index}].symptom must be a non-empty string`;
  }
  if (!isString(diag.cause) || diag.cause.length === 0) {
    return `failure_diagnoses[${index}].cause must be a non-empty string`;
  }
  if (!isString(diag.action) || diag.action.length === 0) {
    return `failure_diagnoses[${index}].action must be a non-empty string`;
  }
  return { symptom: diag.symptom, cause: diag.cause, action: diag.action };
}

function validateCompanion(
  raw: unknown,
  index: number,
): CompanionDecl | string {
  if (raw === null || typeof raw !== 'object') {
    return `companions[${index}] must be an object`;
  }
  const companion = raw as Record<string, unknown>;
  if (!isString(companion.name) || companion.name.length === 0) {
    return `companions[${index}].name must be a non-empty string`;
  }
  if (
    !isStringArray(companion.trigger_paths) ||
    companion.trigger_paths.length === 0
  ) {
    return `companions[${index}].trigger_paths must be a non-empty array of strings`;
  }
  if (
    !isString(companion.redeploy_instruction) ||
    companion.redeploy_instruction.length === 0
  ) {
    return `companions[${index}].redeploy_instruction must be a non-empty string`;
  }
  if (companion.host !== undefined && !isString(companion.host)) {
    return `companions[${index}].host must be a string`;
  }
  if (companion.hazards !== undefined && !isStringArray(companion.hazards)) {
    return `companions[${index}].hazards must be an array of strings`;
  }
  return {
    name: companion.name,
    host: companion.host as string | undefined,
    trigger_paths: companion.trigger_paths,
    redeploy_instruction: companion.redeploy_instruction,
    hazards: companion.hazards as string[] | undefined,
  };
}

/**
 * Validates a raw parsed YAML value against the deploy-playbook schema.
 * Returns the typed model on success, or a list of human-readable errors on
 * failure — the loader reports these rather than falling back to defaults,
 * since an invalid playbook must stop `/deploy`, not run a guessed one.
 */
export function validatePlaybook(
  raw: unknown,
): DeployPlaybook | { errors: string[] } {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object') {
    return { errors: ['playbook must be a YAML object'] };
  }
  const obj = raw as Record<string, unknown>;

  const steps: StepDescriptor[] = [];
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    obj.steps.forEach((rawStep, i) => {
      const result = validateStep(rawStep, i);
      if (typeof result === 'string') {
        errors.push(result);
      } else {
        steps.push(result);
      }
    });
  }

  const hazards: string[] = isStringArray(obj.hazards) ? obj.hazards : [];
  if (obj.hazards !== undefined && !isStringArray(obj.hazards)) {
    errors.push('hazards must be an array of strings');
  }

  const failureDiagnoses: FailureDiagnosis[] = [];
  if (obj.failure_diagnoses !== undefined) {
    if (!Array.isArray(obj.failure_diagnoses)) {
      errors.push('failure_diagnoses must be an array');
    } else {
      obj.failure_diagnoses.forEach((rawDiag, i) => {
        const result = validateFailureDiagnosis(rawDiag, i);
        if (typeof result === 'string') {
          errors.push(result);
        } else {
          failureDiagnoses.push(result);
        }
      });
    }
  }

  const companions: CompanionDecl[] = [];
  if (obj.companions !== undefined) {
    if (!Array.isArray(obj.companions)) {
      errors.push('companions must be an array');
    } else {
      obj.companions.forEach((rawCompanion, i) => {
        const result = validateCompanion(rawCompanion, i);
        if (typeof result === 'string') {
          errors.push(result);
        } else {
          companions.push(result);
        }
      });
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { steps, hazards, failure_diagnoses: failureDiagnoses, companions };
}
