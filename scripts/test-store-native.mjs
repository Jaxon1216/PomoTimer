import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "package.json"));
const directory = await mkdtemp(join(root, "node_modules", ".store-native-test-"));
try {
  const entry = join(directory, "tests.cjs");
  await build({ entryPoints: [join(root, "apps/desktop/src/main/store.native-tests.ts")], outfile: entry, bundle: true, platform: "node", format: "cjs", target: "node20", external: ["better-sqlite3"] });
  const result = spawnSync(require("electron"), [entry], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
