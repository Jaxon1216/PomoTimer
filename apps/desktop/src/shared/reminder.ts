import { z } from "zod";
import { roundKindSchema } from "./contracts.js";

export const completionReminderSchema = z.object({
  id: z.number().int().positive(),
  completedKind: roundKindSchema,
  nextKind: roundKindSchema,
  completedAt: z.string().datetime({ offset: true }),
  theme: z.enum(["light", "dark"]),
}).strict();
export type CompletionReminder = z.infer<typeof completionReminderSchema>;
export const nullableCompletionReminderSchema = completionReminderSchema.nullable();
export const dismissReminderSchema = z.object({ id: z.number().int().positive() }).strict();

// ReminderApi 是完成提醒窗口唯一可用的应用接口。
//
// 领域：TypeScript / 提醒契约
// 顺序：提醒视图 -> 专用 Preload -> Main 提醒状态。
// 作用：读取、订阅和确认已经提交的轮次完成提醒。
// 原因：关闭提醒不能隐式开始、暂停或切换任何计时轮次。
// 边界：不暴露主窗口命令、设置、统计或摄像头能力。
export interface ReminderApi {
  getReminder(): Promise<CompletionReminder | null>;
  dismissReminder(id: number): Promise<boolean>;
  subscribeReminder(listener: (reminder: CompletionReminder | null) => void): () => void;
}
