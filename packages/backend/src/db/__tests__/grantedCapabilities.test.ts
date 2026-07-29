/**
 * Tests for the durable per-session granted-capabilities set: an
 * operator-approved capability (a Bash command prefix or named MCP write
 * verb) sticky for the session's life, discarded at session end. Persisted
 * on the session row so a restart mid-session doesn't lose it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  getGrantedCapabilities,
  addGrantedCapability,
  removeGrantedCapability,
} from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(sessionId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: `task:${sessionId}`,
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: 0,
    session_type: 'standard',
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
}

describe('granted capabilities', () => {
  it('a freshly-inserted session has an empty granted set', () => {
    seedSession('sess-1');
    expect(getGrantedCapabilities('sess-1')).toEqual([]);
  });

  it('adds a granted capability and it is readable back', () => {
    seedSession('sess-2');
    addGrantedCapability('sess-2', 'Bash(psql:*)');
    expect(getGrantedCapabilities('sess-2')).toEqual(['Bash(psql:*)']);
  });

  it('is idempotent — granting the same capability twice does not duplicate it', () => {
    seedSession('sess-3');
    addGrantedCapability('sess-3', 'Bash(psql:*)');
    addGrantedCapability('sess-3', 'Bash(psql:*)');
    expect(getGrantedCapabilities('sess-3')).toEqual(['Bash(psql:*)']);
  });

  it('persists to the session row and rehydrates after a simulated restart', () => {
    seedSession('sess-4');
    addGrantedCapability('sess-4', 'Bash(psql:*)');

    // Simulate a restart: read directly off the row rather than through any
    // in-memory cache, mirroring how AgentSession rehydrates on boot.
    const row = db
      .prepare('SELECT granted_capabilities FROM sessions WHERE session_id = ?')
      .get('sess-4') as { granted_capabilities: string };
    expect(JSON.parse(row.granted_capabilities)).toEqual(['Bash(psql:*)']);
    expect(getGrantedCapabilities('sess-4')).toEqual(['Bash(psql:*)']);
  });

  it('scopes grants to the specific session', () => {
    seedSession('sess-5');
    seedSession('sess-6');
    addGrantedCapability('sess-5', 'Bash(psql:*)');
    expect(getGrantedCapabilities('sess-6')).toEqual([]);
  });

  it('removes exactly the named capability, leaving others intact', () => {
    seedSession('sess-7');
    addGrantedCapability('sess-7', 'Bash(psql:*)');
    addGrantedCapability('sess-7', 'mcp__orchestrator__health');
    removeGrantedCapability('sess-7', 'Bash(psql:*)');
    expect(getGrantedCapabilities('sess-7')).toEqual([
      'mcp__orchestrator__health',
    ]);
  });

  it('is a no-op if the capability is not present', () => {
    seedSession('sess-8');
    addGrantedCapability('sess-8', 'Bash(psql:*)');
    removeGrantedCapability('sess-8', 'Bash(not-granted:*)');
    expect(getGrantedCapabilities('sess-8')).toEqual(['Bash(psql:*)']);
  });
});
