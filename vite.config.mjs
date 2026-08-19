import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from the domain root by default (Vercel, Netlify, local preview).
// GitHub Pages serves from /<repo>/, so that workflow sets VITE_BASE=/rhizome/.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/",
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
