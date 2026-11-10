import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";
import { verifyMacSignature } from "./verify-mac-signature.mjs";

const resources = join(dirname(dirname(fileURLToPath(import.meta.url))), "apps/desktop/resources");

// electron-builder 25 treats identity "-" as a certificate search, so use its
// signing stage explicitly, after bundle changes and before DMG creation.
export default async function signMac(options) {
  if (process.platform !== "darwin" || options.platform !== "darwin") {
    throw new Error("The free macOS signer supports direct-distribution macOS apps only.");
  }
  await signAsync({
    app: options.app,
    platform: "darwin",
    version: options.version,
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: (path) => ({
      // Process bundles need V8 JIT, ad-hoc library loading and opt-in camera
      // capture. Libraries receive no device grants; microphone stays denied.
      entitlements: join(resources, path.endsWith(".app") ? "entitlements.mac.plist" : "entitlements.mac-library.plist"),
      hardenedRuntime: true,
      timestamp: "none",
    }),
  });
  await verifyMacSignature(options.app);
  console.log("macOS bundle sealed with a free ad-hoc signature (not Developer ID signed or notarized).");
}
