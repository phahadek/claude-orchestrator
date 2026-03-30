import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getAllSessionIds,
  insertSessionOrIgnore,
  insertEventOrIgnore,
} from '../db/queries';
import type { EventType, NewSession } from '../db/types';

export interface RawSessionEvent {
  type: EventType;
  content: unknown;
  timestamp?: number;
}

export const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'projects');

const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'tool_use',
  'tool_result',
  'system',
  'error',
]);

export class JsonlReader {
  constructor(private readonly sessionsDir: string) {}

  /** Scan sessionsDir, parse all .jsonl files, upsert into SQLite. */
  async importAll(): Promise<void> {
    if (!fs.existsSync(this.sessionsDir)) {
      console.log(`[JsonlReader] sessions dir not found: ${this.sessionsDir}`);
      return;
    }

    const known = new Set(this.knownSessionIds());

    const files = fs
      .readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.jsonl'));

    let newSessions = 0;
    let newEvents = 0;

    for (const file of files) {
      const sessionId = path.basename(file, '.jsonl');
      if (known.has(sessionId)) continue;

      const filePath = path.join(this.sessionsDir, file);
      const stat = fs.statSync(filePath);
      const startedAt = stat.birthtimeMs || stat.mtimeMs;

      const session: NewSession = {
        session_id: sessionId,
        notion_task_id: null,
        notion_task_url: null,
        project_context_url: null,
        status: 'done',
        started_at: startedAt,
        ended_at: null,
        pr_url: null,
      };
      insertSessionOrIgnore(session);

      const events = this.parseFile(filePath);
      for (const ev of events) {
        insertEventOrIgnore({
          session_id: sessionId,
          event_type: ev.type,
          payload: JSON.stringify(ev.content),
          timestamp: ev.timestamp ?? startedAt,
        });
        newEvents++;
      }
      newSessions++;
    }

    console.log(
      `[JsonlReader] imported ${newSessions} new sessions, ${newEvents} new events`,
    );
  }

  /** Parse a single .jsonl file into an array of raw events. */
  parseFile(filePath: string): RawSessionEvent[] {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const events: RawSessionEvent[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        console.warn(
          `[JsonlReader] malformed line in ${filePath} — skipping: ${trimmed.slice(0, 80)}`,
        );
        continue;
      }

      if (typeof obj.type !== 'string' || !VALID_EVENT_TYPES.has(obj.type)) {
        console.warn(
          `[JsonlReader] unknown event type "${String(obj.type)}" in ${filePath} — skipping`,
        );
        continue;
      }

      events.push({
        type: obj.type as EventType,
        content: obj.content,
        timestamp:
          typeof obj.timestamp === 'number' ? obj.timestamp : undefined,
      });
    }

    return events;
  }

  /** Return list of session IDs (filenames) already known in SQLite. */
  knownSessionIds(): string[] {
    return getAllSessionIds();
  }
}
