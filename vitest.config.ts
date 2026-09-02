import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

const here = path.dirname(fileURLToPath(import.meta.url));

// Migrations are read once at config time and handed to the test Worker as a
// binding, so a suite can rebuild the schema without touching the filesystem.
const migrations = await readD1Migrations(path.join(here, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2025-04-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          ADMIN_PASSWORD: "correct-horse-battery-staple",
          // base64 of 32 deterministic bytes — test-only, never a real key.
          ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          SESSION_SECRET: "test-session-secret-do-not-use-in-production",
          GRAPH_API_VERSION: "v25.0",
          RETENTION_DAYS: "0",
        },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ["./tests/apply-migrations.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/ui/**", "src/types.ts"],
    },
  },
});
