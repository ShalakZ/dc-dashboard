/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { configDefaults } from "vitest/config";

// VITE_API_TARGET points the dev server at another API (the visual-check stack); loadEnv reads it from the shell as well as .env files.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: loadEnv(mode, ".").VITE_API_TARGET ?? "http://localhost:8000", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Vendor code that changes rarely gets its own file, so an app-code release leaves it in the browser cache. Nothing else is named:
        // a catch-all "vendor" chunk would pull the lazy pages' libraries (xyflow, react-grid-layout) into the first load. echarts is named only so the lazy chunk is recognisable.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (/node_modules\/react-router/.test(id)) return "router";
          if (/node_modules\/@tanstack\//.test(id)) return "query";
          if (/node_modules\/(echarts|zrender|tslib|size-sensor)\//.test(id)) return "echarts";
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    css: false,
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
}));
