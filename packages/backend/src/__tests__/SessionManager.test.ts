import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { normalizePath } from '../config';

// ── AC: SessionManager.start() updates task status to In Progress ──────────
describe('SessionManager.start() — In Progress status', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('routes updateStatus through getTaskBackend(projectId) for In Progress', () => {
    // Must call getTaskBackend(projectId).updateStatus(notionTaskId, In Progress)
    expect(source).toMatch(
      /getTaskBackend\(projectId\)\.updateStatus\s*\(\s*notionTaskId\s*,\s*'🔄 In Progress'\s*\)/,
    );
  });

  it('In Progress call is fire-and-forget with .catch() error handler', () => {
    expect(source).toMatch(
      /getTaskBackend\(projectId\)\.updateStatus\s*\(\s*notionTaskId\s*,\s*'🔄 In Progress'\s*\)[\s\S]*?\.catch\b/,
    );
  });

  it('In Progress call is gated on sessionType === standard', () => {
    expect(source).toMatch(/sessionType\s*===\s*'standard'/);
    const gateIdx = source.indexOf("sessionType === 'standard'");
    const inProgressIdx = source.indexOf(
      "getTaskBackend(projectId).updateStatus(notionTaskId, '🔄 In Progress')",
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
    // Must filter sessions by sessionType !== review before counting
    expect(source).toMatch(
      /\.filter\s*\(\s*\(s\)\s*=>\s*s\.sessionType\s*!==\s*'review'\s*\)/,
    );
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
    expect(source).toMatch(/session\.run\(\)/);
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
      /updateSessionStatus\s*\(.*'error'.*Date\.now\(\)\)/s,
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
    expect(source).toMatch(/session\.run\(\)/);
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
    // The first arg must be row.session_id and resumeSessionId must also be row.session_id
    expect(source).toMatch(
      /row\.session_id,\s*\/\/\s*keep original ID|keep original ID.*row\.session_id/s,
    );
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

  it('calls this.send() with RESUME_NUDGE_MESSAGE during resume', () => {
    expect(source).toMatch(
      /this\.send\s*\(\s*row\.session_id\s*,\s*RESUME_NUDGE_MESSAGE\s*\)/,
    );
  });

  // The continuation message JSON shape is now produced by CliSessionRunner,
  // not AgentSession (runner abstraction added an indirection).
  it('the continuation message is written to stdin as { type: "user", message: { role: "user", content } }', () => {
    expect(cliRunnerSource).toMatch(
      /JSON\.stringify\s*\(\s*\{\s*type:\s*'user'\s*,\s*message:\s*\{\s*role:\s*'user'\s*,\s*content:[^}]+\}\s*\}\s*\)/,
    );
    // Must be terminated with \n so the CLI readline interface receives a complete line
    expect(cliRunnerSource).toMatch(/JSON\.stringify[^)]+\)\s*\+\s*'\\n'/);
  });

  it('sets a 30-second timeout and marks session as error if no events are received', () => {
    expect(source).toMatch(/RESUME_TIMEOUT_MS\s*=\s*30[_]?000/);
    expect(source).toMatch(/setTimeout\s*\(/);
    expect(source).toMatch(
      /updateSessionStatus\s*\(.*'error'.*Date\.now\(\)\)/s,
    );
    expect(source).toMatch(/session_ended/);
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

  it('passes row.pr_url (not null) to insertSession when resuming', () => {
    // Must use row.pr_url when inserting the new session row, not a hard-coded null
    expect(source).toMatch(/pr_url:\s*row\.pr_url\s*\?\?\s*null/);
  });

  it('does NOT hard-code pr_url: null in sendOrResume insertSession call', () => {
    // The sendOrResume block must not pass pr_url: null directly
    const sendOrResumeIdx = source.indexOf('sendOrResume');
    const insertSessionInResume = source.indexOf(
      'insertSession',
      sendOrResumeIdx,
    );
    const closingBrace = source.indexOf('});', insertSessionInResume);
    const insertBlock = source.slice(insertSessionInResume, closingBrace);
    expect(insertBlock).not.toMatch(/pr_url:\s*null(?!\s*\?\?)/);
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
    // The pre-check appears before "new AgentSession(" in resumeSession()
    const resumeSessionIdx = source.indexOf('private async resumeSession(');
    const newAgentSessionIdx = source.indexOf(
      'new AgentSession(',
      resumeSessionIdx,
    );
    const preCheckIdx = source.indexOf(
      'resumability pre-check',
      resumeSessionIdx,
    );
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(preCheckIdx).toBeLessThan(newAgentSessionIdx);
  });

  it('marks the session as error when the worktree is missing', () => {
    // The pre-check failure path must call updateSessionStatus(..., 'error', ...)
    // and emit session_ended. It must also return early (skip spawn).
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
      /updateSessionStatus\s*\(\s*row\.session_id\s*,\s*'error'/,
    );
    expect(preCheckBlock).toMatch(/session_ended/);
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

  it('assigns row.pr_url to session.prUrl after AgentSession construction', () => {
    // session.prUrl is set from row.pr_url so cleanupWorktree(prUrl) does NOT
    // delete the branch on the next clean exit.
    const resumeSessionIdx = source.indexOf('private async resumeSession(');
    const resumeOrphanIdx = source.indexOf(
      'resumeOrphanSessions',
      resumeSessionIdx,
    );
    const resumeSessionBlock = source.slice(resumeSessionIdx, resumeOrphanIdx);
    expect(resumeSessionBlock).toMatch(/session\.prUrl\s*=\s*row\.pr_url/);
  });

  it('sendOrResume() also assigns row.pr_url to session.prUrl', () => {
    const sendOrResumeIdx = source.indexOf('async sendOrResume');
    const shutdownAllIdx = source.indexOf('async shutdownAll', sendOrResumeIdx);
    const sendOrResumeBlock = source.slice(sendOrResumeIdx, shutdownAllIdx);
    expect(sendOrResumeBlock).toMatch(/session\.prUrl\s*=\s*row\.pr_url/);
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
