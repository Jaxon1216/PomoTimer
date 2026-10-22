import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = resolve(process.argv[2] ?? join(root, "release"));
const { version } = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
const tag = `v${version}`;
if (process.env.GITHUB_REF_NAME) assert.equal(process.env.GITHUB_REF_NAME, tag);
const repository = process.env.GITHUB_REPOSITORY ?? "Jaxon1216/PomoTimer";
const installers = [
  [`Pomodot-${version}-windows-x64-setup.exe`, "Windows x64"],
  [`Pomodot-${version}-mac-arm64.dmg`, "macOS Apple Silicon"],
  [`Pomodot-${version}-mac-x64.dmg`, "macOS Intel"],
];
const actual = (await readdir(directory)).filter((file) => /\.(dmg|exe)$/.test(file)).sort();
assert.deepEqual(actual, installers.map(([file]) => file).sort(), "All three expected installers must be present.");
const sums = [];
for (const [name] of installers) {
  const path = join(directory, name);
  const size = (await stat(path)).size;
  assert.ok(size > 1_000_000, `${name} must be a complete installer.`);
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, name.endsWith(".dmg") ? size - 512 : 0);
    assert.equal(header.subarray(0, name.endsWith(".dmg") ? 4 : 2).toString(), name.endsWith(".dmg") ? "koly" : "MZ");
  } finally {
    await handle.close();
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  sums.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(join(directory, "SHA256SUMS"), `${sums.join("\n")}\n`);
const downloads = installers.map(([file, platform]) => `| ${platform} | [${file}](https://github.com/${repository}/releases/download/${tag}/${file}) |`).join("\n");
await writeFile(join(directory, "RELEASE_NOTES.md"), `# Pomodot ${version}\n\n首个桌面预览版本，供体验与反馈使用。\n\n| 平台 | 安装包 |\n| --- | --- |\n${downloads}\n\n## 本版内容\n\n- Electron + React + TypeScript 本地计时核心与 SQLite 数据。\n- 默认 30/5/30/5/30/10 周期、系统输入检测、暂停/继续和休息模式。\n- 设置、浅深主题、本地统计、热力图、紧凑窗口和托盘控制。\n- 单实例数据保护、锁屏门禁、故障下手动计时、数据库备份恢复与实时统计。\n- 新的折纸回环应用图标。\n\n## 安装与验证\n\n- macOS：打开匹配芯片类型的 DMG，将应用拖入 Applications。\n- Windows：运行 EXE 安装向导，可选择安装目录。\n- 当前构建未使用开发者证书签名，macOS 也未公证；系统可能阻止打开或显示未知发布者。请核对来源与 SHA256SUMS，不要全局关闭系统安全保护。\n- 下载包已在对应 GitHub runner 构建并完成打包应用启动、数据库、托盘资源、IPC 和基本操作测试；真实设备的系统输入、通知、锁屏和睡眠测试尚未完成。\n\n## 已知问题\n\n- 部分旧快照可能不兼容；应用会先备份原始数据库，只有显式选择后才归档并重建，历史记录保留在备份中。\n\n这是预发布版本，不代表 Phase 1 发布门已经全部通过。\n`);
console.log(`Validated ${installers.length} installers and generated SHA256SUMS and release notes for ${tag}.`);
