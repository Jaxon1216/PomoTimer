import { describe, expect, it } from "vitest";
import { completionReminderSchema, dismissReminderSchema } from "./reminder.js";

const reminder = {
  id: 1,
  completedKind: "focus",
  nextKind: "short-break",
  completedAt: "2026-11-10T09:00:00.000Z",
  theme: "light",
};

describe("completion reminder contracts", () => {
  it("accepts a resolved theme and rejects unknown fields", () => {
    expect(completionReminderSchema.parse(reminder)).toEqual(reminder);
    expect(completionReminderSchema.safeParse({ ...reminder, command: "resume" }).success).toBe(false);
    expect(completionReminderSchema.safeParse({ ...reminder, theme: "system" }).success).toBe(false);
    expect(completionReminderSchema.safeParse({ ...reminder, completedAt: "yesterday" }).success).toBe(false);
  });

  it.each([0, -1, 1.5, "1", null])("rejects invalid reminder identity %s", (id) => {
    expect(dismissReminderSchema.safeParse({ id }).success).toBe(false);
    expect(completionReminderSchema.safeParse({ ...reminder, id }).success).toBe(false);
  });

  it("allows dismissal by identity only", () => {
    expect(dismissReminderSchema.parse({ id: 2 })).toEqual({ id: 2 });
    expect(dismissReminderSchema.safeParse({ id: 2, next: true }).success).toBe(false);
  });
});
