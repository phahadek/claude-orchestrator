import fs from 'fs';
import path from 'path';
import { buildOrchestratorClaudeMd } from './orchestrator-claudemd';

export interface BuildSessionContextParams {
  taskName: string;
  taskUrl: string;
  projectContextUrl: string;
  targetBranch: string;
  projectDir: string;
  prGate?: { typeCheck: string; build: string };
  bashRules?: string[];
  taskBackend?: 'notion' | 'local';
}

/**
 * Build the merged session context string — orchestrator rules + project CLAUDE.md.
 *
 * This is the content that used to be written to the worktree's CLAUDE.md for CLI mode.
 * For API mode the same content is injected as the system prompt instead.
 *
 * Both runners consume this function so the content is always identical regardless of
 * the delivery method.
 */
export function buildSessionContext(params: BuildSessionContextParams): string {
  const {
    taskName,
    taskUrl,
    projectContextUrl,
    targetBranch,
    projectDir,
    prGate,
    bashRules,
    taskBackend,
  } = params;

  const orchestratorMd = buildOrchestratorClaudeMd({
    taskName,
    taskUrl,
    projectContextUrl,
    targetBranch,
    prGate,
    bashRules,
    taskBackend,
  });

  const projectMdPath = path.join(projectDir, 'CLAUDE.md');
  const projectMd = fs.existsSync(projectMdPath) ? fs.readFileSync(projectMdPath, 'utf-8') : '';

  return projectMd
    ? `${orchestratorMd}\n\n---\n\n# Project Instructions\n\n${projectMd}`
    : orchestratorMd;
}
