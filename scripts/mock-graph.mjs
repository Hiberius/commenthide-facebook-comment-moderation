#!/usr/bin/env node
// CommentHide — offline mock of the Meta Graph API.
//
// Lets you run and develop the whole application without a Facebook App, a
// Page, or a real access token. Start it, point GRAPH_API_BASE at it, and the
// Worker behaves exactly as it would against Meta.
//
//   node scripts/mock-graph.mjs                 # listens on 127.0.0.1:8788
//   GRAPH_API_BASE="http://127.0.0.1:8788" npm run dev
//
// Any non-empty token is accepted. Nothing here talks to the internet.

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
const PAGE = { id: "100000000000001", name: "Northwind Coffee Roasters" };

const POSTS = [
  {
    id: `${PAGE.id}_200000000000001`,
    message: "Our single-origin Ethiopian is back in stock. Free shipping this week.",
    created_time: "2026-08-28T09:12:00+0000",
    permalink_url: "https://www.facebook.com/northwind/posts/200000000000001",
  },
  {
    id: `${PAGE.id}_200000000000002`,
    message: "Behind the counter: how we dial in a new roast.",
    created_time: "2026-08-21T14:40:00+0000",
    permalink_url: "https://www.facebook.com/northwind/posts/200000000000002",
  },
];

// A deliberately mixed thread: obvious spam, borderline cases, and honest
// criticism that a moderation tool has no business hiding.
const COMMENTS = [
  ["Best espresso in the city, genuinely. Third order this month.", "Marta Feldman"],
  ["Make $4,800/week trading crypto — WhatsApp me +1 415 555 0142", "Trading Signals Pro"],
  ["Honestly the last bag was stale and shipping took nine days. Disappointed.", "Ben Ortiz"],
  ["🔥🔥🔥🔥🔥🔥🔥🔥", "Kai R."],
  ["Check my profile for cheap followers >> bestfollowers(dot)com", "Growth Hacks"],
  ["Do you ship to Ireland?", "Aoife Byrne"],
  ["ok", "Tom L."],
  ["INVESTIMENTO GARANTITO 300% in 7 giorni, scrivimi in privato", "Finanza Facile"],
  ["The new packaging is lovely but the resealable strip tears too easily.", "Priya Nair"],
  ["Contattami su info@cheap-deals-outlet.biz per prezzi all'ingrosso", "Outlet Deals"],
];

const hidden = new Set();
const now = Date.parse("2026-09-02T17:30:00Z");

const commentsFor = (postId) =>
  COMMENTS.map(([message, name], i) => ({
    id: `${postId.split("_")[1] ?? postId}_${900000 + i}`,
    message,
    created_time: new Date(now - (COMMENTS.length - i) * 11 * 60_000).toISOString(),
    from: { id: `30000000000${i}`, name },
    can_hide: true,
    is_hidden: hidden.has(`${postId.split("_")[1] ?? postId}_${900000 + i}`),
    comment_count: 0,
  }));

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const graphError = (res, status, message, code) =>
  json(res, status, { error: { message, type: "OAuthException", code } });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  // Strip the /vXX.Y version segment the client always sends.
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      if (!bearer && !form.get("access_token")) {
        return graphError(res, 401, "An access token is required.", 190);
      }
      const id = path.slice(1);
      if (form.get("is_hidden") === "true") hidden.add(id);
      else hidden.delete(id);
      json(res, 200, { success: true });
    });
    return;
  }

  if (!bearer) return graphError(res, 401, "An access token is required.", 190);

  if (path === "/me") return json(res, 200, PAGE);
  if (path === "/me/accounts") {
    return json(res, 200, { data: [{ ...PAGE, access_token: "mock-page-token" }] });
  }
  if (path === "/me/posts" || path === `/${PAGE.id}/posts`) {
    return json(res, 200, { data: POSTS });
  }

  const commentsMatch = path.match(/^\/([^/]+)\/comments$/);
  if (commentsMatch) {
    const id = commentsMatch[1];
    // A reply edge on a comment id: no replies in this fixture.
    if (!id.includes("_")) return json(res, 200, { data: [] });
    return json(res, 200, { data: commentsFor(id) });
  }

  const post = POSTS.find((p) => p.id === path.slice(1));
  if (post) return json(res, 200, post);

  graphError(res, 400, `Unsupported request: ${path}`, 100);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock Graph API on http://127.0.0.1:${PORT}`);
  console.log(`page: ${PAGE.name} (${PAGE.id})`);
  console.log(`posts: ${POSTS.map((p) => p.id).join(", ")}`);
  console.log("any non-empty access token is accepted");
});
