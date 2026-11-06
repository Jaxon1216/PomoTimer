import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const machOMagic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const appEntitlements = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.disable-library-validation": true,
};

export function defaultMacAppPath() {
  return join(root, "apps/desktop/dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Pomodoro Timer.app");
}

async function macTool(command, args) {
  try {
    return await execFileAsync(command, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`${basename(command)} failed for ${args.at(-1)}: ${error.stderr || error.message}`, { cause: error });
  }
}

async function inspectContents(directory, inventory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".app")) inventory.apps.push(path);
      if (entry.name.endsWith(".framework")) inventory.frameworks.push(path);
      await inspectContents(path, inventory);
    } else if (entry.isFile()) {
      const file = await open(path, "r");
      let isMachO;
      try {
        const header = Buffer.alloc(4);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        isMachO = bytesRead === 4 && machOMagic.has(header.readUInt32BE());
      } finally {
        await file.close();
      }
      if (entry.name.endsWith(".node")) {
        assert.ok(isMachO, `Native module is not Mach-O: ${path}`);
        inventory.nativeModules.push(path);
      }
      if (isMachO) inventory.machO.push(path);
    }
  }
}

async function readEntitlements(path) {
  const { stdout } = await macTool("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", path]);
  if (stdout.trim() === "") return {};
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: stdout, encoding: "utf8", timeout: 10_000 }));
}

export async function verifyMacSignature(appPath) {
  assert.equal(process.platform, "darwin", "macOS signature verification requires macOS.");
  const app = await realpath(resolve(appPath));
  assert.ok(app.endsWith(".app"), "Pass the complete .app bundle to verify.");

  // 校验完整封存资源；随后单独检查 .node 等可能不属于标准嵌套代码位置的二进制。
  await macTool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", "--verbose=2", app]);
  const inventory = { apps: [app], frameworks: [], machO: [], nativeModules: [] };
  await inspectContents(app, inventory);
  assert.ok(inventory.nativeModules.length > 0, "The packaged SQLite native module is missing.");

  const appExecutables = new Set();
  let executablePath;
  for (const bundle of inventory.apps) {
    const { stdout } = await macTool("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(bundle, "Contents/Info.plist")]);
    const executable = JSON.parse(stdout).CFBundleExecutable;
    assert.ok(typeof executable === "string" && executable !== "" && basename(executable) === executable, `Invalid executable in ${bundle}`);
    const path = await realpath(join(bundle, "Contents/MacOS", executable));
    assert.ok(inventory.machO.includes(path), `App executable must be a bundled Mach-O file: ${path}`);
    appExecutables.add(path);
    if (bundle === app) executablePath = path;
  }

  const checked = [];
  for (const path of [...inventory.apps, ...inventory.frameworks, ...inventory.machO]) {
    await macTool("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "--verbose=2", path]);
    const { stderr } = await macTool("/usr/bin/codesign", ["--display", "--verbose=4", path]);
    assert.match(stderr, /^Signature=adhoc$/m, `Expected ad hoc signing: ${path}`);
    assert.match(stderr, /^TeamIdentifier=not set$/m, `Unexpected signing team: ${path}`);
    assert.match(stderr, /^CodeDirectory .*flags=.*\bruntime\b/m, `Hardened runtime is missing: ${path}`);
    if (inventory.apps.includes(path)) {
      assert.match(stderr, /^Sealed Resources version=\d+\b/m, `App resources are not sealed: ${path}`);
      assert.doesNotMatch(stderr, /^Info\.plist=not bound$/m, `App metadata is not bound to the signature: ${path}`);
    }
    const entitlements = await readEntitlements(path);
    const expected = inventory.apps.includes(path) || appExecutables.has(path) ? appEntitlements : {};
    assert.deepEqual(entitlements, expected, `Unexpected entitlements: ${path}`);
    checked.push({ path: relative(app, path) || ".", kind: inventory.apps.includes(path) ? "app" : inventory.frameworks.includes(path) ? "framework" : "mach-o" });
  }

  return {
    kind: "mac-signature-verification",
    appPath: app,
    executablePath,
    signature: "ad-hoc",
    hardenedRuntime: true,
    teamIdentifier: null,
    requiredAppEntitlements: appEntitlements,
    nativeModules: inventory.nativeModules.map((path) => relative(app, path)),
    checked,
    gatekeeperApprovalTested: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length <= 3, "Usage: node scripts/verify-mac-signature.mjs [app-path]");
  console.log(JSON.stringify(await verifyMacSignature(process.argv[2] ?? defaultMacAppPath()), null, 2));
}
