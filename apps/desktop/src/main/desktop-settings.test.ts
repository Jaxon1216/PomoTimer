import { describe, expect, it } from "vitest";
import { settingsPatchSchema, settingsSchema } from "../shared/contracts.js";
import { defaultSettings } from "./timer.js";

describe("desktop appearance settings IPC", () => {
  it("keeps omitted appearance fields out of unrelated patches", () => {
    expect(settingsPatchSchema.parse({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(settingsPatchSchema.parse({ followWorkspaces: false })).toEqual({ followWorkspaces: false });
    expect(settingsPatchSchema.parse({ autoFade: false })).toEqual({ autoFade: false });
    expect(settingsPatchSchema.parse({})).toEqual({});
  });

  it("requires complete settings on IPC while rejecting unknown or malformed options", () => {
    expect(settingsSchema.parse(defaultSettings)).toEqual(defaultSettings);
    const incomplete: Record<string, unknown> = { ...defaultSettings };
    delete incomplete.followWorkspaces;
    expect(settingsSchema.safeParse(incomplete).success).toBe(false);
    for (const field of ["followWorkspaces", "autoFade"] as const) {
      expect(settingsPatchSchema.safeParse({ [field]: "true" }).success).toBe(false);
      expect(settingsPatchSchema.safeParse({ [field]: null }).success).toBe(false);
    }
    expect(settingsPatchSchema.safeParse({ opacity: 0.5 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...defaultSettings, opacity: 0.5 }).success).toBe(false);
  });
});
