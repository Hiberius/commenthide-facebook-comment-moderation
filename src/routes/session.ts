// CommentHide — session and dashboard status.
//
// POST /api/session is the one endpoint reachable without a session, so it is
// also the one endpoint that has to be careful: throttling lives in lib/auth,
// and nothing here ever explains *why* a password was rejected.

import { Hono } from "hono";
import type { AppEnv, PostRow, StatusPayload } from "../types";
import { csrfToken, login, logout } from "../lib/auth";
import { getSetting, globalTotals, listPosts } from "../lib/storage";
import { readJson, requiredString, SETTING_PAGE_NAME, SETTING_TOKEN } from "./shared";

/** Long enough for a passphrase, short enough that nothing huge is hashed. */
const MAX_PASSWORD = 512;

const session = new Hono<AppEnv>();

/** The most recent successful check across every watched post. */
function latestCheck(posts: readonly PostRow[]): number | null {
  return posts.reduce<number | null>((latest, post) => {
    const checked = post.last_checked_at;
    if (checked === null) return latest;
    return latest === null || checked > latest ? checked : latest;
  }, null);
}

session.post("/session", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const password = requiredString(body.value, "password", MAX_PASSWORD);
  if (!password.ok) return c.json({ error: password.error }, 400);

  const result = await login(c, password.value);
  if (!result.ok) {
    // A lockout is a 429 with Retry-After so the dashboard can count down;
    // a plain wrong password stays a 401.
    if (result.retryAfterSec !== undefined) {
      c.header("Retry-After", String(result.retryAfterSec));
      return c.json({ error: result.error, retryAfterSec: result.retryAfterSec }, 429);
    }
    return c.json({ error: result.error }, 401);
  }

  return c.json({ ok: true, csrfToken: await csrfToken(c) });
});

session.delete("/session", (c) => {
  logout(c);
  return c.json({ ok: true });
});

session.get("/status", async (c) => {
  const db = c.env.DB;
  const [posts, totals, pageName, storedToken] = await Promise.all([
    listPosts(db),
    globalTotals(db),
    getSetting(db, SETTING_PAGE_NAME),
    getSetting(db, SETTING_TOKEN),
  ]);

  const payload: StatusPayload = {
    // "Active" means the tool is actually watching something right now.
    active: posts.some((post) => post.active === 1),
    hasToken: storedToken !== null && storedToken !== "",
    pageName,
    totals,
    posts,
    lastCheckedAt: latestCheck(posts),
  };

  return c.json({ ...payload, csrfToken: await csrfToken(c) });
});

export default session;
