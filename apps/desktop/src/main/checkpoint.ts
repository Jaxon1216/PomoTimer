import { z } from "zod";
import { timerProgressSchema, type TimerSnapshot } from "../shared/contracts.js";

// 领域：Timer / SQLite 检查点
// 顺序：TimerEngine -> 进度字段白名单 -> SqliteStore，包括轮次完成事务。
// 作用：仅保留重启计时所需的状态和系统挂起原因。
// 原因：presence、检测可用性和由样本推断的暂停原因只在本次运行有效。
// 边界：IPC 继续传递完整快照，不能将它直接序列化到 SQLite。
export const timerCheckpointSchema = timerProgressSchema.extend({ interruption: z.literal("system-suspend").optional() });
export type TimerCheckpoint = z.infer<typeof timerCheckpointSchema>;

export function checkpointOf(snapshot: TimerSnapshot): TimerCheckpoint {
  const { revision, emittedAt, round, activeCycleRounds, status, remainingMs } = snapshot;
  return {
    revision, emittedAt, round, activeCycleRounds, status, remainingMs,
    ...(status === "auto-paused" && snapshot.automation.pauseReason === "system-suspend" ? { interruption: "system-suspend" } : {}),
  };
}
