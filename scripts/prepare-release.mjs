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

- macOS：Apple 芯片选择 arm64、Intel 芯片选择 x64 DMG，打开后将应用拖入 Applications。应用经过 ad hoc 完整性签名，但没有 Developer ID 或 Apple 公证；首次打开被阻止时，请核对下载来源与 SHA256SUMS，再到“系统设置 → 隐私与安全性”选择“仍要打开”，由设备使用者完成系统认证。不要全局关闭系统安全保护。
- Windows：运行 EXE 安装向导，可选择安装目录。
- Windows 安装包没有开发者证书签名，系统可能提示未知发布者；请核对来源与 SHA256SUMS。
- 安装完成默认使用触控模式，不请求摄像头。主动切换“监控”后授予摄像头权限；画面只在本机处理，不保存、不上传。权限拒绝或设备故障会提示并回退触控。
- 三个平台的发布流程均实际安装最终安装包，检查启动、SQLite、托盘资源、IPC、160×180 挂件与独立开关，并断网运行随包携带的真实摄像头模型（使用 Chromium 模拟摄像头）。macOS 另验证完整性签名、摄像头用途声明与 entitlement，并拒绝被篡改的资源和原生模块。
- 模拟摄像头不等于物理设备验收。不同光照、首次 OS 授权/撤销、设备拔插、真实睡眠/锁屏及多屏交互仍需按路线图实机验证，不能保证每个设备环境。详见[本次验证记录](https://github.com/${repository}/blob/${tag}/docs/release-beta-3-validation.md)。

这是预发布版本，不代表 Phase 1 发布门已经全部通过。
`);
console.log(`Validated ${installers.length} installers and generated SHA256SUMS and release notes for ${tag}.`);
