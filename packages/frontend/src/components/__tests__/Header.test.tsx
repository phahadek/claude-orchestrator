import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Header } from "../Header";

describe("Header", () => {
  const defaultProps = {
    projects: [],
    activeProjectId: null,
    onProjectChange: vi.fn(),
    activeBoardId: null,
    onBoardChange: vi.fn(),
    activeView: "sessions" as const,
    onViewChange: vi.fn(),
  };

  it("renders Tasks, Sessions, PRs, and Settings nav buttons", () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Tasks" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeDefined();
    expect(screen.getByRole("button", { name: "PRs" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Settings" })).toBeDefined();
  });

  it('calls onViewChange with "tasks" when Tasks button is clicked', () => {
    const onViewChange = vi.fn();
    render(<Header {...defaultProps} onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(onViewChange).toHaveBeenCalledWith("tasks");
  });

  it('calls onViewChange with "prs" when PRs button is clicked', () => {
    const onViewChange = vi.fn();
    render(<Header {...defaultProps} onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole("button", { name: "PRs" }));
    expect(onViewChange).toHaveBeenCalledWith("prs");
  });

  it('calls onViewChange with "settings" when Settings button is clicked', () => {
    const onViewChange = vi.fn();
    render(<Header {...defaultProps} onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onViewChange).toHaveBeenCalledWith("settings");
  });
});
