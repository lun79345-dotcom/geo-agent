import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/v2-assets/",
  optimizeDeps: { include: ["react", "react-dom/client"] },
  server: {
    host: "127.0.0.1",
    port: 5187,
    proxy: { "/api": "http://127.0.0.1:8879" },
  },
  plugins: [react()],
  build: { outDir: "../v2-assets", emptyOutDir: true },
});
