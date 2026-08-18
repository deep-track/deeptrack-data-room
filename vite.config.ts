import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    allowedHosts: ["4173-i1mtf7frozjjnhe95h793-75b5cef1.us4.manus.computer"],
  },
  build: { target: "es2022" },
});
