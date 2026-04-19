import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:3000",
      "/models": "http://127.0.0.1:3000",
      "/chat": "http://127.0.0.1:3000",
      "/conversations": "http://127.0.0.1:3000",
    },
  },
});
