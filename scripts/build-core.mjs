import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const coreDirectory = join(root, "apps", "core");
const binaryName =
  process.platform === "win32" ? "pomodoro-core.exe" : "pomodoro-core";
const outputPath = join(
  root,
  "apps",
  "desktop",
  "resources",
  "core",
  binaryName,
);

mkdirSync(dirname(outputPath), { recursive: true });
execFileSync("go", ["build", "-o", outputPath, "./cmd/pomodoro-core"], {
  cwd: coreDirectory,
  stdio: "inherit",
});

if (process.platform !== "win32") {
  chmodSync(outputPath, 0o755);
}
