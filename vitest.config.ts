// Separate from vite.config.ts so unit tests don't load the Cloudflare plugin,
// which would need a login because Workers AI always runs remotely.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
