import { z } from "zod";

const desktopViewSchema = z.enum(["timer", "settings", "stats"]);
export type DesktopView = z.infer<typeof desktopViewSchema>;

// 领域：界面 / 窗口导航
// 顺序：Renderer 页面导航 -> URL fragment -> Main 重建窗口 -> Renderer 初始页面。
// 作用：仅恢复三个已知页面，忽略其他 fragment。
// 原因：切换 macOS 窗口类型不应丢失当前页面，也不应允许任意导航。
// 边界：只记录临时页面，不保存计时、表单或检测数据。
export function readDesktopView(hash: string): DesktopView {
  const result = desktopViewSchema.safeParse(hash.replace(/^#/, ""));
  return result.success ? result.data : "timer";
}

export function isRendererDocument(candidateUrl: string, trustedUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    if (candidate.hash && !desktopViewSchema.safeParse(candidate.hash.slice(1)).success) return false;
    candidate.hash = "";
    const trusted = new URL(trustedUrl);
    trusted.hash = "";
    return candidate.href === trusted.href;
  } catch {
    return false;
  }
}
