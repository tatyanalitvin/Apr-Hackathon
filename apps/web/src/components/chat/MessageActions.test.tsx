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

// REQ-212 — admins delete other members' messages but cannot edit them
// (v3 §2.5.5 grants admins delete only, not edit). MessageActions must
// therefore tolerate an undefined `onEdit` and drop the Edit button
// without breaking Delete / Reply rendering.
describe("MessageActions (REQ-212 admin-delete — optional Edit)", () => {
  it("omits the Edit button when onEdit is undefined", async () => {
    const user = userEvent.setup();
    render(<MessageActions onDelete={() => {}} onReply={() => {}} />);
    await user.click(screen.getByTestId("message-actions-toggle"));
    expect(screen.queryByTestId("message-edit")).toBeNull();
    // Reply + Delete still render.
    expect(screen.getByTestId("message-reply")).toBeInTheDocument();
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
  });

  it("still fires onDelete with confirm flow when onEdit is undefined", async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(<MessageActions onDelete={onDelete} />);
    await user.click(screen.getByTestId("message-actions-toggle"));
    await user.click(screen.getByTestId("message-delete"));
    await user.click(screen.getByTestId("message-delete-confirm"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
