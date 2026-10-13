/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation enables SharedArrayBuffer, which the Python worker
// uses for synchronous range reads.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: "es" },
  // Pre-bundle lazily imported deps so their first use doesn't trigger a dev reload.
  optimizeDeps: { exclude: ["@ironcalc/wasm"], include: ["xlsx"] },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
