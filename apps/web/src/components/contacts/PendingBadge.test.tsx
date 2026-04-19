import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PendingBadge } from "./PendingBadge";

describe("REQ-136 — PendingBadge count binding", () => {
  it("renders nothing when count is zero", () => {
    const { container } = render(<PendingBadge count={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when count is negative (defensive)", () => {
    const { container } = render(<PendingBadge count={-3} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the numeric count when positive", () => {
    render(<PendingBadge count={3} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("collapses counts above 99 to '99+'", () => {
    render(<PendingBadge count={150} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("pluralizes the aria-label correctly", () => {
    const { rerender } = render(<PendingBadge count={1} />);
    expect(screen.getByLabelText("1 pending friend request")).toBeInTheDocument();
    rerender(<PendingBadge count={5} />);
    expect(screen.getByLabelText("5 pending friend requests")).toBeInTheDocument();
  });
});
