import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base is set for GitHub Pages (served from /rhizome/). Override with
// VITE_BASE=/ for local or root-domain hosting.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/rhizome/",
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
