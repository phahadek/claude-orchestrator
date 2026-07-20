// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';

const FRONTEND_SRC = join(__dirname, '..');
const FRONTEND_ROOT = join(FRONTEND_SRC, '..');
const BACKEND_ROOT = resolve(FRONTEND_ROOT, '../backend');
const ENTRY = join(FRONTEND_SRC, 'main.tsx');

const RESOLVABLE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

// Node modules that are known to be Node-only / cannot run in a browser
// bundle. Reaching one of these from the frontend entry graph reproduces the
// better-sqlite3-in-the-browser crash this guard exists to prevent.
const FORBIDDEN_BARE_SPECIFIERS = ['better-sqlite3'];

// Backend source files that transitively pull in Node built-ins / native
// modules (better-sqlite3 via db/db.ts). No frontend module may reach these.
const FORBIDDEN_BACKEND_FILES = [
  join(BACKEND_ROOT, 'src', 'db', 'db.ts'),
  join(BACKEND_ROOT, 'src', 'db', 'queries.ts'),
];

// Matches import/export ... from '...' statements, capturing the clause
// (everything between the keyword and `from`) and the specifier.
const IMPORT_RE =
  /(?:^|\n)\s*(import|export)\s+([^;\n]*?)\s+from\s+['"]([^'"]+)['"]/g;
// Matches bare side-effect imports: import '...'
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

interface ImportEdge {
  specifier: string;
  typeOnly: boolean;
}

function extractImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  let match: RegExpExecArray | null;

  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(content))) {
    const [, , clause, specifier] = match;
    // `import type {...} from '...'` / `export type {...} from '...'` are
    // erased entirely at build time — they never reach the bundle.
    const typeOnly = /^type\b/.test(clause.trim());
    edges.push({ specifier, typeOnly });
  }

  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  while ((match = SIDE_EFFECT_IMPORT_RE.exec(content))) {
    edges.push({ specifier: match[1], typeOnly: false });
  }

  return edges;
}

function resolveModuleFile(basePath: string): string | null {
  if (existsSync(basePath) && !basePath.endsWith('/')) {
    try {
      if (statSync(basePath).isFile()) return basePath;
    } catch {
      // fall through
    }
  }
  for (const ext of RESOLVABLE_EXTENSIONS) {
    if (existsSync(basePath + ext)) return basePath + ext;
  }
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const indexPath = join(basePath, 'index' + ext);
    if (existsSync(indexPath)) return indexPath;
  }
  return null;
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    return resolveModuleFile(resolve(dirname(fromFile), specifier));
  }
  if (specifier.startsWith('@claude-orchestrator/backend')) {
    const rest = specifier.slice('@claude-orchestrator/backend'.length);
    return resolveModuleFile(join(BACKEND_ROOT, rest));
  }
  // Non-relative, non-aliased specifiers are npm packages — not traversed,
  // but flagged directly if they're a known Node-only module.
  return null;
}

describe('no-backend-db-in-bundle guard', () => {
  it('never transitively imports better-sqlite3, db/db, or db/queries from the frontend entry graph', () => {
    const visited = new Set<string>();
    const violations: string[] = [];
    const queue: { file: string; chain: string[] }[] = [
      { file: ENTRY, chain: [relativeToFrontend(ENTRY)] },
    ];

    function relativeToFrontend(p: string): string {
      return p.startsWith(FRONTEND_ROOT)
        ? p.slice(FRONTEND_ROOT.length + 1)
        : p;
    }

    while (queue.length > 0) {
      const { file, chain } = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);

      if (FORBIDDEN_BACKEND_FILES.includes(file)) {
        violations.push(
          `${chain.join(' -> ')} -> [FORBIDDEN: ${relativeToFrontend(file)}]`,
        );
        continue;
      }

      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      for (const edge of extractImports(content)) {
        if (edge.typeOnly) continue;

        if (FORBIDDEN_BARE_SPECIFIERS.includes(edge.specifier)) {
          violations.push(
            `${chain.join(' -> ')} -> [FORBIDDEN: ${edge.specifier}]`,
          );
          continue;
        }

        const resolved = resolveSpecifier(file, edge.specifier);
        if (!resolved) continue; // npm package or non-module asset (css, etc)
        if (visited.has(resolved)) continue;
        queue.push({
          file: resolved,
          chain: [...chain, relativeToFrontend(resolved)],
        });
      }
    }

    expect(
      violations,
      `Frontend entry graph transitively reaches a Node-only backend module:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
