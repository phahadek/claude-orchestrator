import fs from 'fs';
import path from 'path';

export interface OrchestratorProjectConfig {
  /** Extra Bash tool permission patterns merged with the base ALLOWED_TOOLS set. */
  allowedTools?: string[];
  /** Commands for the pre-PR gate. Defaults to Node.js/Vite commands. */
  prGate?: {
    typeCheck?: string;
    build?: string;
  };
  /** Path to a script run in the worktree after creation (relative to the worktree root). */
  bootstrapScript?: string;
  /** Replacement bash rules (Rule 5+). Each item is the full rule text. */
  bashRules?: string[];
}

export interface ResolvedOrchestratorConfig {
  allowedTools: string[];
  prGate: {
    typeCheck: string;
    build: string;
  };
  bootstrapScript: string;
  bashRules: string[];
}

/** Default Rule 5: Node.js/npx convention. Stored as a single string; the first
 *  line becomes the bold heading, the rest becomes the body paragraph. */
const DEFAULT_BASH_RULES = [
  'Use `npx` instead of bare tool names.\n`tsc` → `npx tsc`. Bare commands may not be on PATH.',
];

const DEFAULTS: ResolvedOrchestratorConfig = {
  allowedTools: [],
  prGate: {
    typeCheck: 'npx tsc --noEmit',
    build: 'npx vite build',
  },
  bootstrapScript: '',
  bashRules: DEFAULT_BASH_RULES,
};

/**
 * Load per-project orchestrator configuration from `<projectDir>/.claude/orchestrator.json`.
 * Falls back to Node.js/Vite defaults if the file does not exist or is invalid.
 * The file is read fresh on every call — no server restart needed to pick up changes.
 */
export function loadOrchestratorConfig(projectDir: string): ResolvedOrchestratorConfig {
  const configPath = path.join(projectDir, '.claude', 'orchestrator.json');
  if (!fs.existsSync(configPath)) {
    return DEFAULTS;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as OrchestratorProjectConfig;
    return {
      allowedTools: parsed.allowedTools ?? DEFAULTS.allowedTools,
      prGate: {
        typeCheck: parsed.prGate?.typeCheck ?? DEFAULTS.prGate.typeCheck,
        build: parsed.prGate?.build ?? DEFAULTS.prGate.build,
      },
      bootstrapScript: parsed.bootstrapScript ?? DEFAULTS.bootstrapScript,
      bashRules: parsed.bashRules ?? DEFAULTS.bashRules,
    };
  } catch (err) {
    console.warn(`[orchestrator-config] failed to parse ${configPath}: ${err} — using defaults`);
    return DEFAULTS;
  }
}
