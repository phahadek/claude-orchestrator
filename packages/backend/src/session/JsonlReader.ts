import fs from 'fs';
import path from 'path';
import os from 'os';
import { scrubSecrets } from '../security/scrubSecrets';
import { logger } from '../logger';
import {
  getAllSessionIds,
  insertSessionOrIgnore,
  insertEventOrIgnore,
  getZeroTokenSessions,
  getEventsBySession,
  incrementTokens,
  setSessionMetadata,
} from '../db/queries';
import type { EventType, NewSession } from '../db/types';
import {
  VALID_EVENT_TYPES,
  SILENT_SKIP_TYPES,
  toEventType,
} from './eventTypes';

export { VALID_EVENT_TYPES, SILENT_SKIP_TYPES, toEventType };

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

export class JsonlReader {
  constructor(private readonly sessionsDir: string) {}

  /** Scan sessionsDir, parse all .jsonl files, upsert into SQLite. */
  async importAll(): Promise<void> {
    if (!fs.existsSync(this.sessionsDir)) {
      logger.info(`[JsonlReader] sessions dir not found: ${this.sessionsDir}`);
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

      const { events, metadata } = this.parseFile(filePath);
      if (events.length === 0 && Object.keys(metadata).length === 0) continue; // Skip empty JSONL files — they produce ghost sessions

      const session: NewSession = {
        session_id: sessionId,
        task_id: null,
        task_url: null,
        project_context_url: null,
        status: 'done',
        started_at: startedAt,
        ended_at: null,
        pr_url: null,
      };
      insertSessionOrIgnore(session);

      if (Object.keys(metadata).length > 0) {
        setSessionMetadata(sessionId, metadata);
      }

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

    logger.info(
      `[JsonlReader] imported ${newSessions} new sessions, ${newEvents} new events`,
    );
  }

  /** Parse a single .jsonl file into events and extracted session metadata. */
  parseFile(filePath: string): {
    events: RawSessionEvent[];
    metadata: Record<string, unknown>;
  } {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const events: RawSessionEvent[] = [];
    const metadata: Record<string, unknown> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        logger.warn(
          `[JsonlReader] malformed line in ${filePath} — skipping: ${trimmed.slice(0, 80)}`,
        );
        continue;
      }

      if (typeof obj.type !== 'string' || !VALID_EVENT_TYPES.has(obj.type)) {
        const truncated = trimmed.slice(0, 500);
        logger.warn(
          `[JsonlReader] unknown event type "${String(obj.type)}" in ${filePath} — skipping: ${truncated}`,
        );
        continue;
      }

      // ai-title: persist as session metadata, do not emit as an event
      if (obj.type === 'ai-title') {
        if (typeof obj.aiTitle === 'string') {
          metadata.derivedTitle = obj.aiTitle;
        }
        continue;
      }

      // Silent-skip types: known but produce no session event
      if (SILENT_SKIP_TYPES.has(obj.type)) {
        continue;
      }

      events.push({
        type: toEventType(obj.type),
        content: scrubSecrets(obj.content ?? obj.message ?? obj),
        timestamp:
          typeof obj.timestamp === 'number' ? obj.timestamp : undefined,
      });
    }

    return { events, metadata };
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
      logger.info(
        `[JsonlReader] backfilled tokens for ${backfilled} session(s)`,
      );
    }
  }
}
