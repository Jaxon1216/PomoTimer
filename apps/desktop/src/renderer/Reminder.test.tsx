import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletionReminder, ReminderApi } from "../shared/reminder";
import { Reminder } from "./Reminder";

const focusReminder: CompletionReminder = {
  id: 1,
  completedKind: "focus",
  nextKind: "short-break",
  completedAt: "2026-11-10T09:00:00.000Z",
  theme: "light",
};

function createApi(initial: CompletionReminder | null = focusReminder) {
  let listener: ((reminder: CompletionReminder | null) => void) | undefined;
  const unsubscribe = vi.fn();
  const api: ReminderApi = {
    getReminder: vi.fn().mockResolvedValue(initial),
    dismissReminder: vi.fn().mockResolvedValue(true),
    subscribeReminder: vi.fn((next) => { listener = next; return unsubscribe; }),
  };
  return { api, unsubscribe, publish: (next: CompletionReminder | null) => act(() => listener?.(next)) };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove("dark");
});

describe("Reminder", () => {
  it("shows focus completion until explicitly acknowledged", async () => {
    const { api } = createApi();
    render(<Reminder api={api} />);
    expect(await screen.findByRole("heading", { name: "专注完成" })).toBeVisible();
    expect(screen.getByText("该休息了")).toBeVisible();
    expect(screen.getByText("下一阶段：短休")).toBeVisible();
    const completedTime = screen.getByLabelText(/^完成时间 \d{2}:\d{2}$/);
    expect(completedTime).toHaveAttribute("datetime", focusReminder.completedAt);

    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(300_000));
    expect(screen.getByRole("button", { name: "知道了" })).toBeEnabled();
    expect(api.dismissReminder).not.toHaveBeenCalled();
  });

  it("replaces an earlier completion and updates its theme without starting a round", async () => {
    const { api, publish } = createApi();
    render(<Reminder api={api} />);
    await screen.findByRole("heading", { name: "专注完成" });
    publish({ ...focusReminder, id: 2, completedKind: "short-break", nextKind: "focus", theme: "dark" });
    expect(screen.getByRole("heading", { name: "休息结束" })).toBeVisible();
    expect(screen.getByText("下一阶段：专注")).toBeVisible();
    expect(screen.queryByText("该休息了")).not.toBeInTheDocument();
    expect(document.documentElement).toHaveClass("dark");
    expect(api.dismissReminder).not.toHaveBeenCalled();
  });

  it("acknowledges only the displayed reminder and supports Escape", async () => {
    const { api } = createApi();
    render(<Reminder api={api} />);
    await screen.findByRole("heading", { name: "专注完成" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(api.dismissReminder).toHaveBeenCalledWith(1));
    expect(api.dismissReminder).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
  });

  it("keeps a failed acknowledgment visible and allows retry", async () => {
    const { api } = createApi();
    vi.mocked(api.dismissReminder).mockRejectedValueOnce(new Error("关闭失败"));
    render(<Reminder api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "知道了" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("关闭失败");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(api.dismissReminder).toHaveBeenCalledTimes(2));
  });

  it("does not dismiss a newer completion when an old acknowledgment resolves", async () => {
    const { api, publish } = createApi();
    let resolveDismiss: ((dismissed: boolean) => void) | undefined;
    vi.mocked(api.dismissReminder).mockImplementation(() => new Promise((resolve) => { resolveDismiss = resolve; }));
    render(<Reminder api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "知道了" }));
    publish({ ...focusReminder, id: 2, completedKind: "long-break", nextKind: "focus" });
    await act(async () => resolveDismiss?.(true));
    expect(screen.getByRole("heading", { name: "休息结束" })).toBeVisible();
    expect(screen.getByRole("button", { name: "知道了" })).toBeEnabled();
  });

  it("does not replace a live event with a late initial read", async () => {
    const { api, publish } = createApi();
    let resolveInitial: ((value: CompletionReminder | null) => void) | undefined;
    vi.mocked(api.getReminder).mockImplementation(() => new Promise((resolve) => { resolveInitial = resolve; }));
    render(<Reminder api={api} />);
    publish({ ...focusReminder, id: 2, completedKind: "short-break", nextKind: "focus" });
    await act(async () => resolveInitial?.(focusReminder));
    expect(screen.getByRole("heading", { name: "休息结束" })).toBeVisible();
  });

  it("clears the view from Main and unsubscribes on unmount", async () => {
    const { api, publish, unsubscribe } = createApi();
    const { unmount } = render(<Reminder api={api} />);
    await screen.findByRole("heading", { name: "专注完成" });
    publish(null);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
