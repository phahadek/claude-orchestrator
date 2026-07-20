/**
 * Selective-injection read module — given a session's task regions/topic and
 * project, returns the architecture relevant to that session, not the whole
 * store. The shared read primitive for the planning-procedure assembler
 * (dispatched groom/design/ops sessions) and grooming (which inlines the
 * returned units' binding constraints into task bodies — the vector by which
 * auto-dispatched code sessions receive architecture; they have no direct
 * store or Notion access).
 *
 * Selection (store path):
 *  - Region-intersection: units whose regions intersect the task's resolved
 *    regions (resolveTaskRegions() / the grooming code-worklist).
 *  - Always-invariants: every active kind='invariant' unit unconditionally —
 *    globally-binding constraints a region match would miss.
 *  - Topic fallback: for sessions with no file scope (design/planning
 *    sessions carry '## Notion pages affected', not '## Files / paths
 *    affected'), the units filed under the session's topic.
 *  - All filtered to status='active'.
 *
 * Dual-read: a project reads from the arch_unit store once migrated
 * (per-project `archStoreAdopted` flag), else falls back to fetching the
 * project's Notion architecture pages (current, pre-migration behaviour). A
 * whole project flips at migration — no per-page split-brain.
 */
import { queryUnits, type ArchUnit } from './ArchUnitStore';
import { ProjectService } from '../projects/ProjectService';
import { loadManifest, resolveConfigDir } from '../groom/groomLoad';
import { NotionClient } from '../notion/NotionClient';

export interface SelectiveInjectionRegions {
  packages?: string[];
  files?: string[];
}

export interface ArchitecturePageDoc {
  id: string;
  title: string;
  markdown: string;
}

export interface SelectiveInjectionInput {
  projectId: string;
  /** Resolved regions from resolveTaskRegions()/the code-worklist, when the session has file scope. */
  regions?: SelectiveInjectionRegions;
  /** The session's topic — consulted when `regions` carries no file scope. */
  topic?: string;
}

export type SelectiveInjectionResult =
  | { source: 'store'; units: ArchUnit[] }
  | { source: 'notion'; pages: ArchitecturePageDoc[] };

export interface NotionArchitectureClient {
  fetchPageMarkdown(
    pageId: string,
  ): Promise<{ title: string; markdown: string }>;
}

export interface SelectiveInjectionDeps {
  /** Defaults to reading Project.archStoreAdopted. */
  isArchStoreAdopted?: (projectId: string) => boolean;
  /** Defaults to querying the arch_unit store's active set. */
  queryActiveUnits?: () => ArchUnit[];
  /** Defaults to fetching the project's grooming-manifest context pages via NotionClient. */
  fetchNotionArchitecturePages?: (
    projectId: string,
  ) => Promise<ArchitecturePageDoc[]>;
}

/** True when either path of `a`/`b` is a prefix of (or equal to) the other. */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function regionsIntersect(
  unitRegions: string[],
  resolvedRegions: string[],
): boolean {
  return unitRegions.some((u) =>
    resolvedRegions.some((r) => pathsOverlap(u, r)),
  );
}

function defaultIsArchStoreAdopted(projectId: string): boolean {
  return ProjectService.getById(projectId)?.archStoreAdopted ?? false;
}

function defaultQueryActiveUnits(): ArchUnit[] {
  return queryUnits({ status: 'active' });
}

/** Current, pre-migration behaviour: the project's full set of fixed Notion architecture pages. */
async function defaultFetchNotionArchitecturePages(
  projectId: string,
): Promise<ArchitecturePageDoc[]> {
  const project = ProjectService.getById(projectId);
  if (!project) return [];
  const repoRoot = project.projectDir;
  if (!resolveConfigDir(repoRoot)) return [];
  const manifest = loadManifest(repoRoot, project.id);
  const notion = new NotionClient();
  const pages: ArchitecturePageDoc[] = [];
  for (const pg of manifest.context_pages ?? []) {
    const page = await notion.fetchPageMarkdown(pg.id);
    pages.push({
      id: pg.id,
      title: pg.title ?? page.title,
      markdown: page.markdown,
    });
  }
  return pages;
}

/**
 * Selects the arch_unit store's units relevant to a session: region-
 * intersected units, plus every active invariant unconditionally, plus (when
 * the session carries no file scope) the units under its topic.
 */
export function selectUnitsFromStore(
  input: Pick<SelectiveInjectionInput, 'regions' | 'topic'>,
  deps: Pick<SelectiveInjectionDeps, 'queryActiveUnits'> = {},
): ArchUnit[] {
  const queryActiveUnits = deps.queryActiveUnits ?? defaultQueryActiveUnits;
  const resolvedRegions = [
    ...(input.regions?.packages ?? []),
    ...(input.regions?.files ?? []),
  ];
  const hasRegions = resolvedRegions.length > 0;

  const selected = new Map<string, ArchUnit>();
  for (const unit of queryActiveUnits()) {
    if (unit.kind === 'invariant') {
      selected.set(unit.id, unit);
      continue;
    }
    if (hasRegions) {
      if (regionsIntersect(unit.regions, resolvedRegions)) {
        selected.set(unit.id, unit);
      }
    } else if (input.topic && unit.topic === input.topic) {
      selected.set(unit.id, unit);
    }
  }
  return [...selected.values()];
}

/**
 * The shared read primitive: resolves the per-project dual-read source, then
 * returns either the selectively-injected arch_unit store units, or (for a
 * project not yet migrated) the project's full Notion architecture page set.
 */
export async function selectArchitectureContext(
  input: SelectiveInjectionInput,
  deps: SelectiveInjectionDeps = {},
): Promise<SelectiveInjectionResult> {
  const isArchStoreAdopted =
    deps.isArchStoreAdopted ?? defaultIsArchStoreAdopted;
  if (isArchStoreAdopted(input.projectId)) {
    return { source: 'store', units: selectUnitsFromStore(input, deps) };
  }
  const fetchNotionArchitecturePages =
    deps.fetchNotionArchitecturePages ?? defaultFetchNotionArchitecturePages;
  return {
    source: 'notion',
    pages: await fetchNotionArchitecturePages(input.projectId),
  };
}
