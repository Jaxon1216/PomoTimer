import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { build as bundlePreload } from "esbuild";
import type { Plugin } from "vite";

// 领域：Electron / 沙箱 Preload 构建
// 顺序：Vite 单入口构建 -> 独立打包提醒 Preload -> 输出两个自包含文件。
// 作用：保持主窗口和提醒窗口各自的桥接白名单，不生成共享 require 分块。
// 原因：沙箱 Preload 的受限 require 不能加载 Rollup 的本地共享文件。
// 边界：仅 electron 保留为外部依赖；监听提醒输入文件以支持开发重建。
function standaloneReminderPreload(): Plugin {
  return {
    name: "standalone-reminder-preload",
    apply: "build",
    async generateBundle() {
      const result = await bundlePreload({
        entryPoints: [resolve(__dirname, "src/preload/reminder.ts")],
        outfile: "reminder.js",
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        external: ["electron"],
        write: false,
        metafile: true,
      });
      for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(resolve(input));
      const output = result.outputFiles[0];
      if (!output) throw new Error("提醒 Preload 构建结果为空");
      this.emitFile({ type: "asset", fileName: "reminder.js", source: output.text });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [standaloneReminderPreload()],
    build: {
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    publicDir: resolve(__dirname, "resources/camera"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html"), reminder: resolve(__dirname, "src/renderer/reminder.html") },
      },
    },
    server: {
      port: 5174,
      strictPort: true,
    },
  },
});
