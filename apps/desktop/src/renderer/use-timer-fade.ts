import { useEffect, useRef, useState } from "react";

// 领域：React / 桌面挂件交互
// 顺序：计时器页鼠标离开 -> 本地延迟 -> 背景与辅助控件淡化。
// 作用：仅在没有菜单、键盘焦点或拖动操作时降低视觉干扰。
// 原因：鼠标停留不动不属于离开；键盘用户和拖动中的用户仍在操作窗口。
// 边界：不读取系统闲置时间，不改变计时、感知或持久化状态。
export function useTimerFade(enabled: boolean, blocked: boolean) {
  const surface = useRef<HTMLElement>(null);
  const pointerInside = useRef(true);
  const pointerHeld = useRef(false);
  const keyboardInteraction = useRef(false);
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    let timeout: number | undefined;
    let active = true;
    const clear = () => window.clearTimeout(timeout);
    const wake = () => { clear(); setFaded(false); };
    const keyboardFocused = () => keyboardInteraction.current && element.contains(document.activeElement);
    const schedule = () => {
      clear();
      if (!active || !enabled || blocked || pointerInside.current || pointerHeld.current || keyboardFocused()) return;
      timeout = window.setTimeout(() => {
        if (active && !pointerInside.current && !pointerHeld.current && !keyboardFocused()) setFaded(true);
      }, 2_000);
    };
    const enter = (event: MouseEvent) => {
      pointerInside.current = true;
      pointerHeld.current = event.buttons !== 0;
      wake();
    };
    const leave = (event: MouseEvent) => {
      pointerInside.current = false;
      pointerHeld.current = event.buttons !== 0;
      schedule();
    };
    const press = () => { pointerHeld.current = true; keyboardInteraction.current = false; wake(); };
    const release = () => { pointerHeld.current = false; schedule(); };
    const key = () => { keyboardInteraction.current = true; wake(); schedule(); };
    const focus = () => wake();
    const focusOut = () => { queueMicrotask(schedule); };
    const blur = () => { pointerHeld.current = false; keyboardInteraction.current = false; schedule(); };
    const resize = () => { wake(); schedule(); };

    wake();
    schedule();
    element.addEventListener("mouseenter", enter);
    element.addEventListener("mouseleave", leave);
    element.addEventListener("pointerdown", press);
    element.addEventListener("focusin", focus);
    element.addEventListener("focusout", focusOut);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", resize);
    return () => {
      active = false;
      clear();
      element.removeEventListener("mouseenter", enter);
      element.removeEventListener("mouseleave", leave);
      element.removeEventListener("pointerdown", press);
      element.removeEventListener("focusin", focus);
      element.removeEventListener("focusout", focusOut);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", resize);
    };
  }, [enabled, blocked]);

  return { surface, faded: enabled && !blocked && faded };
}
