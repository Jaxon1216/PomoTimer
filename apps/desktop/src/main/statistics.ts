import { statisticsSnapshotSchema, type DailyFocusTotal, type StatisticsSnapshot } from "../shared/contracts.js";

interface StatisticsStore {
  dailyTotals(startDate: string, endDate: string): DailyFocusTotal[];
}

export function localDateKey(date: Date): string {
  return date.toLocaleDateString("sv-SE");
}

// 领域：统计 / 本地日期
// 顺序：Main 统计刷新 -> Store 日期聚合 -> Renderer。
// 作用：从同一墙钟采样生成今日、本周和热力图日期，补齐没有完成记录的日期。
// 原因：跨午夜和夏令时不能用固定毫秒偏移推算本地日期。
// 边界：只读取完成记录，不改变计时器或将未完成轮次纳入统计。
export function collectStatistics(store: StatisticsStore, now = new Date()): StatisticsSnapshot {
  const dateAtOffset = (offset: number): string => {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    return localDateKey(date);
  };
  const today = localDateKey(now);
  const mondayOffset = (now.getDay() + 6) % 7;
  const rows = new Map(store.dailyTotals(dateAtOffset(-364), dateAtOffset(6 - mondayOffset)).map((row) => [row.localDate, row]));
  const totalFor = (localDate: string): DailyFocusTotal => rows.get(localDate) ?? { localDate, completedFocusMinutes: 0, completedFocusRounds: 0 };
  return statisticsSnapshotSchema.parse({
    generatedAt: now.toISOString(),
    today: totalFor(today),
    week: Array.from({ length: 7 }, (_, index) => totalFor(dateAtOffset(index - mondayOffset))),
    heatmap: Array.from({ length: 365 }, (_, index) => totalFor(dateAtOffset(index - 364))),
  });
}
