import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyMacSignature } from "./verify-mac-signature.mjs";
import { smokePackaged } from "./smoke-packaged.mjs";

const execFileAsync = promisify(execFile);
assert.equal(process.platform, "darwin", "DMG smoke tests require macOS.");
assert.equal(process.argv.length, 3, "Usage: node scripts/smoke-mac-dmg.mjs <dmg-path>");
const dmgPath = resolve(process.argv[2]);
assert.ok(dmgPath.endsWith(".dmg"), "Pass a DMG installer to test.");
const temporary = await realpath(await mkdtemp(join(tmpdir(), "pomodot-dmg-smoke-")));
const mountPath = join(temporary, "mounted");
const installPath = join(temporary, "installed");
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("DMG smoke test interrupted."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let mountAttempted = false;
let failure;
let evidence;

async function isTestVolumeMounted() {
  const { stdout } = await execFileAsync("/usr/bin/hdiutil", ["info", "-plist"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  const info = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: stdout, encoding: "utf8", timeout: 10_000 }));
  return (info.images ?? []).some((image) => (image["system-entities"] ?? []).some((entity) => entity["mount-point"] === mountPath));
}

try {
  await mkdir(mountPath);
  await mkdir(installPath);
  controller.signal.throwIfAborted();
  mountAttempted = true;
  await execFileAsync("/usr/bin/hdiutil", ["attach", dmgPath, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPath], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  controller.signal.throwIfAborted();
  const apps = (await readdir(mountPath, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  assert.equal(apps.length, 1, "The DMG must contain exactly one application bundle.");
  const installedApp = join(installPath, apps[0].name);
  // 保留扩展属性及下载隔离标记；这个直接进程启动测试不替代 Finder 的用户批准验收。
  await execFileAsync("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", "--qtn", join(mountPath, apps[0].name), installedApp], { timeout: 60_000, signal: controller.signal });
  const signature = await verifyMacSignature(installedApp);
  controller.signal.throwIfAborted();
  await smokePackaged({ executablePath: signature.executablePath, signal: controller.signal });
  evidence = {
    kind: "mac-dmg-smoke",
    dmgPath,
    installer: basename(dmgPath),
    mountedReadOnly: true,
    copiedAppVerified: true,
    nativeModulesVerified: signature.nativeModules,
    packagedControlsPassed: true,
    browserDownloadTested: false,
    finderLaunchTested: false,
    gatekeeperApprovalTested: false,
  };
} catch (error) {
  failure = error;
} finally {
  let detached = !mountAttempted;
  if (mountAttempted) {
    try {
      await execFileAsync("/usr/bin/hdiutil", ["detach", mountPath], { timeout: 30_000 });
      detached = true;
    } catch (detachError) {
      try {
        await execFileAsync("/usr/bin/hdiutil", ["detach", "-force", mountPath], { timeout: 30_000 });
        detached = true;
      } catch (forceError) {
        try {
          detached = !(await isTestVolumeMounted());
          if (!detached) failure = new AggregateError([failure, detachError, forceError].filter(Boolean), `Could not detach the smoke-test volume; retained ${temporary}`);
        } catch (inspectionError) {
          // 无法确认挂载状态时保留目录，避免递归删除活动挂载点。
          failure = new AggregateError([failure, detachError, forceError, inspectionError].filter(Boolean), `Could not confirm DMG cleanup; retained ${temporary}`);
        }
      }
    }
  }
  if (detached) {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "DMG smoke test cleanup failed.") : error;
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
if (failure) throw failure;
controller.signal.throwIfAborted();
console.log(JSON.stringify({ ...evidence, cleanedUp: true }, null, 2));
