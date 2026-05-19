import { describe, it, expect } from 'vitest';
import { deriveDisplayStatus } from './TaskStatusEngine';
import type { TaskStatusInput } from './TaskStatusEngine';

function makeInput(overrides: Partial<TaskStatusInput> = {}): TaskStatusInput {
  return {
    notionStatus: '🗂️ Ready',
    codeSessionStatus: null,
    prState: null,
    prDraft: false,
    reviewVerdict: null,
    reviewIterationCount: 0,
    reviewIterationCap: 3,
    pauseReason: null,
    ...overrides,
  };
}

describe('deriveDisplayStatus', () => {
  // ─── Notion status as primary source of truth ──────────────────────────────

  it("returns 'in_progress' when Notion says In Progress even with an open PR", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🔄 In Progress', prState: 'open' }),
      ),
    ).toBe('in_progress');
  });

  it("returns 'in_review' when Notion says In Review and no open PR", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '👀 In Review', prState: null }),
      ),
    ).toBe('in_review');
  });

  it("returns 'in_progress' when Notion says In Progress and session is running", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          codeSessionStatus: 'running',
        }),
      ),
    ).toBe('in_progress');
  });

  it("returns 'ready' when Notion says Ready even if session is running", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🗂️ Ready', codeSessionStatus: 'running' }),
      ),
    ).toBe('ready');
  });

  it("returns 'ready' when Notion says Ready even if PR is open", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🗂️ Ready', prState: 'open' }),
      ),
    ).toBe('ready');
  });

  // ─── ready ─────────────────────────────────────────────────────────────────

  it("returns 'ready' when notionStatus is '🗂️ Ready' and codeSessionStatus is null", () => {
    expect(deriveDisplayStatus(makeInput())).toBe('ready');
  });

  it("returns 'ready' when all inputs indicate no active work", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🗂️ Ready',
          codeSessionStatus: null,
          prState: null,
        }),
      ),
    ).toBe('ready');
  });

  // ─── in_progress ───────────────────────────────────────────────────────────

  it("returns 'in_progress' when notionStatus is '🔄 In Progress' and no running session", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          codeSessionStatus: null,
          prState: null,
        }),
      ),
    ).toBe('in_progress');
  });

  // ─── in_review ─────────────────────────────────────────────────────────────

  it("returns 'in_review' when notionStatus is '👀 In Review' and PR is open", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '👀 In Review', prState: 'open' }),
      ),
    ).toBe('in_review');
  });

  it("returns 'in_review' when notionStatus is '👀 In Review' and reviewVerdict is 'needs_changes'", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'needs_changes',
        }),
      ),
    ).toBe('in_review');
  });

  it("returns 'in_review' when notionStatus is '👀 In Review' and reviewVerdict is 'incomplete'", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'incomplete',
        }),
      ),
    ).toBe('in_review');
  });

  // ─── needs_attention ───────────────────────────────────────────────────────

  it("returns 'needs_attention' when notionStatus is '👀 In Review' and pauseReason is 'max_reviews'", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: 'max_reviews',
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' for any non-null pauseReason", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: 'stuck_timeout',
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' even when pauseReason is set outside of In Review", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          pauseReason: 'stuck_timeout',
        }),
      ),
    ).toBe('needs_attention');
  });

  it("does NOT return 'needs_attention' when pauseReason is null", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewIterationCount: 5,
          reviewIterationCap: 3,
        }),
      ),
    ).toBe('in_review');
  });

  // ─── ready_to_merge ────────────────────────────────────────────────────────

  it("returns 'ready_to_merge' when notionStatus is '👀 In Review', reviewVerdict is 'approved' and prState is 'open'", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'approved',
        }),
      ),
    ).toBe('ready_to_merge');
  });

  it("returns 'ready_to_merge' even when pauseReason is set if verdict is approved", () => {
    // ready_to_merge takes priority over needs_attention
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'approved',
          pauseReason: 'max_reviews',
        }),
      ),
    ).toBe('ready_to_merge');
  });

  // ─── done ──────────────────────────────────────────────────────────────────

  it("returns 'done' when prState is 'merged'", () => {
    expect(deriveDisplayStatus(makeInput({ prState: 'merged' }))).toBe('done');
  });

  it("returns 'done' when prState is 'closed'", () => {
    expect(deriveDisplayStatus(makeInput({ prState: 'closed' }))).toBe('done');
  });

  it("returns 'done' even when reviewVerdict is 'approved' if PR is merged", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ prState: 'merged', reviewVerdict: 'approved' }),
      ),
    ).toBe('done');
  });

  it("returns 'done' when prState is 'merged' regardless of Notion status", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🔄 In Progress', prState: 'merged' }),
      ),
    ).toBe('done');
  });

  // ─── Notion status fallback ────────────────────────────────────────────────

  it("returns 'done' when notionStatus is '✅ Done' and no PR/session", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '✅ Done',
          codeSessionStatus: null,
          prState: null,
        }),
      ),
    ).toBe('done');
  });

  it("returns 'in_review' when notionStatus is '👀 In Review' and no PR", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          codeSessionStatus: null,
          prState: null,
        }),
      ),
    ).toBe('in_review');
  });

  // ─── priority ordering ─────────────────────────────────────────────────────

  it('done (merged PR) takes priority over Notion In Progress', () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🔄 In Progress', prState: 'merged' }),
      ),
    ).toBe('done');
  });

  it('done (merged PR) takes priority over ready_to_merge', () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'merged',
          reviewVerdict: 'approved',
        }),
      ),
    ).toBe('done');
  });

  it('ready_to_merge takes priority over needs_attention (within In Review)', () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'approved',
          pauseReason: 'max_reviews',
        }),
      ),
    ).toBe('ready_to_merge');
  });

  it('needs_attention takes priority over in_review (within In Review)', () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: 'max_reviews',
        }),
      ),
    ).toBe('needs_attention');
  });
});
