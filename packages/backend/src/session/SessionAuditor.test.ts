import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { SessionAuditor } from "./SessionAuditor";
import type { AuditableSession, ISessionManager } from "./SessionAuditor";
import type { TaskTrackerBackend } from "../tasks/TaskTrackerBackend";
import type { GitHubClient } from "../github/GitHubClient";
import type { PullRequest } from "../github/types";

vi.mock("../db/queries", () => ({
  getPRByNotionTaskId: vi.fn(() => null),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(
  overrides: Partial<AuditableSession> = {},
): AuditableSession {
  return {
    sessionId: "test-session-id",
    taskId: "task-abc123",
    prUrl: "https://github.com/owner/repo/pull/42",
    sessionType: "standard",
    ...overrides,
  };
}

function makeNotionClient(filesSection = ""): TaskTrackerBackend {
  const body = [
    "# Add post-session audit hook",
    "## Summary\nSummary text",
    "## Context\nContext text",
    "## Acceptance Criteria\nAC text",
    filesSection ? `## Files\n${filesSection}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    type: "notion" as const,
    fetchTaskPage: vi.fn(async () => body),
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as TaskTrackerBackend;
}

function makeGitHubClient(
  prOverrides: Partial<PullRequest> = {},
): GitHubClient {
  const defaultPR: PullRequest = {
    id: 42,
    title: "feat: add audit hook",
    body: "## Summary\nDid things.\n\n## Test plan\n- tested",
    url: "https://github.com/owner/repo/pull/42",
    apiUrl: "https://api.github.com/repos/owner/repo/pulls/42",
    headBranch: "feature/audit",
    baseBranch: "dev",
    state: "open",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    mergeableState: "clean",
    draft: false,
  };
  return {
    fetchPR: vi.fn(async () => ({ ...defaultPR, ...prOverrides })),
    fetchDiff: vi.fn(async () => ({
      prId: 42,
      diff: "",
      filesChanged: ["packages/backend/src/session/SessionAuditor.ts"],
    })),
  } as unknown as GitHubClient;
}

function makeSessionManager(): ISessionManager {
  return { send: vi.fn() };
}

// ── Import mocked module for DB fallback tests ───────────────────────────────
import * as queries from "../db/queries";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionAuditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);
  });

  // ── AC: Clean exit without PR ─────────────────────────────────────────────
  it('returns "Clean exit but no PR opened" when exitCode is 0 and prUrl is null', async () => {
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ prUrl: undefined });
    const audit = await auditor.audit(session, 0);

    expect(audit.prOpened).toBe(false);
    expect(audit.violations).toContain("Clean exit but no PR opened");
  });

  it('does NOT flag "Clean exit but no PR opened" when exitCode is non-zero', async () => {
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ prUrl: undefined });
    const audit = await auditor.audit(session, 1);

    expect(audit.violations).not.toContain("Clean exit but no PR opened");
  });

  // ── AC: PR targets wrong branch ───────────────────────────────────────────
  it('returns "PR targets main instead of dev" when baseBranch is main', async () => {
    const github = makeGitHubClient({ baseBranch: "main" });
    const auditor = new SessionAuditor(makeNotionClient(), github, undefined);
    const session = makeSession();
    const audit = await auditor.audit(session, 0);

    expect(audit.prTargetsBranch).toBe("main");
    expect(audit.violations).toContain("PR targets main instead of dev");
  });

  it("does NOT flag branch violation when baseBranch is dev", async () => {
    const github = makeGitHubClient({ baseBranch: "dev" });
    const auditor = new SessionAuditor(makeNotionClient(), github, undefined);
    const session = makeSession();
    const audit = await auditor.audit(session, 0);

    expect(audit.violations).not.toContain("PR targets dev instead of dev");
    const branchViolation = audit.violations.find((v) =>
      v.startsWith("PR targets"),
    );
    expect(branchViolation).toBeUndefined();
  });

  // ── AC: Spec mismatch — files in diff not in spec ────────────────────────
  it("flags files in the diff that are not listed in the task spec", async () => {
    const notion = makeNotionClient(
      "packages/backend/src/session/SessionAuditor.ts",
    );
    const github = makeGitHubClient();
    vi.mocked(github.fetchDiff).mockResolvedValue({
      prId: 42,
      diff: "",
      filesChanged: [
        "packages/backend/src/session/SessionAuditor.ts",
        "packages/frontend/src/SomeUnexpected.tsx",
      ],
    });

    const auditor = new SessionAuditor(notion, github, undefined);
    const session = makeSession();
    const audit = await auditor.audit(session, 0);

    const unexpectedViolation = audit.violations.find((v) =>
      v.includes("PR modifies files not listed in task spec"),
    );
    expect(unexpectedViolation).toBeDefined();
    expect(unexpectedViolation).toContain("SomeUnexpected.tsx");
  });

  // ── AC: routeFailuresToSession sends violations as follow-up message ─────
  it("routeFailuresToSession sends violations as a follow-up message to the session", async () => {
    const github = makeGitHubClient({ baseBranch: "main" }); // will produce a violation
    const sm = makeSessionManager();
    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    await auditor.audit(session, 0);

    expect(sm.send).toHaveBeenCalledOnce();
    const [calledSessionId, message] = vi.mocked(sm.send).mock.calls[0];
    expect(calledSessionId).toBe("test-session-id");
    expect(message).toContain("❌");
    expect(message).toContain("Audit findings for your PR:");
  });

  it("does NOT call send when there are no violations", async () => {
    const github = makeGitHubClient(); // baseBranch: dev, good title, good body
    const sm = makeSessionManager();
    // No files section — spec comparison returns null
    const auditor = new SessionAuditor(makeNotionClient(""), github, sm);
    const session = makeSession();
    await auditor.audit(session, 0);

    expect(sm.send).not.toHaveBeenCalled();
  });

  // ── AC: routeFailuresToSession does not throw if session has exited ───────
  it("routeFailuresToSession does not throw when send() throws", async () => {
    const github = makeGitHubClient({ baseBranch: "main" }); // produces a violation
    const sm = makeSessionManager();
    vi.mocked(sm.send).mockImplementation(() => {
      throw new Error("Session exited");
    });

    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    // Should not throw
    await expect(auditor.audit(session, 0)).resolves.toBeDefined();
  });

  // ── AC: Audit skips review sessions ──────────────────────────────────────
  // (This is enforced in AgentSession, but the auditor itself has no restriction.
  //  We verify the AgentSession-level guard by testing that review sessions are
  //  explicitly excluded in the integration, and here we confirm audit() can be
  //  called with a review session without crashing.)
  it("audit() runs without error for a review-type session", async () => {
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ sessionType: "review", prUrl: undefined });
    const audit = await auditor.audit(session, 0);
    expect(audit).toBeDefined();
  });

  // ── AC: GitHub API failure does not throw ─────────────────────────────────
  it("is non-blocking: GitHub API failure does not throw and skips PR checks", async () => {
    const github = makeGitHubClient();
    vi.mocked(github.fetchPR).mockRejectedValue(new Error("GitHub API 500"));

    const auditor = new SessionAuditor(makeNotionClient(), github, undefined);
    const session = makeSession();

    const audit = await auditor.audit(session, 0);
    expect(audit).toBeDefined();
    // PR checks skipped — no branch/title/body violations from GitHub
    const ghViolations = audit.violations.filter(
      (v) =>
        v.includes("PR targets") ||
        v.includes("PR title") ||
        v.includes("PR body"),
    );
    expect(ghViolations).toHaveLength(0);
  });

  // ── AC: DB fallback — pr_url null but pull_requests table has a PR ─────────
  it('does NOT flag "no PR opened" when getPRByNotionTaskId returns a row (DB fallback)', async () => {
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue({
      id: 1,
      pr_number: 10,
      pr_url: "https://github.com/owner/repo/pull/10",
      notion_task_id: "task-abc123",
      session_id: "original-session",
      repo: "owner/repo",
      title: "feat: something",
      body: null,
      head_branch: "feature/something",
      base_branch: "dev",
    } as any);

    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ prUrl: undefined });
    const audit = await auditor.audit(session, 0);

    expect(audit.prOpened).toBe(true);
    expect(audit.violations).not.toContain("Clean exit but no PR opened");
  });

  it('still flags "no PR opened" when both prUrl is null and getPRByNotionTaskId returns null', async () => {
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);

    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ prUrl: undefined });
    const audit = await auditor.audit(session, 0);

    expect(audit.prOpened).toBe(false);
    expect(audit.violations).toContain("Clean exit but no PR opened");
  });

  it("does NOT call getPRByNotionTaskId when prUrl is already set", async () => {
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);

    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({
      prUrl: "https://github.com/owner/repo/pull/42",
    });
    await auditor.audit(session, 0);

    expect(queries.getPRByNotionTaskId).not.toHaveBeenCalled();
  });

  // ── AC: sessionManager is optional — no crash when not provided ───────────
  it("works without a sessionManager when violations exist", async () => {
    const github = makeGitHubClient({ baseBranch: "main" });
    const auditor = new SessionAuditor(makeNotionClient(), github, undefined);
    const session = makeSession();
    const audit = await auditor.audit(session, 0);
    expect(audit.violations.length).toBeGreaterThan(0);
  });
});

// ── runMigrations() — session_audits table ───────────────────────────────────

describe("runMigrations() — session_audits table", () => {
  it("creates session_audits table with CREATE TABLE IF NOT EXISTS (idempotent)", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "db", "schema.ts"),
      "utf-8",
    );
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS session_audits/);
  });

  it("session_audits table has required columns", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "db", "schema.ts"),
      "utf-8",
    );
    expect(source).toMatch(/session_id\s+TEXT NOT NULL/);
    expect(source).toMatch(/pr_opened\s+INTEGER NOT NULL/);
    expect(source).toMatch(/violations\s+TEXT NOT NULL/);
    expect(source).toMatch(/audited_at\s+TEXT NOT NULL/);
  });
});
