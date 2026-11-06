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
const changelog = (await readFile(join(root, "CHANGELOG.md"), "utf8")).replaceAll("\r\n", "\n");
const entries = changelog.split(/^##[ \t]+/m).slice(1).filter((section) => {
  const [heading] = section.split("\n", 1);
  return heading.trim().split(" - ", 1)[0] === `[${version}]`;
});
assert.equal(entries.length, 1, `CHANGELOG.md must contain exactly one ## [${version}] section for ${tag}.`);
const releaseEntry = entries[0].split("\n").slice(1).join("\n").trim();
const subsections = releaseEntry.split(/^###[ \t]+/m).slice(1);
for (const title of ["改动", "已知问题"]) {
  assert.ok(subsections.some((section) => {
    const [heading, ...body] = section.split("\n");
    return heading.trim() === title && body.join("\n").trim();
  }), `CHANGELOG.md [${version}] must include a nonempty ### ${title} section.`);
}
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
await writeFile(join(directory, "RELEASE_NOTES.md"), `# Pomodot ${version}

| 平台 | 安装包 |
| --- | --- |
${downloads}

## 本版内容

${releaseEntry}

## 安装与验证

- macOS：Intel 芯片下载 mac-x64.dmg，Apple Silicon（M 系列）下载 mac-arm64.dmg。打开 DMG，将应用拖入 Applications，再从 Applications 打开。
- macOS 包采用免费的 ad hoc 完整性签名，没有 Developer ID 身份或 Apple 公证。如果提示无法验证开发者或 Apple 无法检查恶意软件，确认来源与 SHA256SUMS 后，尝试打开一次，再到“系统设置 → 隐私与安全性 → 仍要打开”。macOS 15 及以上不能仅用右键打开代替此步骤；受管理的设备可能不允许添加例外。
- 如果提示应用已损坏或将损坏电脑，请保留完整提示并反馈，不要把它当作普通的未知开发者提示。
- Windows：运行 EXE 安装向导，可选择安装目录。
- Windows 安装包尚无发布者证书签名，可能显示 SmartScreen 警告；系统策略可能禁止继续。无需用户安装 Node.js、编译程序或购买证书，也不要全局关闭系统安全保护。
- 两个 Mac 安装包已在对应 GitHub runner 验证完整签名、篡改拒绝和最终 DMG 内应用的隔离安装与启动；Windows 完成打包应用启动检查。自动化还覆盖数据库、托盘资源、IPC 和基本操作，但不代表浏览器下载后的系统批准或真实设备的输入、通知、锁屏和睡眠验收。手工验收记录见仓库 docs/roadmap.md。

这是预发布版本，不代表 Phase 1 发布门已经全部通过。
`);
console.log(`Validated ${installers.length} installers and generated SHA256SUMS and release notes for ${tag}.`);
