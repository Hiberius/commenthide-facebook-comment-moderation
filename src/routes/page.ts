// CommentHide — the connected Facebook Page.
//
// The Page Access Token is the only real secret this app holds. It arrives here
// once, is encrypted before anything else happens to it, is verified against the
// Graph API before it is stored, and is never echoed back in any response.

import { Hono } from "hono";
import type { AppEnv } from "../types";
import { encryptToken } from "../lib/crypto";
import {
  deleteSetting,
  getSetting,
  logEvent,
  setSetting,
} from "../lib/storage";
import {
  graphErrorStatus,
  loadPageToken,
  logInternal,
  newGraphClient,
  readJson,
  requiredString,
  SETTING_PAGE_ID,
  SETTING_PAGE_NAME,
  SETTING_TOKEN,
} from "./shared";

/** Real Page tokens are long; anything shorter is a truncated paste. */
const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 1000;

/** Tokens are URL-safe text. Whitespace means the paste picked up extra characters. */
const TOKEN_RE = /^[A-Za-z0-9_.\-~+/=|]+$/;

/** How many recent posts the post picker offers. */
const RECENT_POST_LIMIT = 25;

const page = new Hono<AppEnv>();

page.put("/page/token", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const field = requiredString(body.value, "token", MAX_TOKEN_LENGTH);
  if (!field.ok) return c.json({ error: field.error }, 400);

  const token = field.value;
  if (token.length < MIN_TOKEN_LENGTH || !TOKEN_RE.test(token)) {
    return c.json(
      { error: "That does not look like a Page Access Token. Copy the whole value from Meta." },
      400,
    );
  }

  // Encrypt first: a broken ENCRYPTION_KEY is a configuration problem, and there
  // is no point spending a Graph call to discover we could not store the result.
  let ciphertext: string;
  try {
    ciphertext = await encryptToken(token, c.env.ENCRYPTION_KEY);
  } catch (err) {
    logInternal("token encryption failed", err);
    return c.json(
      { error: "ENCRYPTION_KEY is missing or is not 32 bytes of base64. Fix it and try again." },
      500,
    );
  }

  const identity = await newGraphClient(c.env, token).identity();
  if (!identity.ok) {
    // Nothing is written: an unverified token would leave the poller failing
    // every minute with no way to tell a bad token from a bad post id.
    await logEvent(c.env.DB, {
      level: "warn",
      action: "page_token_rejected",
      error_message: identity.message,
    });
    return c.json({ error: identity.message }, graphErrorStatus(identity));
  }

  const name = identity.data.name ?? identity.data.id;
  await setSetting(c.env.DB, SETTING_TOKEN, ciphertext);
  await setSetting(c.env.DB, SETTING_PAGE_ID, identity.data.id);
  await setSetting(c.env.DB, SETTING_PAGE_NAME, name);
  await logEvent(c.env.DB, {
    level: "info",
    action: "page_token_set",
    detail: `page=${identity.data.id}`,
  });

  return c.json({ ok: true, page: { id: identity.data.id, name } });
});

page.delete("/page/token", async (c) => {
  await deleteSetting(c.env.DB, SETTING_TOKEN);
  await deleteSetting(c.env.DB, SETTING_PAGE_ID);
  await deleteSetting(c.env.DB, SETTING_PAGE_NAME);
  await logEvent(c.env.DB, { level: "info", action: "page_token_cleared" });
  return c.json({ ok: true });
});

page.get("/page/posts", async (c) => {
  const token = await loadPageToken(c.env);
  if (!token.ok) return c.json({ error: token.error }, token.status);

  const pageId = await getSetting(c.env.DB, SETTING_PAGE_ID);
  const client = newGraphClient(c.env, token.token);
  const posts = await client.listRecentPosts(pageId ?? undefined, RECENT_POST_LIMIT);
  if (!posts.ok) return c.json({ error: posts.message }, graphErrorStatus(posts));

  return c.json({ posts: posts.data });
});

export default page;
