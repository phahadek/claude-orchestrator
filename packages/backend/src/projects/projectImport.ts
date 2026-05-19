import { ProjectService } from "./ProjectService";

interface RawBoard {
  id: string;
  name?: string;
}

interface RawProjectEntry {
  id?: string;
  name?: string;
  projectDir?: string;
  contextUrl?: string;
  githubRepo?: string;
  taskSource?: "notion" | "yaml";
  boardId?: string;
  boards?: RawBoard[];
}

/**
 * One-shot migration of the PROJECTS env var into SQLite.
 * - Runs only when the projects table is empty.
 * - Returns the number of projects imported (0 if no env or table is non-empty).
 * - Logs a summary line on success.
 */
export function importProjectsFromEnv(rawEnv: string | undefined): number {
  if (ProjectService.count() > 0) return 0;
  if (!rawEnv) return 0;

  let parsed: RawProjectEntry[];
  try {
    parsed = JSON.parse(rawEnv) as RawProjectEntry[];
  } catch (err) {
    console.error("[projectImport] Failed to parse PROJECTS env var:", err);
    return 0;
  }

  if (!Array.isArray(parsed)) return 0;

  let imported = 0;
  for (const entry of parsed) {
    if (!entry.id || !entry.name || !entry.projectDir) {
      console.warn(
        "[projectImport] Skipping invalid PROJECTS entry (missing id/name/projectDir):",
        entry,
      );
      continue;
    }

    ProjectService.create({
      id: entry.id,
      name: entry.name,
      projectDir: entry.projectDir,
      contextUrl: entry.contextUrl ?? null,
      githubRepo: entry.githubRepo ?? null,
      taskSource: entry.taskSource ?? "notion",
    });

    // Build the milestone list. boards (multi) takes precedence; fall back to boardId (single).
    const milestones: { sourceId: string; name: string }[] = [];
    if (Array.isArray(entry.boards) && entry.boards.length > 0) {
      for (const b of entry.boards) {
        if (!b.id) continue;
        milestones.push({ sourceId: b.id, name: b.name ?? b.id });
      }
    } else if (entry.boardId) {
      milestones.push({ sourceId: entry.boardId, name: entry.boardId });
    }

    let order = 0;
    for (const m of milestones) {
      ProjectService.createMilestone({
        id: `${entry.id}:${m.sourceId}`,
        projectId: entry.id,
        name: m.name,
        sourceId: m.sourceId,
        displayOrder: order++,
      });
    }

    imported++;
  }

  if (imported > 0) {
    console.log(
      `[startup] Imported ${imported} project(s) from PROJECTS env. PROJECTS env can now be removed from .env.`,
    );
  }
  return imported;
}
