import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { TaskBackend, NonMilestoneSourceConfig } from './TaskBackend';
import type { ResolvedTask } from './types';
import type { NotionTask } from '../notion/types';
import { toExternalId, formatTaskId } from './taskId';
import { DependencyResolver } from '../notion/DependencyResolver';
import { upsertTaskCache } from '../db/queries';
import { logger } from '../logger';

// ── tasks.yaml schema ────────────────────────────────────────────────────────

interface LocalTask {
  id: string;
  name: string;
  status: string; // Backlog | Ready | In Progress | In Review | Done
  priority?: string; // High | Medium | Low
  type?: string; // Code | Planning | Testing
  depends_on?: string[];
  pr_url?: string | null;
  context?: string;
  acceptance_criteria?: string;
  files_affected?: string[];
  notes?: string;
}

interface LocalMilestone {
  id: string;
  name: string;
  tasks: LocalTask[];
}

/** New milestone-keyed schema. */
interface MilestoneTasksFile {
  project?: { id: string; name?: string };
  milestones: LocalMilestone[];
}

/** Old flat schema, kept only for migration. */
interface FlatTasksFile {
  board_id?: string;
  tasks: LocalTask[];
}

type AnyTasksFile = MilestoneTasksFile | FlatTasksFile;

// ── Status mapping ───────────────────────────────────────────────────────────

const STATUS_DISPLAY: Record<string, string> = {
  Backlog: '🔲 Backlog',
  Ready: '🗂️ Ready',
  'In Progress': '🔄 In Progress',
  'In Review': '👀 In Review',
  Done: '✅ Done',
  Deferred: '⏭️ Deferred',
  Blocked: '🚫 Blocked',
};

const TYPE_DISPLAY: Record<string, string> = {
  Code: '💻 Code',
  Planning: '📋 Planning',
  Testing: '🧪 Testing',
  Design: '📐 Design',
  Tooling: '🛠️ Tooling',
  Docs: '📝 Docs',
  Assets: '🎨 Assets',
  Bug: '🐛 Bug',
};

function toDisplayStatus(status: string): string {
  return STATUS_DISPLAY[status] ?? status;
}

function toDisplayType(type: string): string {
  return TYPE_DISPLAY[type] ?? type;
}

function fromDisplayStatus(display: string): string {
  const entry = Object.entries(STATUS_DISPLAY).find(([, v]) => v === display);
  return entry ? entry[0] : display;
}

// ── Schema helpers ───────────────────────────────────────────────────────────

function isMilestoneSchema(
  parsed: AnyTasksFile | null,
): parsed is MilestoneTasksFile {
  return !!parsed && Array.isArray((parsed as MilestoneTasksFile).milestones);
}

function isFlatSchema(parsed: AnyTasksFile | null): parsed is FlatTasksFile {
  return !!parsed && Array.isArray((parsed as FlatTasksFile).tasks);
}

// ── LocalTaskBackend ─────────────────────────────────────────────────────────

const resolver = new DependencyResolver();

/**
 * File-based implementation of TaskBackend. Reads/writes task definitions from
 * `<projectDir>/tasks.yaml` using the milestone-keyed schema. Old flat-schema
 * files are auto-migrated on first read.
 *
 * All public methods accept prefixed task IDs (e.g. 'yaml:my-task') and strip
 * the prefix before operating on the file.
 */
export class LocalTaskBackend implements TaskBackend {
  readonly type = 'local' as const;

  constructor(private readonly projectDir: string) {}

  private get filePath(): string {
    return path.join(this.projectDir, 'tasks.yaml');
  }

  /** Read tasks.yaml, migrating old flat schema to milestone schema if needed. */
  private readFile(): MilestoneTasksFile {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(
        `[LocalTaskBackend] tasks.yaml not found at ${this.filePath}`,
      );
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const parsed = yaml.load(raw) as AnyTasksFile | null;

    if (isMilestoneSchema(parsed)) {
      return parsed;
    }

    if (isFlatSchema(parsed)) {
      const migrated = this.migrateFlatToMilestones(parsed);
      this.writeFile(migrated);
      logger.info(
        `[LocalTaskBackend] Migrated ${this.filePath} to milestone schema.`,
      );
      return migrated;
    }

    throw new Error(
      `[LocalTaskBackend] tasks.yaml at ${this.filePath} is missing both 'milestones' and 'tasks' keys`,
    );
  }

  /** Wrap a flat-schema file's tasks under a single milestone. */
  private migrateFlatToMilestones(flat: FlatTasksFile): MilestoneTasksFile {
    const id =
      flat.board_id && flat.board_id !== 'default' ? flat.board_id : 'm1';
    const name =
      flat.board_id && flat.board_id !== 'default' ? flat.board_id : 'Default';
    return {
      milestones: [{ id, name, tasks: flat.tasks ?? [] }],
    };
  }

  private writeFile(file: MilestoneTasksFile): void {
    fs.writeFileSync(
      this.filePath,
      yaml.dump(file, { lineWidth: 120 }),
      'utf-8',
    );
  }

  private mapToNotionTask(t: LocalTask): NotionTask {
    return {
      id: t.id,
      title: t.name,
      status: toDisplayStatus(t.status),
      type: toDisplayType(t.type ?? 'Code'),
      dependsOn: t.depends_on ?? [],
      notionUrl: '',
      prUrl: t.pr_url ?? undefined,
      priority: t.priority,
    };
  }

  /** Locate the milestone containing a given raw task id (no prefix), or undefined. */
  private findTaskById(
    file: MilestoneTasksFile,
    rawTaskId: string,
  ): { milestone: LocalMilestone; task: LocalTask } | undefined {
    for (const m of file.milestones) {
      const task = m.tasks.find((t) => t.id === rawTaskId);
      if (task) return { milestone: m, task };
    }
    return undefined;
  }

  async fetchReadyTasks(
    milestoneId: string | null,
    _skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    const file = this.readFile();
    let allTasks: NotionTask[];
    if (milestoneId === null) {
      allTasks = file.milestones.flatMap((m) =>
        m.tasks.map((t) => this.mapToNotionTask(t)),
      );
    } else {
      const milestone = file.milestones.find((m) => m.id === milestoneId);
      if (!milestone) {
        throw new Error(
          `[LocalTaskBackend] milestone not found in ${this.filePath}: ${milestoneId}`,
        );
      }
      allTasks = milestone.tasks.map((t) => this.mapToNotionTask(t));
    }
    const resolved = resolver.resolve(allTasks, 'yaml');
    // Prepend yaml: prefix to task IDs and dependsOn in returned results
    const prefixed = resolved.map((r) => ({
      ...r,
      task: {
        ...r.task,
        id: formatTaskId('yaml', r.task.id),
        dependsOn: r.task.dependsOn.map((dep) => formatTaskId('yaml', dep)),
      },
    }));
    // Cache each task under its prefixed key with prefixed-everywhere shape
    for (const r of prefixed) {
      upsertTaskCache(r.task.id, JSON.stringify(r.task));
    }
    // Overwrite board cache with prefixed IDs so /api/tasks/active joins correctly.
    if (milestoneId !== null) {
      upsertTaskCache(
        `board:${milestoneId}`,
        JSON.stringify(prefixed.map((r) => r.task)),
      );
    }
    return prefixed;
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const file = this.readFile();
    const found = this.findTaskById(file, externalId);
    if (!found) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    found.task.pr_url = prUrl;
    this.writeFile(file);
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const file = this.readFile();
    const found = this.findTaskById(file, externalId);
    if (!found) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    found.task.status = fromDisplayStatus(status);
    this.writeFile(file);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const externalId = toExternalId(taskId);
    const file = this.readFile();
    const found = this.findTaskById(file, externalId);
    if (!found) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    const task = found.task;

    const sections: string[] = [`# ${task.name}`];
    if (task.context?.trim()) {
      sections.push(`## Context\n${task.context.trim()}`);
    }
    if (task.acceptance_criteria?.trim()) {
      sections.push(
        `## Acceptance Criteria\n${task.acceptance_criteria.trim()}`,
      );
    }
    if (task.files_affected && task.files_affected.length > 0) {
      sections.push(
        `## Files\n${task.files_affected.map((f) => `- ${f}`).join('\n')}`,
      );
    }
    if (task.notes?.trim()) {
      sections.push(`## Notes\n${task.notes.trim()}`);
    }
    return sections.join('\n\n');
  }

  async fetchNonMilestoneReadyTasks(
    sourceConfig: NonMilestoneSourceConfig | null,
    projectId?: string,
  ): Promise<ResolvedTask[]> {
    if (!sourceConfig?.milestoneId) return [];
    const results = await this.fetchReadyTasks(sourceConfig.milestoneId);
    if (projectId) {
      upsertTaskCache(
        `non_milestone:${projectId}`,
        JSON.stringify(results.map((r) => r.task)),
      );
    }
    return results;
  }

  async listTasksByStatus(status: string): Promise<ResolvedTask[]> {
    const file = this.readFile();
    const matching = file.milestones
      .flatMap((m) => m.tasks)
      .filter((t) => toDisplayStatus(t.status) === status)
      .map((t) => this.mapToNotionTask(t));
    const resolved = resolver.resolve(matching, 'yaml');
    return resolved.map((r) => ({
      ...r,
      task: {
        ...r.task,
        id: formatTaskId('yaml', r.task.id),
        dependsOn: r.task.dependsOn.map((dep) => formatTaskId('yaml', dep)),
      },
    }));
  }

  async updateNotes(taskId: string, notes: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const file = this.readFile();
    const found = this.findTaskById(file, externalId);
    if (!found) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    found.task.notes = notes;
    this.writeFile(file);
  }

  async appendImplementationNote(taskId: string, note: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const file = this.readFile();
    const found = this.findTaskById(file, externalId);
    if (!found) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    const existing = found.task.notes ?? '';
    found.task.notes = existing ? `${existing}\n${note}` : note;
    this.writeFile(file);
  }
}
