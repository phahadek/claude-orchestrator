import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { normalizePath } from '../config';

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

// ── AC: sendOrResume() calls send() directly when session is live ────────────
describe('SessionManager.sendOrResume()', () => {
  it('calls send() directly when session is live in the sessions map', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Must contain sendOrResume method
    expect(source).toMatch(/sendOrResume\s*\(/);

    // When live: delegates to send()
    expect(source).toMatch(/this\.sessions\.has\(sessionId\)/);
    expect(source).toMatch(/this\.send\(sessionId,\s*text\)/);
  });

  it('creates a new AgentSession with resumeSessionId when session is not live', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Must look up original session from DB
    expect(source).toMatch(/getSession\(sessionId\)/);

    // Must create AgentSession with sessionId as resumeSessionId
    expect(source).toMatch(/new AgentSession/);
    expect(source).toMatch(/resumeSessionId|sessionId,\s*\/\/\s*resumeSessionId/);
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

// ── AC: SessionManager.start() accepts sessionType and customPrompt options ─
describe('SessionManager.start() — StartOptions', () => {
  it('accepts sessionType and customPrompt in options', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    expect(source).toMatch(/StartOptions/);
    expect(source).toMatch(/sessionType/);
    expect(source).toMatch(/customPrompt/);
  });

  it('passes session_type to insertSession', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    expect(source).toMatch(/session_type.*sessionType|sessionType.*session_type/);
    expect(source).toMatch(/insertSession/);
  });

  it('includes sessionType in session_started broadcast', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    expect(source).toMatch(/sessionType/);
    expect(source).toMatch(/session_started/);
  });
});

// ── AC: normalizePath converts Git Bash paths to Windows-native ─────────────
describe('normalizePath()', () => {
  it('converts /c/Users/... to C:/Users/... on Windows, no-op on other platforms', () => {
    if (process.platform === 'win32') {
      expect(normalizePath('/c/Users/phadek/foo')).toBe('C:/Users/phadek/foo');
      expect(normalizePath('/D/projects/bar')).toBe('D:/projects/bar');
      expect(normalizePath('C:/Users/phadek/foo')).toBe('C:/Users/phadek/foo');
      expect(normalizePath('/usr/local/bin')).toBe('/usr/local/bin');
    } else {
      expect(normalizePath('/c/Users/phadek/foo')).toBe('/c/Users/phadek/foo');
      expect(normalizePath('/usr/local/bin')).toBe('/usr/local/bin');
    }
  });

  it('SessionManager uses normalizePath on project.projectDir before constructing worktreePath', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    expect(source).toContain('normalizePath');
    // normalizePath is applied to project.projectDir to produce a local projectDir variable
    expect(source).toMatch(/normalizePath\s*\(\s*project\.projectDir\s*\)/);
    // worktreePath is constructed from the normalized projectDir
    expect(source).toMatch(/path\.join\s*\(\s*projectDir\s*,/);
  });

  it('worktreePath passed to AgentSession is built from a Windows-native projectDir', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Must NOT pass project.projectDir directly to path.join
    expect(source).not.toMatch(/path\.join\s*\(\s*project\.projectDir\s*,/);
    // Must pass normalized projectDir instead
    expect(source).toMatch(/const\s+projectDir\s*=\s*normalizePath\s*\(\s*project\.projectDir\s*\)/);
  });
});

// ── AC: runMigrations() adds session_type column idempotently ───────────────
describe('runMigrations() — session_type column', () => {
  it('adds session_type column via idempotent try/catch pattern', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );

    expect(source).toContain('session_type');
    expect(source).toMatch(/try\s*\{[^}]*session_type[^}]*\}\s*catch/s);
  });
});
