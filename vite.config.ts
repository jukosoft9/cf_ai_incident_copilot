import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // agents() compiles the @callable() decorators, which Vite's default transform does not.
  plugins: [agents(), react(), cloudflare()],
});
