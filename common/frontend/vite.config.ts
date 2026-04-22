import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8173",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    minify: false,
    sourcemap: true,
  },
});
