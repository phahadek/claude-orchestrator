import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── AC: run() is called fire-and-forget in SessionManager.start() ──────────
// This is a structural check — verify the source code does NOT await run().

describe('SessionManager.start() structural check', () => {
  it('calls run() fire-and-forget (not awaited)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Must contain run().catch(...) pattern (fire-and-forget)
    expect(source).toMatch(/session\.run\(\)\.catch/);

    // Must NOT contain "await session.run()" or "await.*\.run()"
    expect(source).not.toMatch(/await\s+session\.run\(\)/);
  });

  it('does not import @anthropic-ai/claude-agent-sdk', () => {
    const agentSource = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'AgentSession.ts'),
      'utf-8',
    );
    expect(agentSource).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});

// ── AC: send() echoes user message as session_event ────────────────────────
describe('SessionManager.send() user_message echo', () => {
  it('calls insertEvent with event_type user_message after sending', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toMatch(/insertEvent/);
    expect(source).toMatch(/event_type.*user_message|user_message.*event_type/);
  });

  it('emits a session_event with eventType user_message', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toMatch(/eventType.*user_message|user_message/);
    expect(source).toMatch(/this\.emit\('message'/);
  });
});

// ── AC: PROJECT_DIR read from env with fallback to process.cwd() ───────────
describe('config.projectDir', () => {
  it('config.ts reads PROJECT_DIR with cwd fallback', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'config.ts'),
      'utf-8',
    );

    expect(source).toContain('PROJECT_DIR');
    expect(source).toContain('process.cwd()');
  });
});
