// Tests for src/lib/auth.ts.
//
// The middleware only means anything inside a request, so every test drives a
// throwaway Hono app that mounts the real handlers (see ./support/auth-harness).
// The D1 binding from cloudflare:test backs the login throttling.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import {
  authAttemptRows,
  buildApp,
  call,
  cookieHeader,
  cookieJar,
  cookieLine,
  headersFor,
  HTTP,
  HTTPS,
  json,
  loginRequest,
  nowSec,
  PASSWORD,
  SESSION_TTL_SEC,
  sessionCookie,
  withEnv,
  type Client,
} from "./support/auth-harness";

beforeAll(async () => {
  // Idempotent: the schema must exist before the throttling tests touch D1.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM auth_attempts").run();
});

describe("requireAuth", () => {
  const client: Client = { ip: "203.0.113.10", ua: "vitest/session" };

  it("rejects a request with no session cookie", async () => {
    const res = await call(buildApp(), `${HTTPS}/private/ping`, { headers: headersFor(client) });

    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("unauthorized");
  });

  it("mints a hardened session cookie on a correct password and then authorises", async () => {
    const app = buildApp();
    const res = await loginRequest(app, client, PASSWORD);

    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);

    const jar = cookieJar(res);
    // Session plus CSRF: proves both cookies survive on a single response.
    expect(jar.size).toBe(2);
    expect(jar.get("__Host-ch_session")).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);

    const line = cookieLine(res, "__Host-ch_session") ?? "";
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).toMatch(/;\s*SameSite=Strict/i);
    expect(line).toMatch(/;\s*Path=\//i);
    expect(line).toContain(`Max-Age=${SESSION_TTL_SEC}`);

    const after = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie: cookieHeader(jar) }),
    });
    expect(after.status).toBe(200);
  });

  it("falls back to unprefixed, non-Secure cookies over plain http", async () => {
    const app = buildApp();
    const res = await loginRequest(app, client, PASSWORD, HTTP);
    const jar = cookieJar(res);

    expect(jar.has("ch_session")).toBe(true);
    expect(jar.has("__Host-ch_session")).toBe(false);
    expect(cookieLine(res, "ch_session") ?? "").not.toMatch(/;\s*Secure/i);

    const after = await call(app, `${HTTP}/private/ping`, {
      headers: headersFor(client, { cookie: cookieHeader(jar) }),
    });
    expect(after.status).toBe(200);
  });

  it("does not mint a session for a wrong password", async () => {
    const res = await loginRequest(buildApp(), client, `${PASSWORD}-wrong`);

    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Incorrect password.");
    expect(body.retryAfterSec).toBeUndefined();
    expect(cookieJar(res).size).toBe(0);
  });

  it("rejects a tampered signature", async () => {
    const app = buildApp();
    const raw = cookieJar(await loginRequest(app, client, PASSWORD)).get("__Host-ch_session") ?? "";
    const last = raw.slice(-1);
    const tampered = `${raw.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect(tampered).not.toBe(raw);

    const res = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie: `__Host-ch_session=${tampered}` }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a cookie whose issuedAt was edited under a valid signature", async () => {
    const app = buildApp();
    const raw = cookieJar(await loginRequest(app, client, PASSWORD)).get("__Host-ch_session") ?? "";
    const dot = raw.indexOf(".");
    const moved = `${Number(raw.slice(0, dot)) - 1}${raw.slice(dot)}`;

    const res = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie: `__Host-ch_session=${moved}` }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects malformed cookie values", async () => {
    const app = buildApp();

    for (const value of ["nodot", "abc.signature", ".signature", "1699999999.", "-1.sig"]) {
      const res = await call(app, `${HTTPS}/private/ping`, {
        headers: headersFor(client, { cookie: `__Host-ch_session=${value}` }),
      });
      expect(res.status, `value: ${value}`).toBe(401);
    }
  });

  it("accepts a correctly signed fresh cookie but rejects an expired one", async () => {
    const app = buildApp();

    // Control: a forged-but-valid cookie is accepted, which proves the signing
    // helper matches production and that the age check is what rejects below.
    const fresh = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie: await sessionCookie(nowSec() - 60) }),
    });
    expect(fresh.status).toBe(200);

    const expired = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie: await sessionCookie(nowSec() - SESSION_TTL_SEC - 10) }),
    });
    expect(expired.status).toBe(401);
  });

  it("tolerates small clock skew but rejects a cookie from the future", async () => {
    const app = buildApp();

    const skewed = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie: await sessionCookie(nowSec() + 30) }),
    });
    expect(skewed.status).toBe(200);

    const future = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie: await sessionCookie(nowSec() + 3600) }),
    });
    expect(future.status).toBe(401);
  });

  it("logout clears the cookies and revokes access", async () => {
    const app = buildApp();
    const jar = cookieJar(await loginRequest(app, client, PASSWORD));

    const res = await call(app, `${HTTPS}/session`, {
      method: "DELETE",
      headers: headersFor(client, { cookie: cookieHeader(jar) }),
    });
    expect(res.status).toBe(200);
    expect(cookieLine(res, "__Host-ch_session") ?? "").toContain("Max-Age=0");

    const after = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie: cookieHeader(cookieJar(res)) }),
    });
    expect(after.status).toBe(401);
  });

  it("fails closed when SESSION_SECRET is missing", async () => {
    const app = buildApp();
    const cookie = cookieHeader(cookieJar(await loginRequest(app, client, PASSWORD)));
    const broken = withEnv({ SESSION_SECRET: "" });

    const res = await call(
      app,
      `${HTTPS}/private/ping`,
      { headers: headersFor(client, { cookie }) },
      broken,
    );
    expect(res.status).toBe(401);

    // A misconfigured Worker answers exactly like a wrong password. Naming the
    // missing secret told an anonymous caller how the deployment is set up.
    const attempt = await loginRequest(app, client, PASSWORD, HTTPS, broken);
    expect(attempt.status).toBe(401);
    expect((await json(attempt)).error).toBe("Incorrect password.");
    expect(cookieJar(attempt).size).toBe(0);
  });

  it("refuses to log in when ADMIN_PASSWORD is not configured", async () => {
    const res = await loginRequest(buildApp(), client, "", HTTPS, withEnv({ ADMIN_PASSWORD: "" }));

    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("Incorrect password.");
    expect(cookieJar(res).size).toBe(0);
  });
});

describe("requireCsrf", () => {
  const client: Client = { ip: "203.0.113.20", ua: "vitest/csrf" };
  const TOKEN = "kZ9_test-csrf-token-0123456789abcd";

  it("lets a GET through with no token at all", async () => {
    const res = await call(buildApp(), `${HTTPS}/guarded/ping`, { headers: headersFor(client) });

    expect(res.status).toBe(200);
  });

  it("rejects a POST with no header", async () => {
    const res = await call(buildApp(), `${HTTPS}/guarded/ping`, {
      method: "POST",
      headers: headersFor(client, { cookie: `__Host-ch_csrf=${TOKEN}` }),
    });

    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("csrf");
  });

  it("rejects a POST with a header but no cookie", async () => {
    const res = await call(buildApp(), `${HTTPS}/guarded/ping`, {
      method: "POST",
      headers: headersFor(client, { "x-csrf-token": TOKEN }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects a POST whose header does not match the cookie", async () => {
    const res = await call(buildApp(), `${HTTPS}/guarded/ping`, {
      method: "POST",
      headers: headersFor(client, {
        cookie: `__Host-ch_csrf=${TOKEN}`,
        "x-csrf-token": `${TOKEN}x`,
      }),
    });

    expect(res.status).toBe(403);
  });

  it("allows a POST when the header matches the cookie", async () => {
    const res = await call(buildApp(), `${HTTPS}/guarded/ping`, {
      method: "POST",
      headers: headersFor(client, { cookie: `__Host-ch_csrf=${TOKEN}`, "x-csrf-token": TOKEN }),
    });

    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
  });

  it("mints a JS-readable token and reuses a valid one", async () => {
    const app = buildApp();
    const minted = await call(app, `${HTTPS}/csrf`, { headers: headersFor(client) });
    const token = (await json(minted)).token ?? "";

    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    const line = cookieLine(minted, "__Host-ch_csrf") ?? "";
    expect(line).toContain(`__Host-ch_csrf=${token}`);
    expect(line).not.toMatch(/HttpOnly/i);

    const reused = await call(app, `${HTTPS}/csrf`, {
      headers: headersFor(client, { cookie: `__Host-ch_csrf=${token}` }),
    });
    expect((await json(reused)).token).toBe(token);
    expect(cookieLine(reused, "__Host-ch_csrf")).toBeUndefined();

    const replaced = await call(app, `${HTTPS}/csrf`, {
      headers: headersFor(client, { cookie: "__Host-ch_csrf=short" }),
    });
    expect((await json(replaced)).token).not.toBe("short");
    expect(cookieLine(replaced, "__Host-ch_csrf")).toBeDefined();
  });
});

describe("login throttling", () => {
  const client: Client = { ip: "198.51.100.7", ua: "vitest/throttle" };

  it("locks the client out after eight consecutive failures", async () => {
    const app = buildApp();

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const body = await json(await loginRequest(app, client, "wrong"));
      expect(body.error, `attempt ${attempt}`).toBe("Incorrect password.");
      expect(body.retryAfterSec, `attempt ${attempt}`).toBeUndefined();
    }

    const locked = await json(await loginRequest(app, client, "wrong"));
    expect(locked.ok).toBe(false);
    expect(locked.error).toBe("Too many failed attempts. Try again shortly.");
    expect(typeof locked.retryAfterSec).toBe("number");
    expect(locked.retryAfterSec ?? 0).toBeGreaterThan(0);
    expect(locked.retryAfterSec ?? 0).toBeLessThanOrEqual(15 * 60);

    // The lock is not an oracle: the correct password is refused too.
    const correct = await loginRequest(app, client, PASSWORD);
    expect((await json(correct)).error).toBe("Too many failed attempts. Try again shortly.");
    expect(cookieJar(correct).size).toBe(0);
  });

  it("clears the failure counter on a later success", async () => {
    const app = buildApp();
    for (let attempt = 0; attempt < 8; attempt += 1) await loginRequest(app, client, "wrong");
    expect(await authAttemptRows()).toBe(1);

    // Move the lock into the past instead of waiting fifteen real minutes.
    await env.DB.prepare("UPDATE auth_attempts SET locked_until = 1").run();

    const success = await loginRequest(app, client, PASSWORD);
    expect(success.status).toBe(200);
    expect(cookieJar(success).has("__Host-ch_session")).toBe(true);
    expect(await authAttemptRows()).toBe(0);

    // The counter restarts: the next failure is failure one, not nine.
    const next = await json(await loginRequest(app, client, "wrong"));
    expect(next.error).toBe("Incorrect password.");
    expect(next.retryAfterSec).toBeUndefined();
    const row = await env.DB.prepare("SELECT failures FROM auth_attempts").first<{
      failures: number;
    }>();
    expect(Number(row?.failures ?? -1)).toBe(1);
  });

  it("throttles per IP, and a different IP is unaffected", async () => {
    const app = buildApp();
    const elsewhere: Client = { ip: "203.0.113.99", ua: client.ua };

    for (let attempt = 0; attempt < 8; attempt += 1) await loginRequest(app, client, "wrong");
    expect((await json(await loginRequest(app, client, "wrong"))).retryAfterSec ?? 0).toBeGreaterThan(
      0,
    );

    const unaffected = await json(await loginRequest(app, elsewhere, "wrong"));
    expect(unaffected.error).toBe("Incorrect password.");
    expect(unaffected.retryAfterSec).toBeUndefined();

    const stillFine = await loginRequest(app, elsewhere, PASSWORD);
    expect(stillFine.status).toBe(200);
  });

  it("cannot be escaped by varying the User-Agent from the same IP", async () => {
    // The fingerprint used to hash the IP together with the User-Agent, a field
    // the attacker chooses. Changing it produced a fresh bucket on every
    // request, so the lockout never triggered at all.
    const app = buildApp();

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await loginRequest(app, { ip: client.ip, ua: `vitest/agent-${attempt}` }, "wrong");
    }

    const blocked = await json(
      await loginRequest(app, { ip: client.ip, ua: "vitest/agent-fresh" }, "wrong"),
    );
    expect(blocked.retryAfterSec ?? 0).toBeGreaterThan(0);

    // And the lock is not an oracle: the correct password is refused too.
    const withRightPassword = await loginRequest(
      app,
      { ip: client.ip, ua: "vitest/agent-another" },
      PASSWORD,
    );
    expect(withRightPassword.status).toBe(401);
  });

  it("invalidates every existing session when ADMIN_PASSWORD is rotated", async () => {
    const app = buildApp();
    const cookie = cookieHeader(cookieJar(await loginRequest(app, client, PASSWORD)));

    const before = await call(app, `${HTTPS}/private/ping`, {
      headers: headersFor(client, { cookie }),
    });
    expect(before.status).toBe(200);

    const rotated = withEnv({ ADMIN_PASSWORD: "a-completely-different-passphrase" });
    const after = await call(
      app,
      `${HTTPS}/private/ping`,
      { headers: headersFor(client, { cookie }) },
      rotated,
    );
    expect(after.status).toBe(401);
  });
});
