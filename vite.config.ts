import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the built app can be hosted from any folder (or opened via `vite preview`).
  base: "./",
  optimizeDeps: { exclude: ["@mediapipe/tasks-vision"] },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
