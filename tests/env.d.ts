import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as WorkerEnv } from "../src/types";

// The pool types `env` from "cloudflare:test" as Cloudflare.Env, so the Worker
// bindings plus the test-only migration payload are declared here.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
