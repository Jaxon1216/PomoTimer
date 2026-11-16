import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = join(root, "apps/desktop/resources/camera/mediapipe");
const require = createRequire(join(root, "apps/desktop/package.json"));
const vision = dirname(require.resolve("@mediapipe/tasks-vision"));
const model = await readFile(join(assets, "blaze_face_short_range.tflite"));
if (createHash("sha256").update(model).digest("hex") !== "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f") {
  throw new Error("Bundled camera model checksum mismatch");
}
await mkdir(assets, { recursive: true });
await copyFile(join(root, "docs/licenses/Apache-2.0.txt"), join(assets, "LICENSE.txt"));
for (const name of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
  await copyFile(join(vision, "wasm", name), join(assets, name));
}
