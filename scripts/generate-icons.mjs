import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Export the selected raster artwork to the platform icon containers. This
// macOS-only asset tool uses sips/iconutil; application builds use its outputs.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const icons = join(root, "apps/desktop/resources/icons");
const master = join(icons, "pomodoro-timer-master.png");
const temporary = await mkdtemp(join(tmpdir(), "pomodot-icons-"));

function resize(size, destination) {
  execFileSync("sips", ["-z", String(size), String(size), master, "--out", destination], { stdio: "ignore" });
}

try {
  const iconset = join(temporary, "pomodoro.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    resize(size, join(iconset, `icon_${size}x${size}.png`));
    resize(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(icons, "pomodoro-timer.icns")]);

  // ICO entries contain PNG frames, including the full 256px Windows icon.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const size of sizes) {
    const path = join(temporary, `${size}.png`);
    resize(size, path);
    frames.push(await readFile(path));
  }
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    directory[entry] = sizes[index] % 256;
    directory[entry + 1] = sizes[index] % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(join(icons, "pomodoro-timer.ico"), Buffer.concat([directory, ...frames]));
  resize(36, join(icons, "pomodoro-timer.png"));
  console.log("Exported macOS ICNS, Windows ICO, and 36px tray PNG from the 1024px master.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
