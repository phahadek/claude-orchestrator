import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { normalizePath } from '../config';

// ── AC: sendOrResume reconciles zombie rows before respawning ─────────────────
describe('SessionManager.sendOrResume() — zombie reconciliation', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('imports markSessionSuperseded from db/queries', () => {
    expect(source).toMatch(/markSessionSuperseded/);
    expect(source).toMatch(
      /import[\s\S]*markSessionSuperseded[\s\S]*from.*queries/,
    );
  });

  it('imports getOtherRunningSessionsForTask from db/queries', () => {
    expect(source).toMatch(/getOtherRunningSessionsForTask/);
    expect(source).toMatch(
      /import[\s\S]*getOtherRunningSessionsForTask[\s\S]*from.*queries/,
    );
  });

  it('calls getOtherRunningSessionsForTask in _doSendOrResume', () => {
    const doResumeIdx = source.indexOf('_doSendOrResume');
    const shutdownIdx = source.indexOf('async shutdownAll');
    const block = source.slice(doResumeIdx, shutdownIdx);
    expect(block).toMatch(/getOtherRunningSessionsForTask\s*\(\s*row\.task_id/);
  });

  it('calls markSessionSuperseded for each stale session found', () => {
    const doResumeIdx = source.indexOf('_doSendOrResume');
    const shutdownIdx = source.indexOf('async shutdownAll');
    const block = source.slice(doResumeIdx, shutdownIdx);
    expect(block).toMatch(/markSessionSuperseded\s*\(/);
  });

  it('reconciliation is guarded on row.task_id being present', () => {
    const doResumeIdx = source.indexOf('_doSendOrResume');
    const shutdownIdx = source.indexOf('async shutdownAll');
    const block = source.slice(doResumeIdx, shutdownIdx);
    expect(block).toMatch(/if\s*\(\s*row\.task_id\s*\)/);
  });
});

// ── AC: resumeSession re-pins the system-prompt file for the dispatched task ───
describe('SessionManager.resumeSession() — task re-pin on resume', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('calls _buildAndWriteResumeSystemPrompt in resumeSession to re-pin the task', () => {
    const resumeIdx = source.indexOf('private async resumeSession(');
    const resumeOrphanIdx = source.indexOf('resumeOrphanSessions', resumeIdx);
    const block = source.slice(resumeIdx, resumeOrphanIdx);
    expect(block).toMatch(/_buildAndWriteResumeSystemPrompt\s*\(/);
  });

  it('does NOT call injectContextFile("CLAUDE.md", ...) — worktree is not written', () => {
    expect(source).not.toMatch(/injectContextFile\s*\(\s*['"]CLAUDE\.md['"]/);
  });

  it('_buildAndWriteResumeSystemPrompt calls buildSessionContext to assemble context', () => {
    const helperIdx = source.indexOf(
      'private async _buildAndWriteResumeSystemPrompt(',
    );
    const resumeIdx = source.indexOf('private async resumeSession(', helperIdx);
    const block = source.slice(helperIdx, resumeIdx);
    expect(block).toMatch(/buildSessionContext\s*\(/);
  });

  it('re-pin is guarded on CLI session mode', () => {
    const resumeIdx = source.indexOf('private async resumeSession(');
    const resumeOrphanIdx = source.indexOf('resumeOrphanSessions', resumeIdx);
    const block = source.slice(resumeIdx, resumeOrphanIdx);
    expect(block).toMatch(/=== 'cli'/);
  });

  it('_buildAndWriteResumeSystemPrompt attempts to pre-fetch task content', () => {
    const helperIdx = source.indexOf(
      'private async _buildAndWriteResumeSystemPrompt(',
    );
    const resumeIdx = source.indexOf('private async resumeSession(', helperIdx);
    const block = source.slice(helperIdx, resumeIdx);
    expect(block).toMatch(/fetchTaskPage/);
  });

  it('_buildAndWriteResumeSystemPrompt calls writeSystemPromptFile', () => {
    const helperIdx = source.indexOf(
      'private async _buildAndWriteResumeSystemPrompt(',
    );
    const resumeIdx = source.indexOf('private async resumeSession(', helperIdx);
    const block = source.slice(helperIdx, resumeIdx);
    expect(block).toMatch(/writeSystemPromptFile\s*\(/);
  });
});

// ── AC: wireSession() — PR-attribution guard ───────────────────────────────────
describe('SessionManager.wireSession() — PR-attribution guard', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('checks session.taskId against the PR task in the pr_opened listener', () => {
    const wireIdx = source.indexOf('private wireSession(');
    // wireSession ends at the next private method
    const endIdx = source.indexOf('\n  private ', wireIdx + 1);
    const block = source.slice(wireIdx, endIdx > -1 ? endIdx : wireIdx + 3000);
    expect(block).toMatch(/session\.taskId/);
    expect(block).toMatch(/pr_attribution_mismatch|PR attribution mismatch/);
  });

  it('still emits pr_opened even when a mismatch is detected (non-blocking guard)', () => {
    const wireIdx = source.indexOf('private wireSession(');
    const endIdx = source.indexOf('\n  private ', wireIdx + 1);
    const block = source.slice(wireIdx, endIdx > -1 ? endIdx : wireIdx + 3000);
    expect(block).toMatch(/this\.emit\s*\(\s*['"]pr_opened['"]/);
  });

  it('records a pr_attribution_mismatch audit event on mismatch', () => {
    const wireIdx = source.indexOf('private wireSession(');
    const endIdx = source.indexOf('\n  private ', wireIdx + 1);
    const block = source.slice(wireIdx, endIdx > -1 ? endIdx : wireIdx + 3000);
    expect(block).toMatch(/recordEvent/);
    expect(block).toMatch(/pr_attribution_mismatch/);
  });
});

// ── AC: orchestrator-claudemd.ts — board-discovery instruction removed ─────────
describe('orchestrator-claudemd.ts — no board-discovery instruction', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'orchestrator-claudemd.ts'),
    'utf-8',
  );

  it('includes an explicit guard against self-assigning from the board', () => {
    expect(source).toMatch(/self.assign|do not.*browse|browse.*board/i);
  });

  it('warns that the session should stop and wait when no work remains', () => {
    expect(source).toMatch(/no remaining work.*stop|stop.*wait/i);
  });

  it('does not instruct sessions to search the board for a task to do', () => {
    // The lifecycle section must not contain open-ended board-search instructions
    expect(source).not.toMatch(/fetch.*board.*task|search.*board.*for.*task/i);
  });
});

// ── AC: queries.ts — markSessionSuperseded and getOtherRunningSessionsForTask ──
describe('queries.ts — supersession support', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'queries.ts'),
    'utf-8',
  );

  it('exports markSessionSuperseded function', () => {
    expect(source).toMatch(/export function markSessionSuperseded/);
  });

  it('markSessionSuperseded sets status to superseded', () => {
    const fnIdx = source.indexOf('export function markSessionSuperseded');
    const fnEnd = source.indexOf('\n}', fnIdx);
    const block = source.slice(fnIdx, fnEnd + 2);
    expect(block).toMatch(/[Ss]uperseded/);
  });

  it('exports getOtherRunningSessionsForTask function', () => {
    expect(source).toMatch(/export function getOtherRunningSessionsForTask/);
  });

  it('getOtherRunningSessionsForTask excludes the given session_id', () => {
    const fnIdx = source.indexOf(
      'export function getOtherRunningSessionsForTask',
    );
    const fnEnd = source.indexOf('\n}', fnIdx);
    const block = source.slice(fnIdx, fnEnd + 2);
    expect(block).toMatch(/session_id\s*!=|session_id.*!=|exclude/);
  });

  it('hasActiveSessionForTask excludes superseded sessions', () => {
    const fnIdx = source.indexOf('export function hasActiveSessionForTask');
    const fnEnd = source.indexOf('\n}', fnIdx);
    const block = source.slice(fnIdx, fnEnd + 2);
    expect(block).toMatch(/superseded/);
  });
});

// ── AC: SessionManager.start() updates task status to In Progress ──────────
describe('SessionManager.start() — In Progress status', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('routes updateStatus through getTaskBackend(projectId) for In Progress', () => {
    // Must call getTaskBackend(projectId).updateStatus(sessionTaskId, '🔄 In Progress', ...)
    expect(source).toMatch(
      /getTaskBackend\(projectId\)\s*\.updateStatus\s*\(\s*sessionTaskId\s*,\s*'🔄 In Progress'/,
    );
  });

  it('In Progress call is fire-and-forget with .catch() error handler', () => {
    expect(source).toMatch(
      /getTaskBackend\(projectId\)\s*\.updateStatus\s*\(\s*sessionTaskId\s*,\s*'🔄 In Progress'[\s\S]*?\.catch\b/,
    );
  });

  it('In Progress call is gated on sessionType === standard', () => {
    expect(source).toMatch(/sessionType\s*===\s*'standard'/);
    const gateIdx = source.indexOf("sessionType === 'standard'");
    const inProgressIdx = source.indexOf(
      "updateStatus(sessionTaskId, '🔄 In Progress'",
    );
    expect(inProgressIdx).toBeGreaterThan(gateIdx);
  });
});

// ── AC: SessionManager.start() — code-only session limit ────────────────────
describe('SessionManager.start() — code-only session limit', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('code session is rejected when code session count reaches the limit', () => {
    // Must check config.maxConcurrentCodeSessions for non-review sessions
    expect(source).toMatch(/config\.maxConcurrentCodeSessions/);
    // Error message references maxConcurrentCodeSessions
    expect(source).toMatch(/Max concurrent code sessions/);
  });

  it('review session bypasses the cap check entirely', () => {
    // The limit check must be gated on sessionType !== review
    expect(source).toMatch(/sessionType\s*!==\s*'review'/);
    // The cap check block is inside the sessionType !== review guard
    const guardIdx = source.indexOf("sessionType !== 'review'");
    const capCheckIdx = source.indexOf('maxConcurrentCodeSessions');
    expect(capCheckIdx).toBeGreaterThan(guardIdx);
  });

  it('counts only non-review sessions against the cap', () => {
    // getLiveCodeSessionCount() must exclude review sessions from the count
    expect(source).toMatch(/getLiveCodeSessionCount/);
    const countFnIdx = source.indexOf('getLiveCodeSessionCount()');
    const countFnBody = source.slice(countFnIdx, countFnIdx + 400);
    expect(countFnBody).toMatch(/sessionType\s*!==\s*'review'/);
  });
});

// ── AC: run() is called fire-and-forget in SessionManager.start() ──────────
// This is a structural check — verify the source code does NOT await run().

describe('SessionManager.start() structural check', () => {
  it('calls run() fire-and-forget (not awaited)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Must contain a .catch() handler (directly or via .then().catch()) to guard against unhandled rejections
    expect(source).toMatch(/\.run\(\)/);
    expect(source).toMatch(/\.catch\s*\(\s*\(err\)/);

    // Must NOT contain "await session.run()"
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

// ── AC: start() is fire-and-forget — structural checks ───────────────────────

describe('SessionManager.start() fire-and-forget structural checks', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('dispatches completeStart as fire-and-forget (void + .catch)', () => {
    expect(source).toMatch(/void\s+this\.completeStart\s*\(/);
    expect(source).toMatch(
      /completeStart[\s\S]*?\.catch\s*\(\s*async\s*\(\s*err\s*\)/,
    );
  });

  it('has cleanupPartialWorktree method', () => {
    expect(source).toMatch(
      /private\s+async\s+cleanupPartialWorktree\s*\(\s*sessionId/,
    );
  });

  it('calls cleanupPartialWorktree inside the completeStart catch handler', () => {
    const catchIdx = source.indexOf('completeStart(');
    const endIdx = source.indexOf('\n  }', catchIdx + 100);
    const block = source.slice(catchIdx, endIdx);
    expect(block).toMatch(/cleanupPartialWorktree\s*\(\s*sessionId\s*\)/);
  });

  it('calls markSessionErrored with launch_failed inside completeStart catch', () => {
    const catchIdx = source.indexOf('completeStart(');
    const endIdx = source.indexOf('\n  }', catchIdx + 100);
    const block = source.slice(catchIdx, endIdx);
    expect(block).toMatch(
      /markSessionErrored\s*\(\s*sessionId\s*,\s*'error'\s*,\s*'launch_failed'\s*\)/,
    );
  });

  it('broadcasts session_starting (not session_started) from start()', () => {
    const startIdx = source.indexOf('async start(');
    const completeStartIdx = source.indexOf('private async completeStart(');
    const startBody = source.slice(startIdx, completeStartIdx);
    expect(startBody).toMatch(/type:\s*'session_starting'/);
    expect(startBody).not.toMatch(/type:\s*'session_started'/);
  });

  it('broadcasts session_started from completeStart (not start)', () => {
    const completeStartIdx = source.indexOf('private async completeStart(');
    const cleanupIdx = source.indexOf('private async cleanupPartialWorktree(');
    const completeBody = source.slice(completeStartIdx, cleanupIdx);
    expect(completeBody).toMatch(/type:\s*'session_started'/);
  });

  it('insertSession is called inside start() before void completeStart', () => {
    const startIdx = source.indexOf('async start(');
    const completeStartIdx = source.indexOf('private async completeStart(');
    const startBody = source.slice(startIdx, completeStartIdx);
    const insertIdx = startBody.indexOf('insertSession(');
    const voidCompleteIdx = startBody.indexOf('void this.completeStart(');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(voidCompleteIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeLessThan(voidCompleteIdx);
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
    expect(source).toMatch(
      /resumeSessionId|sessionId,\s*\/\/\s*resumeSessionId/,
    );
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

    expect(source).toMatch(
      /session_type.*sessionType|sessionType.*session_type/,
    );
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

  it('includes totalInputTokens and totalOutputTokens in session_started message', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Find the session_started broadcast block and verify token fields are present
    const sessionStartedBlock = source.match(
      /type:\s*['"]session_started['"][\s\S]*?satisfies ServerMessage/,
    );
    expect(sessionStartedBlock).not.toBeNull();
    expect(sessionStartedBlock![0]).toMatch(/totalInputTokens/);
    expect(sessionStartedBlock![0]).toMatch(/totalOutputTokens/);
  });
});

// ── AC: normalizePath converts Git Bash paths to Windows-native ─────────────
describe('normalizePath()', () => {
  it('converts /c/Users/... to C:/Users/... on Windows, no-op on other platforms', () => {
    if (process.platform === 'win32') {
      expect(normalizePath('/c/Users/testuser/foo')).toBe(
        'C:/Users/testuser/foo',
      );
      expect(normalizePath('/D/projects/bar')).toBe('D:/projects/bar');
      expect(normalizePath('C:/Users/testuser/foo')).toBe(
        'C:/Users/testuser/foo',
      );
      expect(normalizePath('/usr/local/bin')).toBe('/usr/local/bin');
    } else {
      expect(normalizePath('/c/Users/testuser/foo')).toBe(
        '/c/Users/testuser/foo',
      );
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
    expect(source).toMatch(
      /const\s+projectDir\s*=\s*normalizePath\s*\(\s*project\.projectDir\s*\)/,
    );
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

// ── AC: resumeOrphanSessions() — structural checks ──────────────────────────
describe('SessionManager.resumeOrphanSessions()', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('queries DB for sessions with status "running"', () => {
    expect(source).toMatch(
      /getSessionsByStatus\s*\(\s*\[['"]running['"]\]\s*\)/,
    );
  });

  it('calls resumeSession() for each orphan in a loop', () => {
    // Must iterate over orphans and call resumeSession
    expect(source).toMatch(/resumeSession\s*\(\s*row\s*\)/);
    expect(source).toMatch(/for\s*\(.*of\s+toResume/);
  });

  it('marks sessions as error when resume fails (catch block)', () => {
    expect(source).toMatch(
      /markSessionErrored\s*\(\s*row\.session_id\s*,\s*'error'\s*,\s*'resume_failed'\s*\)/,
    );
  });

  it('respects maxConcurrentCodeSessions — slices code orphans into toResume and toError', () => {
    expect(source).toMatch(
      /config\.maxConcurrentCodeSessions\s*-\s*codeSessionCount/,
    );
    expect(source).toMatch(/codeOrphans\.slice\s*\(\s*0\s*,\s*available\s*\)/);
    expect(source).toMatch(/codeOrphans\.slice\s*\(\s*available\s*\)/);
  });

  it('logs a warning and marks excess code orphans as error when limit is exceeded', () => {
    expect(source).toMatch(/for\s*\(.*of\s+toError/);
    expect(source).toMatch(/marking orphan.*as error/);
  });

  it('always resumes review orphans regardless of code session count', () => {
    // review orphans are separated from code orphans and always included in toResume
    expect(source).toMatch(/reviewOrphans\s*=\s*orphans\.filter/);
    expect(source).toMatch(/codeOrphans\s*=\s*orphans\.filter/);
    expect(source).toMatch(/\[\.\.\.reviewOrphans,\s*\.\.\.codeOrphans\.slice/);
  });
});

// ── AC: wireSession() is used by both start() and resumeSession() ─────────────
describe('SessionManager.wireSession()', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('wireSession() method exists', () => {
    expect(source).toMatch(/private\s+wireSession\s*\(/);
  });

  it('start() delegates to wireSession()', () => {
    // The start() method must call this.wireSession(...)
    expect(source).toMatch(/this\.wireSession\s*\(/);
  });

  it('resumeSession() delegates to wireSession()', () => {
    // resumeSession must also call this.wireSession(...)
    // Verified by checking wireSession appears at least twice as a call site
    const callSites = [...source.matchAll(/this\.wireSession\s*\(/g)];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
  });

  it('wireSession() wires session.on("message") forwarding', () => {
    expect(source).toMatch(/session\.on\s*\(\s*'message'/);
  });

  it('wireSession() calls session.run() fire-and-forget', () => {
    // run() is called and has a .catch() handler (via .then().catch() chain)
    expect(source).toMatch(/\.run\(\)/);
    expect(source).toMatch(/\.catch\s*\(\s*\(err\)/);
    expect(source).not.toMatch(/await\s+session\.run\(\)/);
  });
});

// ── AC: resumeSession() keeps original session_id ────────────────────────────
describe('SessionManager.resumeSession()', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('passes row.session_id as both sessionId and resumeSessionId to AgentSession', () => {
    // The first arg to AgentSession must be row.session_id (keep original ID)
    expect(source).toMatch(/new AgentSession\s*\(\s*row\.session_id/s);
    // And row.session_id is also passed as resumeSessionId
    expect(source).toMatch(
      /row\.session_id,\s*\/\/\s*resumeSessionId|resumeSessionId.*row\.session_id/s,
    );
  });

  it('broadcasts session_status: running after re-attaching', () => {
    expect(source).toMatch(/session_status.*running|running.*session_status/);
    expect(source).toMatch(
      /row\.session_id.*status.*running|status.*running.*row\.session_id/s,
    );
  });

  it('marks project-not-found orphans as error', () => {
    expect(source).toMatch(
      /project not found.*marking error|orphan.*project not found/s,
    );
  });
});

// ── AC: resumeSession() — continuation nudge, timeout, mid-turn detection ────
describe('SessionManager.resumeSession() — nudge, timeout, mid-turn detection', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );
  const cliRunnerSource = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'CliSessionRunner.ts'),
    'utf-8',
  );

  it('exports RESUME_NUDGE_MESSAGE with continuation text', () => {
    expect(source).toMatch(/export\s+const\s+RESUME_NUDGE_MESSAGE\s*=/);
    // Nudge must reference where the model left off, in some form
    expect(source).toMatch(
      /RESUME_NUDGE_MESSAGE\s*=[\s\S]*?where you left off/i,
    );
  });

  it('calls this.send() with the nudge message during resume', () => {
    // nudgeMessage is built by buildResumeMessage(row) and then passed to send()
    expect(source).toMatch(
      /const\s+nudgeMessage\s*=\s*this\.buildResumeMessage\s*\(\s*row\s*\)/,
    );
    expect(source).toMatch(
      /this\.send\s*\(\s*row\.session_id\s*,\s*nudgeMessage\s*\)/,
    );
  });

  // The continuation message JSON shape is now produced by CliSessionRunner,
  // not AgentSession (runner abstraction added an indirection).
  it('the continuation message is written to stdin as { type: "user", message: { role: "user", content } }', () => {
    expect(cliRunnerSource).toMatch(
      /JSON\.stringify\s*\(\s*\{\s*type:\s*'user'\s*,\s*message:\s*\{\s*role:\s*'user'\s*,\s*content:[^}]+\}[,\s]*\}\s*\)/,
    );
    // Must be terminated with \n so the CLI readline interface receives a complete line
    expect(cliRunnerSource).toMatch(/JSON\.stringify[^)]+\)\s*\+\s*'\\n'/);
  });

  it('sets a 30-second timeout and marks session as error if no events are received', () => {
    expect(source).toMatch(/RESUME_TIMEOUT_MS\s*=\s*30[_]?000/);
    expect(source).toMatch(/setTimeout\s*\(/);
    expect(source).toMatch(
      /markSessionErrored\s*\(\s*row\.session_id\s*,\s*'error'\s*,\s*'resume_timeout'\s*\)/,
    );
    // Timer is cleared on first message — the variable is errorTimer
    expect(source).toMatch(/clearTimeout\s*\(\s*errorTimer\s*\)/);
  });

  it('guards timeout against sessions that end naturally before 30s', () => {
    expect(source).toMatch(/!session\.hasEnded/);
  });

  it('detects mid-turn state and logs a warning when last event is tool_result or tool_use', () => {
    expect(source).toMatch(/getEventsBySession\s*\(\s*row\.session_id\s*\)/);
    expect(source).toMatch(/tool_result.*tool_use|tool_use.*tool_result/);
    expect(source).toMatch(
      /Resuming mid-turn session.*continuation nudge|continuation nudge.*mid-turn session/s,
    );
  });

  it('does NOT send an initial prompt when resuming (no double-prompting)', () => {
    // CliSessionRunner gates the initial prompt write on !resumeSessionId
    expect(cliRunnerSource).toMatch(/if\s*\(\s*!resumeSessionId\b/);
    // resumeSession() passes row.session_id as the resumeSessionId so the guard
    // is always active for resumed sessions
    expect(source).toMatch(
      /row\.session_id,\s*\/\/\s*resumeSessionId|resumeSessionId.*row\.session_id/s,
    );
  });
});

// ── AC: sendOrResume() copies pr_url from original session ──────────────────
describe('SessionManager.sendOrResume() — pr_url carry-forward', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('respawnSession carries row.pr_url forward to session.prUrl (no insertSession needed)', () => {
    // respawnSession keeps the original session_id and updates status; it sets
    // session.prUrl from row.pr_url rather than inserting a new row.
    const respawnIdx = source.indexOf('private respawnSession(');
    const nextMethodIdx = source.indexOf('\n  private ', respawnIdx + 1);
    const respawnBlock = source.slice(respawnIdx, nextMethodIdx);
    expect(respawnBlock).toMatch(/session\.prUrl\s*=\s*row\.pr_url/);
  });

  it('sendOrResume uses respawnSession (no new insertSession with hard-coded pr_url: null)', () => {
    // The modern path: respawnSession handles prUrl carry-forward, no new insertSession row.
    const doSendOrResumeIdx = source.indexOf('private async _doSendOrResume(');
    const shutdownAllIdx = source.indexOf(
      'async shutdownAll',
      doSendOrResumeIdx,
    );
    const doBlock = source.slice(doSendOrResumeIdx, shutdownAllIdx);
    expect(doBlock).toMatch(/this\.respawnSession\s*\(/);
  });
});

// ── AC: server.ts calls resumeOrphanSessions() after jsonlReader.importAll() ──
describe('server.ts startup sequence', () => {
  it('calls sessionManager.resumeOrphanSessions() in the importAll().then() block', () => {
    const serverSource = fs.readFileSync(
      path.join(__dirname, '..', 'server.ts'),
      'utf-8',
    );
    expect(serverSource).toMatch(/resumeOrphanSessions\s*\(\s*\)/);
    // Must appear inside the importAll().then(...) callback (after importAll)
    const importAllIdx = serverSource.indexOf('importAll()');
    const resumeIdx = serverSource.indexOf('resumeOrphanSessions()');
    expect(resumeIdx).toBeGreaterThan(importAllIdx);
  });
});

// ── AC: resumeSession() — resumability pre-check skips spawn for missing worktree ──
describe('SessionManager.resumeSession() — resumability pre-check', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('checks worktree existence with fs.existsSync before constructing AgentSession', () => {
    // The pre-check must use fs.existsSync on row.worktree_path
    expect(source).toMatch(/fs\.existsSync\s*\(\s*worktreePath\s*\)/);
    // The pre-check appears before respawnSession() call in resumeSession()
    const resumeSessionIdx = source.indexOf('private async resumeSession(');
    const respawnCallIdx = source.indexOf(
      'this.respawnSession(',
      resumeSessionIdx,
    );
    const preCheckIdx = source.indexOf(
      'resumability pre-check',
      resumeSessionIdx,
    );
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(respawnCallIdx).toBeGreaterThan(-1);
    expect(preCheckIdx).toBeLessThan(respawnCallIdx);
  });

  it('marks the session as error when the worktree is missing', () => {
    // The pre-check failure path must call markSessionErrored(...) and return early (skip spawn).
    const resumeSessionIdx = source.indexOf('private async resumeSession(');
    const preCheckIdx = source.indexOf(
      'resumability pre-check failed',
      resumeSessionIdx,
    );
    expect(preCheckIdx).toBeGreaterThan(-1);
    const newAgentSessionIdx = source.indexOf(
      'new AgentSession(',
      resumeSessionIdx,
    );
    const preCheckBlock = source.slice(preCheckIdx, newAgentSessionIdx);
    expect(preCheckBlock).toMatch(
      /markSessionErrored\s*\(\s*row\.session_id\s*,\s*'error'\s*,\s*'worktree_missing'\s*\)/,
    );
    expect(preCheckBlock).toMatch(/return\s*;/);
  });

  it('does NOT auto-create a fresh worktree when the original is missing', () => {
    // The legacy "create new worktree on resume" branch must be removed —
    // a missing worktree should result in error, not a fresh worktree based on origin/dev.
    const resumeSessionIdx = source.indexOf('private async resumeSession(');
    const resumeOrphanIdx = source.indexOf(
      'resumeOrphanSessions',
      resumeSessionIdx,
    );
    const resumeSessionBlock = source.slice(resumeSessionIdx, resumeOrphanIdx);
    expect(resumeSessionBlock).not.toMatch(/worktree-resume-/);
    expect(resumeSessionBlock).not.toMatch(/git worktree add\b/);
  });
});

// ── AC: resumeSession() carries forward row.pr_url to AgentSession.prUrl ────
describe('SessionManager.resumeSession() — pr_url carry-forward', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('assigns row.pr_url to session.prUrl via respawnSession (shared resume helper)', () => {
    // session.prUrl is set from row.pr_url in respawnSession so cleanupWorktree(prUrl)
    // does NOT delete the branch on the next clean exit.
    const respawnIdx = source.indexOf('private respawnSession(');
    const nextMethodIdx = source.indexOf('\n  private ', respawnIdx + 1);
    const respawnBlock = source.slice(respawnIdx, nextMethodIdx);
    expect(respawnBlock).toMatch(/session\.prUrl\s*=\s*row\.pr_url/);
  });

  it('sendOrResume() also assigns row.pr_url to session.prUrl via respawnSession', () => {
    // respawnSession (shared helper called by both resumeSession and _doSendOrResume)
    // handles the prUrl assignment. Verify it's there.
    const respawnIdx = source.indexOf('private respawnSession(');
    const nextMethodIdx = source.indexOf('\n  private ', respawnIdx + 1);
    const respawnBlock = source.slice(respawnIdx, nextMethodIdx);
    expect(respawnBlock).toMatch(/session\.prUrl\s*=\s*row\.pr_url/);
  });
});

// ── AC: resumeOrphanSessions() only re-spawns running sessions ──────────────
describe('SessionManager.resumeOrphanSessions() — only running sessions', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('does NOT query for terminal-status sessions (done/killed/error)', () => {
    // The DB query in resumeOrphanSessions() must be limited to status='running'.
    // Sessions in done/killed/error remain in their terminal state.
    expect(source).toMatch(
      /getSessionsByStatus\s*\(\s*\[\s*['"]running['"]\s*\]\s*\)/,
    );
    expect(source).not.toMatch(/getSessionsByStatus\s*\(\s*\[\s*['"]done['"]/);
    expect(source).not.toMatch(
      /getSessionsByStatus\s*\(\s*\[\s*['"]killed['"]/,
    );
    expect(source).not.toMatch(/getSessionsByStatus\s*\(\s*\[\s*['"]error['"]/);
  });
});

// ── AC: CliSessionRunner — stdin IO errors do not throw ──────────────────────
describe('CliSessionRunner — stdin error handling', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'CliSessionRunner.ts'),
    'utf-8',
  );

  it('wraps stdin.write in sendMessage() with try/catch', () => {
    const sendMessageIdx = source.indexOf('sendMessage(message: string)');
    const endSessionIdx = source.indexOf('endSession()', sendMessageIdx);
    const sendMessageBlock = source.slice(sendMessageIdx, endSessionIdx);
    expect(sendMessageBlock).toMatch(
      /try\s*\{[\s\S]*?stdin\.write[\s\S]*?\}\s*catch/,
    );
  });

  it('wraps the initial-prompt stdin.write in run() with try/catch', () => {
    // The initial-prompt write at run() must be inside a try/catch so a
    // synchronous EPIPE/ERR_STREAM_DESTROYED does not throw.
    const initialPromptIdx = source.indexOf('Send initial prompt via stdin');
    const errorListenerIdx = source.indexOf('spawn error', initialPromptIdx);
    const block = source.slice(initialPromptIdx, errorListenerIdx);
    expect(block).toMatch(/try\s*\{[\s\S]*?stdin!\.write[\s\S]*?\}\s*catch/);
  });

  it('attaches an error listener to this.proc.stdin after spawn', () => {
    // Async stdin errors must not bubble up as unhandled events on the process.
    expect(source).toMatch(/this\.proc\.stdin!\.on\s*\(\s*['"]error['"]/);
  });
});

// ── AC: CliSessionRunner.sendMessage() returns cleanly on destroyed stdin ────
describe('CliSessionRunner.sendMessage() — destroyed stdin', () => {
  it('returns cleanly without throwing when stdin.write throws synchronously', async () => {
    // Import after vi.mock setup elsewhere — fresh-import here keeps the test
    // independent of any other suite's mock state.
    const { CliSessionRunner } = await import('../session/CliSessionRunner');
    const runner = new CliSessionRunner('test-session-id-abc');
    // Inject a fake proc with a writable stdin that throws synchronously
    // (mimicking EPIPE / ERR_STREAM_DESTROYED from a closed pipe).
    (runner as unknown as { proc: unknown }).proc = {
      stdin: {
        writable: true,
        write: () => {
          throw new Error('write EPIPE');
        },
      },
    };
    expect(() => runner.sendMessage('hello')).not.toThrow();
  });

  it('returns cleanly when stdin is not writable (no-op early return)', async () => {
    const { CliSessionRunner } = await import('../session/CliSessionRunner');
    const runner = new CliSessionRunner('test-session-id-xyz');
    (runner as unknown as { proc: unknown }).proc = {
      stdin: {
        writable: false,
        write: () => {
          throw new Error('should not be called');
        },
      },
    };
    expect(() => runner.sendMessage('hello')).not.toThrow();
  });

  it('returns cleanly when proc is null (never spawned)', async () => {
    const { CliSessionRunner } = await import('../session/CliSessionRunner');
    const runner = new CliSessionRunner('test-session-id-null');
    // proc is null by default
    expect(() => runner.sendMessage('hello')).not.toThrow();
  });
});

// ── AC: SessionManager pendingStarts — concurrency cap race fix ──────────────
describe('SessionManager.getLiveCodeSessionCount() — pendingStarts', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('pendingStarts map is declared as a private field', () => {
    expect(source).toMatch(/private\s+pendingStarts\s*=\s*new Map/);
  });

  it('pendingStarts.set is called synchronously inside start() before completeStart', () => {
    expect(source).toMatch(/this\.pendingStarts\.set\s*\(\s*sessionId/);
    // pendingStarts.set must appear before void this.completeStart(
    const pendingSetIdx = source.indexOf('this.pendingStarts.set(sessionId');
    const completeStartIdx = source.indexOf('void this.completeStart(');
    expect(pendingSetIdx).toBeGreaterThan(0);
    expect(completeStartIdx).toBeGreaterThan(0);
    expect(pendingSetIdx).toBeLessThan(completeStartIdx);
  });

  it('pendingStarts.delete is called in the completeStart .catch() handler', () => {
    const catchIdx = source.indexOf('completeStart(');
    const catchBlock = source.slice(catchIdx, catchIdx + 500);
    expect(catchBlock).toMatch(
      /this\.pendingStarts\.delete\s*\(\s*sessionId\s*\)/,
    );
  });

  it('pendingStarts.delete is called before this.sessions.set in the success path', () => {
    const pendingDeleteIdx = source.indexOf(
      'this.pendingStarts.delete(sessionId)',
    );
    const sessionsSetIdx = source.indexOf(
      'this.sessions.set(sessionId, session)',
    );
    expect(pendingDeleteIdx).toBeGreaterThan(0);
    expect(sessionsSetIdx).toBeGreaterThan(pendingDeleteIdx);
  });

  it('getLiveCodeSessionCount() sums sessions and non-review pendingStarts', () => {
    expect(source).toMatch(/pendingStarts/);
    const countFnIdx = source.indexOf('getLiveCodeSessionCount()');
    const countFnBody = source.slice(countFnIdx, countFnIdx + 400);
    expect(countFnBody).toMatch(/this\.pendingStarts/);
    expect(countFnBody).toMatch(/sessionType\s*!==\s*'review'/);
  });

  it('getLiveCodeSessionCount() skips pendingStarts entries already in sessions to avoid double-count', () => {
    const countFnIdx = source.indexOf('getLiveCodeSessionCount()');
    const countFnBody = source.slice(countFnIdx, countFnIdx + 400);
    expect(countFnBody).toMatch(/!this\.sessions\.has\s*\(\s*id\s*\)/);
  });

  it('a review sessionType in pendingStarts does not count toward getLiveCodeSessionCount', () => {
    const countFnIdx = source.indexOf('getLiveCodeSessionCount()');
    const countFnBody = source.slice(countFnIdx, countFnIdx + 400);
    // Both sessions and pendingStarts guard on sessionType !== 'review'
    const reviewGuards = [
      ...countFnBody.matchAll(/sessionType\s*!==\s*'review'/g),
    ];
    expect(reviewGuards.length).toBeGreaterThanOrEqual(2);
  });
});

// ── AC: SessionManager — error broadcast and rollback on launch failure ───────
describe('SessionManager — error broadcast and rollback', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('broadcasts an error message when updateStatus(In Progress) fails', () => {
    // The .catch() on updateStatus must emit a ServerMessage with type: 'error'
    const inProgressIdx = source.indexOf(
      "updateStatus(sessionTaskId, '🔄 In Progress'",
    );
    expect(inProgressIdx).toBeGreaterThan(-1);
    const catchBlock = source.slice(inProgressIdx, inProgressIdx + 1000);
    expect(catchBlock).toMatch(/\.catch\s*\(/);
    expect(catchBlock).toMatch(/this\.emit\('message'/);
    expect(catchBlock).toMatch(/type:\s*'error'/);
  });

  it('completeStart().catch() delegates status rollback to markSessionErrored with launch_failed cause', () => {
    const completeStartCatchIdx = source.indexOf('void this.completeStart(');
    expect(completeStartCatchIdx).toBeGreaterThan(-1);
    // markSessionErrored maps 'launch_failed' → '🗂️ Ready' internally
    const catchBlock = source.slice(
      completeStartCatchIdx,
      completeStartCatchIdx + 1000,
    );
    expect(catchBlock).toMatch(
      /markSessionErrored\s*\(\s*sessionId\s*,\s*'error'\s*,\s*'launch_failed'\s*\)/,
    );
  });

  it('completeStart().catch() broadcasts an error type ServerMessage', () => {
    const completeStartCatchIdx = source.indexOf('void this.completeStart(');
    const catchBlock = source.slice(
      completeStartCatchIdx,
      completeStartCatchIdx + 2000,
    );
    expect(catchBlock).toMatch(/this\.emit\('message'/);
    expect(catchBlock).toMatch(/type:\s*'error'/);
  });

  it('completeStart rollback: markSessionErrored is responsible for task_status_changed and Ready status', () => {
    // markSessionErrored emits task_status_changed with '🗂️ Ready' for 'launch_failed' cause.
    // Verified structurally: the helper is called from the catch block.
    const completeStartCatchIdx = source.indexOf('void this.completeStart(');
    const catchBlock = source.slice(
      completeStartCatchIdx,
      completeStartCatchIdx + 1000,
    );
    expect(catchBlock).toMatch(
      /markSessionErrored\s*\(\s*sessionId\s*,\s*'error'\s*,\s*'launch_failed'\s*\)/,
    );
    // markSessionErrored.test.ts verifies the task_status_changed + '🗂️ Ready' emission.
  });
});

// ── AC: SessionManager.start() writes sessions.task_id in dashed UUID form ───
describe('SessionManager.start() — dashed task_id', () => {
  const smSource = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('imports parseNotionPageIdDashed (not parseNotionPageId) from AgentSession', () => {
    expect(smSource).toMatch(/parseNotionPageIdDashed/);
    expect(smSource).not.toMatch(/import.*parseNotionPageId[^D]/);
  });

  it('uses parseNotionPageIdDashed when building notionTaskId', () => {
    expect(smSource).toMatch(
      /formatTaskId\s*\(\s*'notion'\s*,\s*parseNotionPageIdDashed\s*\(\s*taskUrl\s*\)\s*\)/,
    );
  });
});

// ── AC: SessionManager.start() requires taskKind for standard sessions ───────
describe('SessionManager.start() — taskKind required', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('throws when sessionType is standard and taskKind is undefined', () => {
    expect(source).toMatch(
      /sessionType\s*!==\s*'review'\s*&&\s*taskKind\s*===\s*undefined/,
    );
    expect(source).toMatch(/requires taskKind for standard sessions/);
  });

  it('does not throw for review sessions without taskKind (gate is conditional)', () => {
    const gateIdx = source.indexOf(
      "sessionType !== 'review' && taskKind === undefined",
    );
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBlock = source.slice(gateIdx, gateIdx + 200);
    expect(gateBlock).toMatch(/sessionType\s*!==\s*'review'/);
  });

  it('does not use the old heuristic taskKind ?? (milestoneId ? milestone : non_milestone)', () => {
    expect(source).not.toMatch(
      /taskKind\s*\?\?\s*\(\s*milestoneId\s*\?\s*'milestone'\s*:\s*'non_milestone'\s*\)/,
    );
  });
});

// ── AC: SessionManager.start() dedup — in-flight session guard ───────────────
describe('SessionManager.start() — in-flight dedup guard', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('calls hasLiveSessionForTask() before creating a session', () => {
    expect(source).toMatch(/this\.hasLiveSessionForTask\s*\(/);
    const dedupIdx = source.indexOf('this.hasLiveSessionForTask(');
    const sessionIdIdx = source.indexOf(
      'const sessionId = providedSessionId ??',
    );
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(dedupIdx).toBeLessThan(sessionIdIdx);
  });

  it('calls hasActiveSessionForTask() from db/queries as second dedup check', () => {
    expect(source).toMatch(/hasActiveSessionForTask\s*\(/);
    expect(source).toMatch(/import.*hasActiveSessionForTask.*from.*queries/s);
  });

  it('throws with alreadyRunning: true when dedup check fires', () => {
    expect(source).toMatch(/alreadyRunning:\s*true/);
    expect(source).toMatch(/Session already running for task/);
  });

  it('dedup guard only applies to non-review sessions', () => {
    const dedupIdx = source.indexOf('this.hasLiveSessionForTask(');
    const dedupBlock = source.slice(Math.max(0, dedupIdx - 250), dedupIdx + 50);
    expect(dedupBlock).toMatch(/sessionType\s*!==\s*'review'/);
  });
});

// ── AC: WS router dispatch — forwards milestoneId, taskKind, taskName ────────
describe('ws/router.ts — dispatch forwards new fields', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'ws', 'router.ts'),
    'utf-8',
  );

  it('forwards milestoneId to sessions.start()', () => {
    expect(source).toMatch(/milestoneId:\s*t\.milestoneId/);
  });

  it('forwards taskKind to sessions.start()', () => {
    expect(source).toMatch(/taskKind:\s*t\.taskKind/);
  });

  it('forwards taskName to sessions.start()', () => {
    expect(source).toMatch(/taskName:\s*t\.taskName/);
  });

  it('sends a non-error message when alreadyRunning is true', () => {
    expect(source).toMatch(/alreadyRunning/);
    expect(source).toMatch(/already has an active session/);
  });
});

// ── AC: ws/types.ts dispatch message — includes new optional fields ───────────
describe('ws/types.ts — dispatch message shape', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'ws', 'types.ts'),
    'utf-8',
  );

  it('dispatch task items include milestoneId optional field', () => {
    expect(source).toMatch(/milestoneId\?:\s*string\s*\|\s*null/);
  });

  it('dispatch task items include taskKind optional field', () => {
    expect(source).toMatch(/taskKind\?:\s*'milestone'\s*\|\s*'non_milestone'/);
  });

  it('dispatch task items include taskName optional field', () => {
    expect(source).toMatch(/taskName\?:\s*string/);
  });
});

// ── AC: SessionManager.buildResumeMessage() — verdict enrichment ─────────────
describe('SessionManager.buildResumeMessage() — verdict-enriched resume nudge', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('private buildResumeMessage method exists', () => {
    expect(source).toMatch(/private\s+buildResumeMessage\s*\(/);
  });

  it('calls getPRBySessionId to look up the PR for the session', () => {
    const methodIdx = source.indexOf('private buildResumeMessage(');
    const nextMethod = source.indexOf('\n  private ', methodIdx + 1);
    const methodBlock = source.slice(methodIdx, nextMethod);
    expect(methodBlock).toMatch(/getPRBySessionId\s*\(\s*row\.session_id\s*\)/);
  });

  it('returns RESUME_NUDGE_MESSAGE when no PR row exists (session never opened a PR)', () => {
    const methodIdx = source.indexOf('private buildResumeMessage(');
    const nextMethod = source.indexOf('\n  private ', methodIdx + 1);
    const methodBlock = source.slice(methodIdx, nextMethod);
    // Falls back to RESUME_NUDGE_MESSAGE when pr is null/undefined
    expect(methodBlock).toMatch(/if\s*\(\s*!pr\?\.review_result\s*\)/);
    expect(methodBlock).toMatch(/return\s+RESUME_NUDGE_MESSAGE/);
  });

  it('returns formatReviewFeedback for needs_changes verdict', () => {
    const methodIdx = source.indexOf('private buildResumeMessage(');
    const nextMethod = source.indexOf('\n  private ', methodIdx + 1);
    const methodBlock = source.slice(methodIdx, nextMethod);
    expect(methodBlock).toMatch(/result\.verdict\s*===\s*'needs_changes'/);
    expect(methodBlock).toMatch(/formatReviewFeedback\s*\(/);
  });

  it('returns formatReviewFeedback for incomplete verdict', () => {
    const methodIdx = source.indexOf('private buildResumeMessage(');
    const nextMethod = source.indexOf('\n  private ', methodIdx + 1);
    const methodBlock = source.slice(methodIdx, nextMethod);
    expect(methodBlock).toMatch(/result\.verdict\s*===\s*'incomplete'/);
  });

  it('returns formatApprovedVerdictMessage for approved verdict', () => {
    const methodIdx = source.indexOf('private buildResumeMessage(');
    const nextMethod = source.indexOf('\n  private ', methodIdx + 1);
    const methodBlock = source.slice(methodIdx, nextMethod);
    expect(methodBlock).toMatch(/result\.verdict\s*===\s*'approved'/);
    expect(methodBlock).toMatch(/formatApprovedVerdictMessage\s*\(/);
  });

  it('falls back to RESUME_NUDGE_MESSAGE when review_result is malformed JSON', () => {
    const methodIdx = source.indexOf('private buildResumeMessage(');
    const nextMethod = source.indexOf('\n  private ', methodIdx + 1);
    const methodBlock = source.slice(methodIdx, nextMethod);
    // Must have a try/catch that returns RESUME_NUDGE_MESSAGE on parse failure
    expect(methodBlock).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
    // The final return after the catch block returns the plain nudge
    const catchIdx = methodBlock.indexOf('catch');
    const afterCatch = methodBlock.slice(catchIdx);
    expect(afterCatch).toMatch(/return\s+RESUME_NUDGE_MESSAGE/);
  });

  it('resumeSession calls buildResumeMessage(row) instead of using RESUME_NUDGE_MESSAGE directly', () => {
    expect(source).toMatch(/this\.buildResumeMessage\s*\(\s*row\s*\)/);
    // The direct RESUME_NUDGE_MESSAGE reference in the nudge setTimeout must be gone
    const nudgeDelayIdx = source.indexOf('const nudgeDelay = setTimeout');
    const nudgeDelayBlock = source.slice(nudgeDelayIdx, nudgeDelayIdx + 300);
    expect(nudgeDelayBlock).not.toMatch(/RESUME_NUDGE_MESSAGE/);
  });

  it('imports formatReviewFeedback and formatApprovedVerdictMessage from reviewUtils', () => {
    expect(source).toMatch(/formatReviewFeedback/);
    expect(source).toMatch(/formatApprovedVerdictMessage/);
    expect(source).toMatch(/from\s+['"]\.\.\/github\/reviewUtils['"]/);
  });

  it('imports PRReviewResult type from PRReviewService', () => {
    expect(source).toMatch(/PRReviewResult/);
    expect(source).toMatch(/from\s+['"]\.\.\/github\/PRReviewService['"]/);
  });
});

// ── AC: _doSendOrResume() — terminal status guard ─────────────────────────────
describe('SessionManager._doSendOrResume() — terminal status guard', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('checks row.status against done, error, and killed before respawning', () => {
    const doResumeIdx = source.indexOf('_doSendOrResume');
    const shutdownIdx = source.indexOf('async shutdownAll');
    const block = source.slice(doResumeIdx, shutdownIdx);
    expect(block).toMatch(/row\.status\s*===\s*'done'/);
    expect(block).toMatch(/row\.status\s*===\s*'error'/);
    expect(block).toMatch(/row\.status\s*===\s*'killed'/);
  });

  it('logs a warning and returns early for terminal sessions', () => {
    const doResumeIdx = source.indexOf('_doSendOrResume');
    const shutdownIdx = source.indexOf('async shutdownAll');
    const block = source.slice(doResumeIdx, shutdownIdx);
    // Must log a warning with the session status before bailing
    expect(block).toMatch(
      /console\.warn[\s\S]*?terminal|terminal[\s\S]*?console\.warn/,
    );
    // Guard must appear before any git worktree or process-spawn code
    const guardIdx = block.indexOf("row.status === 'done'");
    const worktreeIdx = block.indexOf('git worktree add');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(worktreeIdx).toBeGreaterThan(guardIdx);
  });

  it('allows idle sessions to proceed through respawn', () => {
    const doResumeIdx = source.indexOf('_doSendOrResume');
    const shutdownIdx = source.indexOf('async shutdownAll');
    const block = source.slice(doResumeIdx, shutdownIdx);
    // Guard must NOT include 'idle' — idle→running re-entry must be permitted
    const guardMatch = block.match(
      /if\s*\([^)]*row\.status\s*===\s*'done'[^)]*\)/,
    );
    expect(guardMatch).not.toBeNull();
    expect(guardMatch![0]).not.toContain('idle');
  });
});
