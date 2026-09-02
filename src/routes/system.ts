// CommentHide — running the poll by hand, and reading the audit log.
//
// "Run now" exists because cron triggers never fire under `wrangler dev`, and
// because an operator setting a post up wants to see the result immediately
// rather than at the top of the next minute.

import { Hono } from "hono";
import type { AppEnv, PollOptions } from "../types";
import { runPoll } from "../lib/poller";
import { recentEvents } from "../lib/storage";
import { optionalBoolean, postIdField, readOptionalJson } from "./shared";

const EVENTS_DEFAULT = 50;
const EVENTS_MIN = 1;
const EVENTS_MAX = 200;

const system = new Hono<AppEnv>();

/** A bad or absent ?limit= falls back to the default rather than failing the read. */
function eventLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return EVENTS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return EVENTS_DEFAULT;
  return Math.min(Math.max(Math.trunc(parsed), EVENTS_MIN), EVENTS_MAX);
}

system.post("/run", async (c) => {
  const body = await readOptionalJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const dryRun = optionalBoolean(body.value, "dryRun");
  if (!dryRun.ok) return c.json({ error: dryRun.error }, 400);

  let onlyPostId: string | undefined;
  if (body.value.postId !== undefined && body.value.postId !== null) {
    const postId = postIdField(body.value);
    if (!postId.ok) return c.json({ error: postId.error }, 400);
    onlyPostId = postId.value;
  }

  const options: PollOptions = {
    manual: true,
    ...(onlyPostId === undefined ? {} : { onlyPostId }),
    ...(dryRun.value === undefined ? {} : { forceDryRun: dryRun.value }),
  };

  // runPoll never throws and never leaks the token, so its summary is safe to return.
  return c.json({ ok: true, summary: await runPoll(c.env, options) });
});

system.get("/events", async (c) => {
  const events = await recentEvents(c.env.DB, eventLimit(c.req.query("limit")));
  return c.json({ events });
});

export default system;
