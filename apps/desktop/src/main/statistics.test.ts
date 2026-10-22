import { describe, expect, it } from "vitest";
import { collectStatistics } from "./statistics.js";

describe("collectStatistics", () => {
  it("groups a completed round by the local date and pads the current Monday-to-Sunday week", () => {
    const now = new Date(2026, 9, 22, 23, 59);
    const rows = [{ localDate: "2026-10-22", completedFocusMinutes: 30, completedFocusRounds: 1 }];
    const result = collectStatistics({ dailyTotals: () => rows }, now);
    expect(result.today).toEqual(rows[0]);
    expect(result.week.map((day) => day.localDate)).toEqual([
      "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25",
    ]);
    expect(result.heatmap.at(-1)).toEqual(rows[0]);
    expect(result.heatmap).toHaveLength(365);
  });

  it("rolls today over at local midnight without moving yesterday's completion", () => {
    const rows = [{ localDate: "2026-10-22", completedFocusMinutes: 30, completedFocusRounds: 1 }];
    const result = collectStatistics({ dailyTotals: () => rows }, new Date(2026, 9, 23, 0, 0));
    expect(result.today).toEqual({ localDate: "2026-10-23", completedFocusMinutes: 0, completedFocusRounds: 0 });
    expect(result.heatmap.at(-2)).toEqual(rows[0]);
    expect(result.heatmap.at(-1)?.localDate).toBe("2026-10-23");
  });
});
