import { describe, expect, it } from "vitest";
import { allowsCameraPermission } from "./camera-permission.js";

type Request = Parameters<typeof allowsCameraPermission>[0];

const videoRequest: Request = {
  enabled: true,
  permission: "media",
  expectedContentsId: 12,
  contentsId: 12,
  isMainFrame: true,
  requestingUrl: "http://localhost:5174/",
  rendererUrl: "http://localhost:5174",
  mediaTypes: ["video"],
};

describe("camera permission boundary", () => {
  it("allows only the enabled main window requesting video", () => {
    expect(allowsCameraPermission(videoRequest)).toBe(true);
  });

  it.each(["timer", "settings", "stats"])("allows the same trusted document on the restored %s page", (view) => {
    expect(allowsCameraPermission({ ...videoRequest, requestingUrl: `http://localhost:5174/#${view}` })).toBe(true);
    expect(allowsCameraPermission({ ...videoRequest, requestingUrl: `http://localhost:5174/?camera=1#${view}` })).toBe(false);
  });

  it("normalizes the trailing slash added by Chromium to the development URL", () => {
    expect(allowsCameraPermission({
      ...videoRequest, rendererUrl: "http://localhost:5174/", requestingUrl: "http://localhost:5174",
    })).toBe(true);
  });

  it("allows the same absolute packaged file URL after URL normalization", () => {
    expect(allowsCameraPermission({
      ...videoRequest,
      rendererUrl: "file:///Applications/Pomodoro Timer.app/Contents/Resources/app.asar/out/renderer/index.html",
      requestingUrl: "file:///Applications/Pomodoro%20Timer.app/Contents/Resources/app.asar/out/renderer/./index.html",
    })).toBe(true);
  });

  it.each<[string, Partial<Request>]>([
    ["disabled camera mode", { enabled: false }],
    ["another permission", { permission: "notifications" }],
    ["another window", { contentsId: 13 }],
    ["missing window", { contentsId: undefined }],
    ["child frame", { isMainFrame: false }],
    ["missing URL", { requestingUrl: undefined }],
    ["invalid URL", { requestingUrl: "not a URL" }],
    ["relative URL", { requestingUrl: "/" }],
    ["invalid expected URL", { rendererUrl: "not a URL" }],
    ["another origin", { requestingUrl: "https://example.com/" }],
    ["another development port", { requestingUrl: "http://localhost:5175/" }],
    ["another path on the same origin", { requestingUrl: "http://localhost:5174/other.html" }],
    ["query added to the expected URL", { requestingUrl: "http://localhost:5174/?camera=1" }],
    ["fragment added to the expected URL", { requestingUrl: "http://localhost:5174/#other" }],
    ["unknown media type", { mediaTypes: ["unknown"] }],
    ["audio only", { mediaTypes: ["audio"] }],
    ["mixed audio and video", { mediaTypes: ["video", "audio"] }],
    ["duplicate video types", { mediaTypes: ["video", "video"] }],
    ["empty media request", { mediaTypes: [] }],
    ["missing media types", { mediaTypes: undefined }],
  ])("rejects %s", (_description, overrides) => {
    expect(allowsCameraPermission({ ...videoRequest, ...overrides })).toBe(false);
  });

  it("rejects a neighboring file even when the directory and window are trusted", () => {
    expect(allowsCameraPermission({
      ...videoRequest,
      rendererUrl: "file:///Applications/Pomodoro.app/Contents/Resources/app.asar/out/renderer/index.html",
      requestingUrl: "file:///Applications/Pomodoro.app/Contents/Resources/app.asar/out/renderer/other.html",
    })).toBe(false);
  });
});
