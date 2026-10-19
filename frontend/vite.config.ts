import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const apiTarget = process.env.VITE_API_TARGET || "http://127.0.0.1:4176";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: "/src/$1" },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/media": apiTarget,
      "/poster": apiTarget,
      "/thumbs": apiTarget,
    },
  },
  build: {
    outDir: "../src/player/public",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        studio: resolve(root, "studio.html"),
        setup: resolve(root, "setup.html"),
        status: resolve(root, "status.html"),
        "new-series": resolve(root, "new-series.html"),
        meter: resolve(root, "meter.html"),
      },
    },
  },
});
