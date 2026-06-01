import type { ServerMessage } from './types';
import { scrubSecrets } from '../security/scrubSecrets';
import {
  getActiveSessions,
  getEventsBySession,
  getDenialsBySession,
  getPRByNotionTaskId,
} from '../db/queries';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';

/**
 * Send the current persistent state of all active sessions to a freshly
 * connected client. Every session_status message in the burst carries
 * `replay: true` so the frontend can suppress notification firing — without
 * the flag, a backend restart re-fires notifications for every historical
 * non-archived session in done/error state.
 */
export function sendInitialStateBurst(
  send: (msg: ServerMessage) => void,
): void {
  for (const s of getActiveSessions()) {
    const tags = s.tags
      ? (() => {
          try {
            return JSON.parse(s.tags) as string[];
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const reviewPr =
      s.session_type === 'review' && s.task_id
        ? (getPRByNotionTaskId(s.task_id) ?? undefined)
        : undefined;
    const prNumber = reviewPr?.pr_number;
    const codeSessionId = reviewPr?.session_id ?? undefined;
    send({
      type: 'session_started',
      sessionId: s.session_id,
      taskName: s.task_name ?? s.task_url ?? s.session_id.slice(0, 8),
      notionTaskUrl: s.task_url ?? '',
      ...(s.started_at != null && { started_at: s.started_at }),
      ...(s.ended_at != null && { ended_at: s.ended_at }),
      archived: s.archived === 1,
      favorited: s.favorited === 1,
      project_id: s.project_id,
      sessionType: s.session_type,
      ...(prNumber != null && { prNumber }),
      ...(codeSessionId != null && { codeSessionId }),
      note: s.note ?? null,
      tags,
      totalInputTokens: s.total_input_tokens ?? 0,
      totalOutputTokens: s.total_output_tokens ?? 0,
      model: s.model ?? null,
      ...(s.pr_url != null && { prUrl: s.pr_url }),
      ...(s.task_id != null && { taskId: s.task_id }),
    });
    send({
      type: 'session_status',
      sessionId: s.session_id,
      status: s.status,
      replay: true,
    });

    // Send stored events so the transcript populates.
    // Skip user events that contain only system-injected content — they are
    // stored in the DB for debugging but are noise in the transcript UI.
    for (const ev of getEventsBySession(s.session_id)) {
      if (isSystemOnlyUserEvent(ev.payload)) continue;
      send({
        type: 'session_event',
        sessionId: s.session_id,
        eventType: ev.event_type as
          | 'text'
          | 'tool_use'
          | 'tool_result'
          | 'system'
          | 'user_message',
        content: scrubSecrets(ev.payload),
        ...(ev.message_id != null && { messageId: ev.message_id }),
      });
    }

    // Send stored permission denials so SessionDetail shows them after reconnect
    const denials = getDenialsBySession(s.session_id);
    if (denials.length > 0) {
      send({
        type: 'permission_denials',
        sessionId: s.session_id,
        denials: denials.map((d) => ({
          tool_name: d.tool_name,
          tool_use_id: d.tool_use_id,
          tool_input: JSON.parse(d.tool_input) as Record<string, unknown>,
        })),
      });
    }
  }
}
