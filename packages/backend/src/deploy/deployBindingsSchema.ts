/**
 * Typed model for a project's host-local `deploy-bindings.yml` (see
 * `loadDeployBindings.ts`): a flat map of shell/env-var-shaped names to
 * string values, injected as environment variables into deploy-playbook
 * steps (see `DeployOrchestrator`'s `buildDeployStepEnv`/`spawnShell`) and,
 * for the two step kinds never shell-executed (`confirm-gate`/`agentic`),
 * substituted directly into their surfaced text via `substituteBindings`.
 */

export type DeployBindings = Record<string, string>;

const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates a raw parsed YAML value against the deploy-bindings schema.
 * Returns the typed binding map on success, or a list of human-readable
 * errors on failure — mirrors `playbookSchema.validatePlaybook`'s
 * validate-and-narrow shape and its fail-closed posture on a malformed file.
 */
export function validateDeployBindings(
  raw: unknown,
): { bindings: DeployBindings } | { errors: string[] } {
  if (raw === null || raw === undefined) return { bindings: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      errors: ['deploy-bindings.yml must be a YAML mapping of name to value'],
    };
  }

  const obj = raw as Record<string, unknown>;
  const bindings: DeployBindings = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(obj)) {
    if (!BINDING_NAME_RE.test(name)) {
      errors.push(
        `binding name "${name}" must be a valid shell/env-var identifier (${BINDING_NAME_RE})`,
      );
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`binding "${name}" must be a string value`);
      continue;
    }
    bindings[name] = value;
  }

  if (errors.length > 0) return { errors };
  return { bindings };
}

const BRACED_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BARE_REF_RE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Statically scans `text` (a step's `command_or_prompt`/`poll_until`/
 * `identity_capture`) for `${NAME}`/`$NAME` binding references, without
 * requiring a bindings map — used by `DeployOrchestrator`'s preflight check
 * to determine which bindings a playbook needs *before* any step runs,
 * since `substituteBindings`/bash's own `-uc` (nounset) expansion only
 * surface a missing reference once that step is actually executing.
 */
export function extractBindingRefs(text: string | undefined): string[] {
  if (!text) return [];
  const names = new Set<string>();
  for (const source of [BRACED_REF_RE.source, BARE_REF_RE.source]) {
    const re = new RegExp(source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * Substitutes `${NAME}`/`$NAME` references in `text` against `bindings`,
 * fail-closed: a reference to an undefined binding is reported as an error
 * rather than silently expanding to empty (mirrors the `bash -uc` (nounset)
 * behavior used for shell/validation steps, for the two step kinds —
 * `confirm-gate`/`agentic` — whose text is surfaced without a shell).
 */
export function substituteBindings(
  text: string,
  bindings: DeployBindings,
): { ok: true; value: string } | { ok: false; reason: string } {
  let missing: string | null = null;
  const replaceRef = (name: string): string => {
    if (missing) return '';
    if (!(name in bindings)) {
      missing = name;
      return '';
    }
    return bindings[name];
  };
  const value = text
    .replace(BRACED_REF_RE, (_m, name) => replaceRef(name))
    .replace(BARE_REF_RE, (_m, name) => replaceRef(name));
  if (missing) {
    return {
      ok: false,
      reason: `undefined binding reference "${missing}" in "${text}"`,
    };
  }
  return { ok: true, value };
}
