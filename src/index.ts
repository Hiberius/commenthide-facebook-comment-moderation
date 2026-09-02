// CommentHide — Worker entry point.
//
// Two surfaces share one Worker: the dashboard at "/" and the JSON API under
// "/api". Authentication and CSRF are applied to the whole API tree rather than
// route by route, so a new endpoint is protected the moment it is mounted —
// forgetting a middleware should never be a way to lose the front door.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv, Env } from "./types";
import { requireAuth, requireCsrf } from "./lib/auth";
import { runPoll } from "./lib/poller";
import { runRetention } from "./lib/retention";
import { securityHeaders } from "./lib/security";
import { renderDashboard } from "./ui";
import moderation from "./routes/moderation";
import page from "./routes/page";
import posts from "./routes/posts";
import rules from "./routes/rules";
import session from "./routes/session";
import system from "./routes/system";

/** Reported by GET /health so a deployment can be identified without logging in. */
const VERSION = "1.0.0";

/** The only API request that may arrive without a session: logging in. */
const LOGIN_PATH = "/api/session";

/** Retention runs once an hour, on the tick the cron fires at minute zero. */
const RETENTION_MINUTE = 0;

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);

app.get("/", (c) => c.html(renderDashboard()));

app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

function isLogin(c: Context<AppEnv>): boolean {
  return c.req.method === "POST" && c.req.path === LOGIN_PATH;
}

const api = new Hono<AppEnv>();

api.use("*", async (c, next) => (isLogin(c) ? next() : requireAuth(c, next)));
api.use("*", async (c, next) => (isLogin(c) ? next() : requireCsrf(c, next)));

api.route("/", session);
api.route("/", page);
api.route("/", posts);
api.route("/", rules);
api.route("/", moderation);
api.route("/", system);

app.route("/api", api);

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  // Logged in full for the operator, generic for the client: an exception
  // message can carry a query, a row or a token fragment.
  console.error("commenthide: unhandled error:", err);
  return c.json({ error: "internal error" }, 500);
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

function reportFailure(scope: string, err: unknown): void {
  console.error(`commenthide: ${scope}:`, err instanceof Error ? err.message : String(err));
}

/**
 * The cron fires every minute. The poll runs on all of them; pruning runs on one
 * of them, keyed off the scheduled time rather than the wall clock so a delayed
 * invocation still prunes for the tick it was scheduled for.
 */
async function runSchedule(env: Env, scheduledTime: number): Promise<void> {
  try {
    await runPoll(env);
  } catch (err) {
    reportFailure("scheduled poll failed", err);
  }

  if (!Number.isFinite(scheduledTime)) return;
  if (new Date(scheduledTime).getUTCMinutes() !== RETENTION_MINUTE) return;

  try {
    await runRetention(env, scheduledTime);
  } catch (err) {
    reportFailure("scheduled retention failed", err);
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    // waitUntil keeps the invocation alive; runSchedule itself never rejects.
    ctx.waitUntil(runSchedule(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
