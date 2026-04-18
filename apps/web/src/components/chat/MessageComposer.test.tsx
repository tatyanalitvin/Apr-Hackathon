import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageComposer } from "./MessageComposer";

beforeEach(() => {
  window.localStorage.clear();
});

describe("MessageComposer (REQ-046, R5)", () => {
  it("sends on Enter, clears the textarea (R5: Enter)", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<MessageComposer userId="u1" roomId="general" onSend={onSend} />);
    const ta = screen.getByLabelText("Message");
    await user.type(ta, "hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(ta).toHaveValue("");
  });

  it("Shift+Enter inserts newline and does NOT send (R5: Shift+Enter)", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer userId="u1" roomId="general" onSend={onSend} />);
    const ta = screen.getByLabelText("Message");
    await user.type(ta, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onSend).not.toHaveBeenCalled();
    expect(ta).toHaveValue("line1\nline2");
  });

  it("Tab advances focus to Send button (R5: Tab doesn't submit)", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer userId="u1" roomId="general" onSend={onSend} />);
    const ta = screen.getByLabelText("Message");
    await user.type(ta, "hi");
    // Send becomes enabled when trimmed is non-empty.
    await user.tab();
    const sendBtn = screen.getByRole("button", { name: /send/i });
    expect(document.activeElement).toBe(sendBtn);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables Send when body is empty or whitespace-only (R5: empty)", async () => {
    render(<MessageComposer userId="u1" roomId="general" onSend={() => {}} />);
    const send = screen.getByRole("button", { name: /send/i });
    expect(send).toBeDisabled();
  });

  it("disables Send when body exceeds 3072 bytes (R5: byte-limit)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer userId="u1" roomId="general" onSend={onSend} />);
    const ta = screen.getByLabelText("Message");
    const tooLong = "a".repeat(3073);
    // Use paste to avoid typing 3073 characters one by one.
    ta.focus();
    await user.paste(tooLong);
    const send = screen.getByRole("button", { name: /send/i });
    expect(send).toBeDisabled();
  });

  it("shows live byte counter once body ≥ 2800 bytes (R5: live counter)", async () => {
    const user = userEvent.setup();
    render(<MessageComposer userId="u1" roomId="general" onSend={() => {}} />);
    const ta = screen.getByLabelText("Message");
    ta.focus();
    await user.paste("a".repeat(2800));
    // The counter element always renders; assert its visible (non-transparent) color class appears.
    const counter = screen.getByText("2800 / 3072");
    expect(counter.className).toMatch(/text-(amber|destructive)/);
  });

  it("hydrates draft from localStorage on mount (R5b)", async () => {
    window.localStorage.setItem("s1-draft:u1:general", "saved draft");
    render(<MessageComposer userId="u1" roomId="general" onSend={() => {}} />);
    const ta = screen.getByLabelText("Message");
    expect(ta).toHaveValue("saved draft");
  });

  it("clears draft on successful send (R5b)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageComposer userId="u1" roomId="general" onSend={onSend} />);
    const ta = screen.getByLabelText("Message");
    await user.type(ta, "bye{Enter}");
    // Allow draft cleanup after async send.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(window.localStorage.getItem("s1-draft:u1:general")).toBeNull();
  });

  it("preserves draft and re-enables Send when onSend rejects (R5)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(undefined);
    render(<MessageComposer userId="u1" roomId="general" onSend={onSend} />);
    const ta = screen.getByLabelText("Message");

    await user.type(ta, "retry-me{Enter}");
    // onSend rejected — draft MUST NOT clear, and no unhandled rejection must escape.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(ta).toHaveValue("retry-me");
    const send = screen.getByRole("button", { name: /send/i });
    expect(send).not.toBeDisabled();

    // Second attempt succeeds.
    await user.click(send);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(ta).toHaveValue("");
  });
});
