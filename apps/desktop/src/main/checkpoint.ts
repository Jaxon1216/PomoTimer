import { z } from "zod";
import { breakModeSchema, timerProgressSchema, timerSnapshotSchema, type BreakMode, type TimerSnapshot } from "../shared/contracts.js";

// 领域：Timer / SQLite 检查点
// 顺序：TimerEngine -> 进度字段白名单 -> SqliteStore，包括轮次完成事务。
// 作用：保留计时进度、系统挂起原因，以及大站切回时需要的原休息方式。
// 原因：presence、检测可用性和由样本推断的暂停原因只在本次运行有效。
// 边界：IPC 继续传递完整快照，旧快照中的 hasStarted 在读取边界剥离，不再写回。
export const timerCheckpointSchema = timerProgressSchema.extend({
  interruption: z.literal("system-suspend").optional(),
  ordinaryBreakMode: breakModeSchema.optional(),
}).superRefine((checkpoint, context) => {
  if (checkpoint.ordinaryBreakMode !== undefined && checkpoint.round.breakMode !== "standing") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ordinaryBreakMode"], message: "只有大站轮次记录原休息方式" });
  }
});
export type TimerCheckpoint = z.infer<typeof timerCheckpointSchema>;

const withoutLegacyRoundStart = z.object({
  round: z.object({ hasStarted: z.boolean().optional() }).passthrough().transform((round) => {
    delete round.hasStarted;
    return round;
  }),
}).passthrough();

export const storedTimerCheckpointSchema = withoutLegacyRoundStart.pipe(timerCheckpointSchema);
export const legacyTimerSnapshotSchema = withoutLegacyRoundStart.pipe(timerSnapshotSchema);

export function checkpointOf(snapshot: TimerSnapshot, ordinaryBreakMode?: BreakMode): TimerCheckpoint {
  const { revision, emittedAt, round, activeCycleRounds, status, remainingMs } = snapshot;
  return {
    revision, emittedAt, round, activeCycleRounds, status, remainingMs,
    ...(round.breakMode === "standing" && ordinaryBreakMode !== undefined ? { ordinaryBreakMode } : {}),
    ...(status === "auto-paused" && snapshot.automation.pauseReason === "system-suspend" ? { interruption: "system-suspend" } : {}),
  };
}
