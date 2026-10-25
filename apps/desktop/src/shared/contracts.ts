import { z } from "zod";

export const roundKindSchema = z.enum(["focus", "short-break", "long-break"]);
export type RoundKind = z.infer<typeof roundKindSchema>;
export const timerStatusSchema = z.enum(["idle", "running", "auto-paused", "manual-paused"]);
export type TimerStatus = z.infer<typeof timerStatusSchema>;
export const presenceSchema = z.enum(["present", "away", "unknown"]);
export type Presence = z.infer<typeof presenceSchema>;
export const presenceSourceSchema = z.enum(["input", "camera"]);
export type PresenceSource = z.infer<typeof presenceSourceSchema>;
export const breakModeSchema = z.enum(["active", "desk"]);
export type BreakMode = z.infer<typeof breakModeSchema>;
export const pauseReasonSchema = z.enum(["none", "input-away", "break-condition", "system-suspend", "system-lock", "core-recovery", "source-unavailable", "storage-unavailable"]);
export type PauseReason = z.infer<typeof pauseReasonSchema>;

export const roundSchema = z.object({
  kind: roundKindSchema,
  cycleNumber: z.number().int().min(1),
  positionInCycle: z.number().int().min(1),
  focusRoundNumber: z.number().int().min(1).nullable(),
  breakMode: breakModeSchema.nullable(),
  totalDurationMs: z.number().int().positive(),
}).strict();
export type Round = z.infer<typeof roundSchema>;

export const automationStateSchema = z.object({
  activePresenceSource: presenceSourceSchema,
  inputPresence: presenceSchema,
  cameraPresence: z.literal("unknown"),
  inputMonitoringAvailable: z.boolean(),
  cameraMonitoringAvailable: z.literal(false),
  manualPauseLocked: z.boolean(),
  pauseReason: pauseReasonSchema,
}).strict();
export type AutomationState = z.infer<typeof automationStateSchema>;

export const timerSnapshotSchema = z.object({
  revision: z.number().int().min(0),
  emittedAt: z.string().datetime({ offset: true }),
  round: roundSchema,
  // Optional while reading snapshots written before the cycle-boundary fix.
  // TimerEngine normalizes legacy snapshots before exposing them to IPC.
  activeCycleRounds: z.number().int().min(1).max(8).optional(),
  status: timerStatusSchema,
  remainingMs: z.number().int().nonnegative(),
  automation: automationStateSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.status === "manual-paused" && !snapshot.automation.manualPauseLocked) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["automation", "manualPauseLocked"], message: "手动暂停必须保持锁定" });
  }
  if (snapshot.status !== "manual-paused" && snapshot.automation.manualPauseLocked) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["automation", "manualPauseLocked"], message: "非手动暂停状态不能保留手动暂停锁" });
  }
});
export type TimerSnapshot = z.infer<typeof timerSnapshotSchema>;

export const settingsSchema = z.object({
  version: z.literal(1),
  focusDurationSeconds: z.number().int().min(300).max(7200),
  shortBreakDurationSeconds: z.number().int().min(60).max(3600),
  longBreakDurationSeconds: z.number().int().min(60).max(5400),
  focusRoundsPerCycle: z.number().int().min(1).max(8),
  inputIdleThresholdSeconds: z.number().int().min(10).max(600),
  focusPresenceSource: z.literal("input"),
  defaultBreakMode: breakModeSchema,
  theme: z.enum(["light", "dark", "system"]),
  alwaysOnTop: z.boolean(),
  notificationsEnabled: z.boolean(),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.omit({ version: true }).partial().strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const dailyFocusTotalSchema = z.object({ localDate: z.string(), completedFocusMinutes: z.number().int().nonnegative(), completedFocusRounds: z.number().int().nonnegative() }).strict();
export type DailyFocusTotal = z.infer<typeof dailyFocusTotalSchema>;
export const statisticsSnapshotSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  today: dailyFocusTotalSchema,
  week: z.array(dailyFocusTotalSchema),
  heatmap: z.array(dailyFocusTotalSchema),
}).strict();
export type StatisticsSnapshot = z.infer<typeof statisticsSnapshotSchema>;

export const capabilitiesSchema = z.object({ inputMonitoring: z.boolean(), cameraPresence: z.literal(false), standingFocus: z.literal(false) }).strict();
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const timerCommandSchema = z.enum(["start", "pause", "resume", "next", "reset"]);
export type TimerCommand = z.infer<typeof timerCommandSchema>;
export const coreEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("timer.snapshot"), snapshot: timerSnapshotSchema }).strict(),
  z.object({ type: z.literal("stats.changed"), statistics: statisticsSnapshotSchema }).strict(),
  z.object({ type: z.literal("core.error"), code: z.string(), message: z.string(), recoverable: z.boolean() }).strict(),
]);
export type CoreEvent = z.infer<typeof coreEventSchema>;

export interface PomodoroApi {
  getSnapshot(): Promise<TimerSnapshot>;
  command(command: TimerCommand): Promise<TimerSnapshot>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  getCapabilities(): Promise<Capabilities>;
  getStatistics(): Promise<StatisticsSnapshot>;
  subscribe(listener: (event: CoreEvent) => void): () => void;
}
