import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultMacAppPath, verifyMacSignature } from "./verify-mac-signature.mjs";

const execFileAsync = promisify(execFile);
assert.equal(process.platform, "darwin", "Signature regression tests require macOS.");
assert.ok(process.argv.length <= 3, "Usage: node scripts/test-mac-signature.mjs [app-path]");
const app = resolve(process.argv[2] ?? defaultMacAppPath());
const signature = await verifyMacSignature(app);
const temporary = await mkdtemp(join(tmpdir(), "pomodot-signature-test-"));
const copy = join(temporary, basename(app));
try {
  await execFileAsync("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", "--qtn", app, copy], { timeout: 60_000 });
  await verifyMacSignature(copy);
  const resource = "Contents/Resources/icons/trayTemplate.png";
  await appendFile(join(copy, resource), "signature-regression-tamper");
  await assert.rejects(verifyMacSignature(copy), /codesign failed/, "Modified packaged resources must be rejected.");
  await copyFile(join(app, resource), join(copy, resource));
  await verifyMacSignature(copy);
  const nativeModule = signature.nativeModules[0];
  await appendFile(join(copy, nativeModule), "signature-regression-tamper");
  await assert.rejects(verifyMacSignature(copy), /codesign failed/, "Modified native modules must be rejected.");
  console.log(JSON.stringify({
    kind: "mac-signature-regression",
    appPath: app,
    originalSignatureValid: true,
    resourceTamperingRejected: true,
    nativeModuleTamperingRejected: nativeModule,
    gatekeeperApprovalTested: false,
  }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
