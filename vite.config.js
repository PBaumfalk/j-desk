import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Entwicklung: Vite unter :5173, API und WebSocket laufen auf dem Server unter :4810.
    proxy: {
      "/api": { target: "http://localhost:4810", ws: true },
    },
  },
});
