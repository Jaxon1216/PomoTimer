import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

// Export the selected raster artwork to the platform icon containers. This
// macOS-only asset tool uses sips/iconutil; application builds use its outputs.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const icons = join(root, "apps/desktop/resources/icons");
const master = join(icons, "pomodoro-timer-master.png");
const temporary = await mkdtemp(join(tmpdir(), "pomodot-icons-"));

function resize(size, destination) {
  execFileSync("sips", ["-z", String(size), String(size), master, "--out", destination], { stdio: "ignore" });
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.concat([name, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = currentPoint.y > y !== previousPoint.y > y
      && x < ((previousPoint.x - currentPoint.x) * (y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function renderTrayTemplate(size) {
  const supersample = 8;
  const sourceSize = 32;
  const bytes = Buffer.alloc(size * size * 4);
  const hand = [
    { x: 14.5, y: 14.5 },
    { x: 17, y: 13.05 },
    { x: 21.8, y: 15.82 },
    { x: 20.3, y: 18.42 },
    { x: 14.5, y: 15.07 },
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let coverage = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const sourceX = (x + (sx + 0.5) / supersample) * sourceSize / size;
          const sourceY = (y + (sy + 0.5) / supersample) * sourceSize / size;
          const distance = Math.hypot(sourceX - 16, sourceY - 16);
          const ring = distance <= 13.5 && distance >= 10.5;
          const stem = sourceX >= 13.5 && sourceX <= 18.5 && sourceY >= 1.5 && sourceY <= 5.5;
          if (ring || stem || pointInPolygon(sourceX, sourceY, hand)) coverage += 1;
        }
      }
      const alpha = Math.round((coverage / (supersample * supersample)) * 255);
      const offset = (y * size + x) * 4;
      bytes[offset] = 0;
      bytes[offset + 1] = 0;
      bytes[offset + 2] = 0;
      bytes[offset + 3] = alpha;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0;
    bytes.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

try {
  const iconset = join(temporary, "pomodoro.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    resize(size, join(iconset, `icon_${size}x${size}.png`));
    resize(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  try {
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(icons, "pomodoro-timer.icns")]);
  } catch (error) {
    // macOS 26's iconutil rejects otherwise valid legacy iconsets; retain the
    // last known-good ICNS and keep the independent PNG exports reproducible.
    if (!existsSync(join(icons, "pomodoro-timer.icns"))) throw error;
    console.warn(`Skipped ICNS regeneration: ${error instanceof Error ? error.message : "iconutil failed"}`);
  }

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
  await writeFile(join(icons, "trayTemplate.png"), renderTrayTemplate(16));
  await writeFile(join(icons, "trayTemplate@2x.png"), renderTrayTemplate(32));
  console.log("Exported macOS ICNS, Windows ICO, color tray PNG, and 1x/2x macOS template tray PNGs.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
