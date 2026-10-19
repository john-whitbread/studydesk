import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port in dev. `npm run mock` serves the UI in a normal
// browser with a fake backend (src/mock) for design work; it is never built
// into the app.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  server: { port: mode === "mock" ? 5174 : 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_"],
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
}));
