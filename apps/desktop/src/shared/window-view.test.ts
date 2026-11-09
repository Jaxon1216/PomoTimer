import { describe, expect, it } from "vitest";
import { isRendererDocument, readDesktopView } from "./window-view.js";

describe("window replacement navigation", () => {
  it("restores only known pages and defaults unknown fragments to the timer", () => {
    expect(readDesktopView("#settings")).toBe("settings");
    expect(readDesktopView("#stats")).toBe("stats");
    for (const hash of ["", "#", "#other", "#settings?path=other", "#https://example.com"]) {
      expect(readDesktopView(hash)).toBe("timer");
    }
  });

  it("accepts known page fragments without relaxing the trusted resource", () => {
    const trusted = "file:///Applications/Pomodot.app/Contents/Resources/app.asar/out/renderer/index.html";
    expect(isRendererDocument(`${trusted}#settings`, trusted)).toBe(true);
    for (const candidate of [`${trusted}?external=1#settings`, `${trusted}#other`, trusted.replace("index.html", "other.html"), "https://example.com/#settings"]) {
      expect(isRendererDocument(candidate, trusted)).toBe(false);
    }
  });
});
