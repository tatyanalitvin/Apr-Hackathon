// REQ-133 R13 — Reply button on MessageActions. Tests Reply visibility
// + click handler + back-compat with callers that don't supply onReply.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageActions } from "./MessageActions";

describe("MessageActions (REQ-133 R13 Reply)", () => {
  it("renders a Reply button when onReply prop is supplied", async () => {
    const user = userEvent.setup();
    render(
      <MessageActions
        onEdit={() => {}}
        onDelete={() => {}}
        onReply={() => {}}
      />,
    );
    // Actions are behind the ⋯ toggle; open first.
    await user.click(screen.getByTestId("message-actions-toggle"));
    expect(screen.getByTestId("message-reply")).toHaveTextContent("Reply");
  });

  it("fires onReply when the Reply button is clicked", async () => {
    const onReply = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageActions
        onEdit={() => {}}
        onDelete={() => {}}
        onReply={onReply}
      />,
    );
    await user.click(screen.getByTestId("message-actions-toggle"));
    await user.click(screen.getByTestId("message-reply"));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it("omits the Reply button when onReply is undefined (back-compat)", async () => {
    const user = userEvent.setup();
    render(<MessageActions onEdit={() => {}} onDelete={() => {}} />);
    await user.click(screen.getByTestId("message-actions-toggle"));
    expect(screen.queryByTestId("message-reply")).toBeNull();
    // Edit + Delete still render.
    expect(screen.getByTestId("message-edit")).toBeInTheDocument();
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
  });
});
