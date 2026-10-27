import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // Cargo's build output under src-tauri locks files mid-link (EBUSY on Windows).
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2021" },
});
