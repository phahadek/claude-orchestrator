import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getAllSessionIds,
  insertSessionOrIgnore,
  insertEventOrIgnore,
  getZeroTokenSessions,
  getEventsBySession,
  incrementTokens,
} from '../db/queries';
import type { EventType, NewSession } from '../db/types';

export interface RawSessionEvent {
  type: EventType;
  content: unknown;
  timestamp?: number;
}

export const DEFAULT_SESSIONS_DIR = path.join(
  os.homedir(),
  '.claude',
  'projects',
);

// Includes both our internal types and the real types emitted by the Claude CLI.
const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'tool_use',
  'tool_result',
  'system',
  'error',
  // Real Claude CLI event types
  'user',
  'assistant',
  'message',
  'file-history-snapshot',
  'result',
]);

/** Map raw Claude CLI event type strings to our internal EventType union. */
function toEventType(raw: string): EventType {
  switch (raw) {
    case 'assistant':
    case 'text':
    case 'message':
      return 'text';
    case 'tool_use':
      return 'tool_use';
    case 'tool_result':
      return 'tool_result';
    case 'system':
    case 'user':
    case 'file-history-snapshot':
      return 'system';
    case 'error':
      return 'error';
    default:
      return 'system';
  }
}

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

      const events = this.parseFile(filePath);
      if (events.length === 0) continue; // Skip empty JSONL files — they produce ghost sessions

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
        type: toEventType(obj.type),
        content: obj.content ?? obj.message ?? obj,
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

  /**
   * Backfill token counts for sessions that were imported without token data.
   * Processes up to 100 sessions per call to bound startup time.
   * Skips sessions where no events contain usage data (genuinely zero-token sessions).
   */
  backfillTokens(): void {
    const sessions = getZeroTokenSessions(100);
    let backfilled = 0;

    for (const session of sessions) {
      const events = getEventsBySession(session.session_id);
      let totalInput = 0;
      let totalOutput = 0;
      let foundResultEvent = false;

      // First pass: look for result events which contain session-total usage.
      for (const event of events) {
        try {
          const payload = JSON.parse(event.payload) as Record<string, unknown>;
          if (payload.type === 'result') {
            const usage = payload.usage as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            if (usage) {
              totalInput = usage.input_tokens ?? 0;
              totalOutput = usage.output_tokens ?? 0;
              foundResultEvent = true;
              break;
            }
          }
        } catch {
          /* ignore malformed payloads */
        }
      }

      // Second pass: if no result event, sum usage from all events (e.g. assistant message events).
      if (!foundResultEvent) {
        for (const event of events) {
          try {
            const payload = JSON.parse(event.payload) as Record<
              string,
              unknown
            >;
            const usage = payload.usage as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            if (usage) {
              totalInput += usage.input_tokens ?? 0;
              totalOutput += usage.output_tokens ?? 0;
            }
          } catch {
            /* ignore malformed payloads */
          }
        }
      }

      if (totalInput > 0 || totalOutput > 0) {
        incrementTokens(session.session_id, totalInput, totalOutput);
        backfilled++;
      }
    }

    if (backfilled > 0) {
      console.log(
        `[JsonlReader] backfilled tokens for ${backfilled} session(s)`,
      );
    }
  }
}
