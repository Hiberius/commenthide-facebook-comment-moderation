# Security policy

CommentHide holds a Facebook Page Access Token. That makes the token the only
thing in this project genuinely worth attacking, and the security model below
is built around keeping it out of every place it could leak from.

## Reporting a vulnerability

Report privately through **GitHub Security Advisories** on this repository:
open the **Security** tab, choose **Report a vulnerability**, and write it up
there. That draft advisory is visible only to you and the maintainers.

Please do not open a public issue for a vulnerability, and do not disclose it
elsewhere until a fix is released.

Include, as far as you can:

- what an attacker gains, and what access they need to start;
- the affected file or route;
- a reproduction — a request sequence is ideal;
- the version or commit you tested.

**Never paste a real Page Access Token, session cookie or `ENCRYPTION_KEY`
into a report.** Redact them. If you believe a token of yours was exposed,
revoke it in Meta Business Suite first, then report.

Expected response times, on a best-effort basis for a project maintained by
one person:

| Stage | Target |
| --- | --- |
| Acknowledgement | within 3 business days |
| Initial assessment | within 7 days |
| Fix or mitigation for a confirmed high-severity issue | within 30 days |

You will be credited in the advisory and the changelog unless you ask not to
be. There is no bug bounty.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| < 1.0 | No |

Only the latest release on `main` receives security fixes. CommentHide is
self-hosted: when a fix ships, redeploy from your own fork or remote with
`npm run deploy`.

## Security model

Each operator runs their own instance. There is no CommentHide service, no
shared backend and no vendor account in the middle.

**The Page Access Token**

- Encrypted at rest with **AES-256-GCM**, using a 32-byte key supplied as the
  `ENCRYPTION_KEY` Cloudflare secret and a fresh random 12-byte IV per
  encryption. Only the ciphertext is stored in D1.
- **Never returned to the browser.** `GET /api/status` reports `hasToken` as a
  boolean and nothing more. No API response contains the token.
- **Never written to a log.** Every string that could carry it — Graph API
  responses, error messages, audit-log detail — passes through `redact()`
  before it is stored, logged or returned.
- **Never placed in a URL.** Graph API calls send it in the request body or an
  `Authorization` header, so it cannot end up in a Cloudflare access log, a
  browser history entry or a `Referer`.
- Encryption key and token live in different places: the key is a Cloudflare
  secret, the ciphertext is a D1 row. Reading the database alone does not
  yield the token.

**Authentication and sessions**

- One shared admin password, supplied as the `ADMIN_PASSWORD` secret and
  compared in constant time.
- Sessions are **HMAC-SHA256-signed cookies** keyed by `SESSION_SECRET`.
  There is no server-side session store and no session id to steal from one.
  Cookies are `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Strict`,
  `Path=/`, and expire after 7 days.
- **Login is rate limited**: 8 failed attempts from one client fingerprint
  within 15 minutes locks that fingerprint out for 15 minutes.
- State-changing requests require a **double-submit CSRF token** — a header
  that must match a separate cookie.
- Security headers on every response: a strict CSP limited to `'self'`,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
  `Permissions-Policy`.

**Data residency**

All state — the encrypted token, the watched posts, the rules, the processed
comments and the audit log — lives in **your own Cloudflare account**, in your
own D1 database. Nothing is sent to any third party. The only outbound
requests the Worker makes are to `graph.facebook.com`. There is no telemetry,
no analytics, no error-reporting service, and the dashboard loads no web fonts
or external assets.

## In scope

- Anything that discloses the Page Access Token, the session secret or the
  encryption key.
- Authentication bypass, session forgery, privilege escalation.
- CSRF, XSS or injection in the dashboard or the API.
- SQL injection in the D1 layer.
- Rate-limit bypass on login.
- Cryptographic mistakes in `src/lib/crypto.ts` — IV reuse, weak key
  handling, non-constant-time comparison.
- A rule pattern that can cause catastrophic backtracking and hang the Worker.

## Out of scope

- Vulnerabilities in Cloudflare Workers, D1, or the Meta Graph API itself —
  report those to the respective vendor.
- Weak `ADMIN_PASSWORD` values, or secrets an operator has committed to their
  own repository.
- Missing hardening on an instance deployed with a modified configuration.
- Anything requiring an already-compromised Cloudflare account, since that
  account holds the secrets by design.
- Social engineering, spam reports and automated scanner output with no
  demonstrated impact.

## Operator checklist

- Give the token the narrowest permissions that work:
  `pages_manage_engagement` and `pages_read_engagement`.
- Generate `ENCRYPTION_KEY` and `SESSION_SECRET` with a CSPRNG
  (`npm run setup` does this) and set them with `wrangler secret put`. Never
  commit them; `wrangler.toml` and `.dev.vars` are gitignored for this reason.
- Use a long random `ADMIN_PASSWORD`.
- Rotate the Page Access Token if you suspect exposure, and rotate
  `SESSION_SECRET` to invalidate every existing session at once.
- Keep `RETENTION_DAYS` set so comment text does not accumulate indefinitely.

## Known limits, stated plainly

- **Rule patterns are operator-supplied code.** A `regex` rule is refused at creation time
  if it has the shape of a catastrophically backtracking pattern, or if it exceeds a
  short time budget against adversarial probes. Deciding this in general is undecidable,
  so the check is best-effort; as a second line of defence a user regex is only ever run
  against the first 400 characters of a comment.
- **Sessions are bound to the current password.** Rotating `ADMIN_PASSWORD` invalidates
  every session immediately. There is no per-session revocation beyond that.
- **Login throttling is keyed on the client IP.** An attacker with many source addresses
  is not slowed down by it, so `ADMIN_PASSWORD` still has to be a strong passphrase.
- **The comment ledger is never pruned.** It is bounded by real comment volume rather
  than by time, because every row in it carries a decision the poller must not re-make.
