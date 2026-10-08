import { defineConfig } from "vite";

export default defineConfig({
  base: "/NYC-SNOW-COMPLAINTS/",
  build: { target: "es2020", chunkSizeWarningLimit: 800 },
});
