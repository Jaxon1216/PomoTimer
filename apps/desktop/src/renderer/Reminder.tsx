import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { CircleCheck } from "lucide-react";
import type { CompletionReminder, ReminderApi } from "../shared/reminder";

const phaseLabels = { focus: "专注", "short-break": "短休", "long-break": "长休" } as const;
const completionTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function Reminder({ api }: { api: ReminderApi }): ReactElement | null {
  const [reminder, setReminder] = useState<CompletionReminder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const [dismissingId, setDismissingId] = useState<number | null>(null);
  const currentId = useRef<number | null>(null);

  const applyReminder = useCallback((next: CompletionReminder | null) => {
    currentId.current = next?.id ?? null;
    setReminder(next);
    setError(null);
    setLoadError(null);
  }, []);

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = api.subscribeReminder((next) => {
      if (!active) return;
      receivedEvent = true;
      applyReminder(next);
    });
    void api.getReminder().then((next) => {
      // 领域：React / 提醒初始化
      // 顺序：Main 完成推送与初始读取并发 -> 保留最新事件 -> 呈现提醒。
      // 作用：防止迟到的初始读取覆盖新轮次或重新显示已经关闭的提醒。
      // 原因：独立窗口加载期间，自动计时与用户确认都可能继续发生。
      // 边界：只协调界面数据，不改变 Main 的提醒身份或计时状态。
      if (active && !receivedEvent) applyReminder(next);
    }).catch((reason: unknown) => {
      if (active && !receivedEvent) setLoadError(reason instanceof Error ? reason.message : "提醒读取失败，请重试");
    });
    return () => { active = false; unsubscribe(); };
  }, [api, applyReminder, readVersion]);

  useEffect(() => {
    if (!reminder) return;
    document.documentElement.dataset.theme = reminder.theme;
    document.documentElement.classList.toggle("dark", reminder.theme === "dark");
  }, [reminder]);

  const dismiss = useCallback(async () => {
    const id = reminder?.id;
    if (id === undefined || dismissingId === id) return;
    setDismissingId(id);
    setError(null);
    try {
      const dismissed = await api.dismissReminder(id);
      if (currentId.current !== id) return;
      if (dismissed) applyReminder(null);
      else {
        const latest = await api.getReminder();
        if (currentId.current === id) applyReminder(latest);
      }
    } catch (reason: unknown) {
      if (currentId.current === id) setError(`${reason instanceof Error ? reason.message : "提醒关闭失败"}，请重试。`);
    } finally {
      setDismissingId((current) => current === id ? null : current);
    }
  }, [api, applyReminder, dismissingId, reminder]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !reminder) return;
      event.preventDefault();
      void dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss, reminder]);

  if (!reminder) return loadError ? (
    <main className="reminderSurface reminderFailure">
      <h1>完成提醒</h1>
      <p role="alert">{loadError}</p>
      <button type="button" onClick={() => { setLoadError(null); setReadVersion((current) => current + 1); }}>重试</button>
    </main>
  ) : null;

  const focusCompleted = reminder.completedKind === "focus";
  const completedTime = completionTime.format(new Date(reminder.completedAt));
  return (
    <main className={`reminderSurface reminder-${reminder.completedKind}`}>
      <header className="reminderHeader">
        <span className="reminderBrand">POMO<span>DOT</span></span>
        <time className="reminderCompletedAt" dateTime={reminder.completedAt} aria-label={`完成时间 ${completedTime}`}>{completedTime} 完成</time>
      </header>
      <div className="reminderMessage" role="status" aria-live="polite" aria-atomic="true">
        <h1><CircleCheck size={25} aria-hidden="true" />{focusCompleted ? "专注完成" : "休息结束"}</h1>
        {focusCompleted && <p className="reminderPrompt">该休息了</p>}
        <p className="reminderNext">下一阶段：{phaseLabels[reminder.nextKind]}</p>
      </div>
      {error && <p className="reminderError" role="alert">{error}</p>}
      <footer className="reminderFooter">
        <button type="button" disabled={dismissingId === reminder.id} onClick={() => void dismiss()}>
          {dismissingId === reminder.id ? "关闭中…" : "知道了"}
        </button>
      </footer>
    </main>
  );
}
