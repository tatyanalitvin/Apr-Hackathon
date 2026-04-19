import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, act, waitFor } from "@testing-library/react";
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
    // REQ-133 R12: `onSend` is (body, attachmentIds?, replyToId?).
    // Non-reply + no-attachment send passes both trailing args as undefined.
    expect(onSend).toHaveBeenCalledWith("hello", undefined, undefined);
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

describe("MessageComposer attachments (S2)", () => {
  it("uploads a dropped image then sends it as attachmentIds", async () => {
    const onUpload = vi.fn(async () => ({ attachmentId: "att-1" }));
    const onSend = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = render(
      <MessageComposer userId="u1" roomId="general" onSend={onSend} onUpload={onUpload} />,
    );

    const file = new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" });
    const dropZone = container.querySelector(".border-t") as HTMLElement;
    await act(async () => {
      fireEvent.drop(dropZone, { dataTransfer: { files: [file], types: ["Files"] } });
    });
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file));

    await user.type(screen.getByLabelText("Message"), "look!");
    const send = screen.getByRole("button", { name: /send/i });
    await waitFor(() => expect(send).not.toBeDisabled());
    await user.click(send);
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("look!", ["att-1"], undefined),
    );
  });

  it("rejects a >20MB file before upload", async () => {
    const onUpload = vi.fn();
    const onSend = vi.fn();
    const { container } = render(
      <MessageComposer userId="u1" roomId="general" onSend={onSend} onUpload={onUpload} />,
    );
    const huge = new File([new Uint8Array(1)], "big.bin", { type: "application/octet-stream" });
    Object.defineProperty(huge, "size", { value: 25 * 1024 * 1024 });

    const dropZone = container.querySelector(".border-t") as HTMLElement;
    await act(async () => {
      fireEvent.drop(dropZone, { dataTransfer: { files: [huge], types: ["Files"] } });
    });

    expect(onUpload).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/too large/i);
  });

  it("rejects a >3MB image before upload", async () => {
    const onUpload = vi.fn();
    const onSend = vi.fn();
    const { container } = render(
      <MessageComposer userId="u1" roomId="general" onSend={onSend} onUpload={onUpload} />,
    );
    const bigImage = new File([new Uint8Array(1)], "big.png", { type: "image/png" });
    Object.defineProperty(bigImage, "size", { value: 4 * 1024 * 1024 });

    const dropZone = container.querySelector(".border-t") as HTMLElement;
    await act(async () => {
      fireEvent.drop(dropZone, { dataTransfer: { files: [bigImage], types: ["Files"] } });
    });

    expect(onUpload).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/too large/i);
  });

  it("uploads a pasted file", async () => {
    const onUpload = vi.fn(async () => ({ attachmentId: "att-paste" }));
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageComposer userId="u1" roomId="general" onSend={onSend} onUpload={onUpload} />);

    const file = new File([new Uint8Array([1])], "clip.png", { type: "image/png" });
    const ta = screen.getByLabelText("Message");
    await act(async () => {
      fireEvent.paste(ta, { clipboardData: { files: [file], types: ["Files"] } });
    });
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file));
  });
});

describe("MessageComposer reply chip (REQ-133 R12)", () => {
  it("renders the Replying-to chip when replyTo prop is set", () => {
    render(
      <MessageComposer
        userId="u1"
        roomId="general"
        onSend={() => {}}
        replyTo={{ messageId: "p1", authorUsername: "alice" }}
        onClearReply={() => {}}
      />,
    );
    const chip = screen.getByTestId("reply-chip");
    expect(chip).toHaveTextContent(/replying to/i);
    expect(chip).toHaveTextContent("alice");
  });

  it("omits the chip when replyTo is null/undefined", () => {
    const { rerender } = render(
      <MessageComposer userId="u1" roomId="general" onSend={() => {}} replyTo={null} />,
    );
    expect(screen.queryByTestId("reply-chip")).toBeNull();

    rerender(<MessageComposer userId="u1" roomId="general" onSend={() => {}} />);
    expect(screen.queryByTestId("reply-chip")).toBeNull();
  });

  it("fires onClearReply when the chip × is clicked", async () => {
    const onClearReply = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageComposer
        userId="u1"
        roomId="general"
        onSend={() => {}}
        replyTo={{ messageId: "p1", authorUsername: "alice" }}
        onClearReply={onClearReply}
      />,
    );
    await user.click(screen.getByTestId("reply-chip-clear"));
    expect(onClearReply).toHaveBeenCalledTimes(1);
  });

  it("Enter-submit passes replyToId as the 3rd positional arg and clears the chip", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onClearReply = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageComposer
        userId="u1"
        roomId="general"
        onSend={onSend}
        replyTo={{ messageId: "parent-id-123", authorUsername: "alice" }}
        onClearReply={onClearReply}
      />,
    );
    const ta = screen.getByLabelText("Message");
    await user.type(ta, "ack{Enter}");
    // body, attachmentIds (undefined — no attachments), replyToId.
    expect(onSend).toHaveBeenCalledWith("ack", undefined, "parent-id-123");
    // Parent is asked to drop the chip after a successful send.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onClearReply).toHaveBeenCalledTimes(1);
  });

  it("preserves chip + replyToId when onSend rejects (user can retry)", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const onClearReply = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageComposer
        userId="u1"
        roomId="general"
        onSend={onSend}
        replyTo={{ messageId: "p1", authorUsername: "alice" }}
        onClearReply={onClearReply}
      />,
    );
    const ta = screen.getByLabelText("Message");
    await user.type(ta, "retry-me{Enter}");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // Draft persisted, chip still there, onClearReply NOT called yet.
    expect(ta).toHaveValue("retry-me");
    expect(screen.getByTestId("reply-chip")).toBeInTheDocument();
    expect(onClearReply).not.toHaveBeenCalled();

    // Retry succeeds.
    const send = screen.getByRole("button", { name: /send/i });
    await user.click(send);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSend).toHaveBeenNthCalledWith(2, "retry-me", undefined, "p1");
    expect(onClearReply).toHaveBeenCalledTimes(1);
  });
});
