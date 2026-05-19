import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PRPanel } from "../PRPanel";
import type { PRListItem } from "../PRCard";

function makePR(overrides: Partial<PRListItem> = {}): PRListItem {
  return {
    prNumber: 1,
    prUrl: "https://github.com/owner/repo/pull/1",
    repo: "owner/repo",
    title: "My PR",
    headBranch: "feature/foo",
    baseBranch: "dev",
    state: "open",
    notionTaskId: null,
    notionTaskTitle: null,
    sessionId: null,
    reviewSessionId: null,
    reviewResult: null,
    reviewedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    mergeState: null,
    ...overrides,
  };
}

describe("PRPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a card for each item returned by GET /api/prs", async () => {
    const prs = [
      makePR({ prNumber: 1, title: "PR One" }),
      makePR({ prNumber: 2, title: "PR Two" }),
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => prs,
    });

    render(<PRPanel activeProjectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByText("PR One")).toBeDefined();
      expect(screen.getByText("PR Two")).toBeDefined();
    });
  });

  it("shows empty state when no PRs returned", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    render(<PRPanel activeProjectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no open pull requests/i)).toBeDefined();
    });
  });

  it("shows no-repo state when project has no githubRepo", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: "Project has no githubRepo configured" }),
    });

    render(<PRPanel activeProjectId="proj-no-repo" />);

    await waitFor(() => {
      expect(screen.getByText(/no github repo configured/i)).toBeDefined();
    });
  });

  it("shows network error banner on fetch failure", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );

    render(<PRPanel activeProjectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByText(/could not reach server/i)).toBeDefined();
    });
  });
});

describe("PRPanel — per-card ErrorBoundary isolation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "error").mockImplementation(() => {
      /* silence React's logged error */
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.doUnmock("../PRCard");
    vi.resetModules();
  });

  it("a throw inside one PRCard does not crash PRPanel; other PR cards still render", async () => {
    const prs = [
      makePR({ prNumber: 1, title: "PR One" }),
      makePR({ prNumber: 2, title: "Broken PR" }),
      makePR({ prNumber: 3, title: "PR Three" }),
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => prs,
    });

    vi.resetModules();
    vi.doMock("../PRCard", () => ({
      PRCard: ({ pr }: { pr: PRListItem }) => {
        if (pr.prNumber === 2) throw new Error("boom");
        return <div data-testid={`pr-${pr.prNumber}`}>{pr.title}</div>;
      },
    }));

    const { PRPanel: PRPanelIsolated } = await import("../PRPanel");

    render(<PRPanelIsolated activeProjectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("pr-1")).toBeDefined();
      expect(screen.getByTestId("pr-3")).toBeDefined();
    });
    expect(screen.queryByTestId("pr-2")).toBeNull();
    expect(screen.getByText(/pr card failed to render/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
  });
});
