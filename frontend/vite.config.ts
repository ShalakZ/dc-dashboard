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
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    css: false,
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
}));
