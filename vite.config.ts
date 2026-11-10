import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "desktop-content-security-policy",
      apply: "build",
      transformIndexHtml() {
        return [{
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src local-media:; base-uri 'none'; form-action 'none'",
          },
          injectTo: "head-prepend",
        }];
      },
    },
  ],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
