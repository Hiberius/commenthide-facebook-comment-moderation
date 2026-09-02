# Contributing to CommentHide

CommentHide is a small, self-hosted Cloudflare Worker. It stays small on
purpose. Bug fixes, new rule kinds and documentation are all welcome.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the three secrets
npm run db:create                # prints your database_id
# paste that id into wrangler.toml (cp wrangler.toml.example wrangler.toml)
npm run db:apply:local
npm run dev
```

`npm run setup` walks through the same steps and generates the two random
keys for you. It never writes a secret to disk.

Two things to know about local development:

- Cron triggers do not fire under `wrangler dev`. Use **Run now** in the
  dashboard to exercise the poll loop.
- `__Host-` cookies require HTTPS. On plain-HTTP localhost the app falls back
  to unprefixed cookie names automatically — that is expected, not a bug.

## Tests and typecheck

```bash
npm run typecheck     # tsc --noEmit, strict
npm test              # vitest run
npm run test:watch
npm run test:coverage
```

Both must pass before a pull request is reviewed. CI runs exactly these two
commands plus a `wrangler deploy --dry-run` to prove the Worker still builds.

The rule engine (`src/lib/rules.ts`) is pure and has no I/O, so it is the
easiest place to add tests — do it there rather than through the HTTP layer
whenever the behaviour allows.

## Project layout

```
src/
  index.ts        Hono app, route mounting, scheduled() cron entry point
  types.ts        every shared type — import from here, never redeclare
  lib/
    auth.ts       login, session cookie, CSRF
    crypto.ts     AES-256-GCM, redact(), constant-time compare
    graph.ts      Meta Graph API client
    poller.ts     the poll loop
    retention.ts  history pruning
    rules.ts      rule engine (pure)
    security.ts   security headers
    storage.ts    every D1 query
  ui/             the dashboard, served as one self-contained document
migrations/       D1 schema — the migration owns the schema, not the code
tests/            vitest
docs/CONTRACT.md  binding signatures and semantics for every module
```

`docs/CONTRACT.md` is authoritative. If you need a signature that is not in
it, add to the contract in the same pull request rather than diverging from
it quietly.

## Coding standards

These are enforced by review, and most of them by `tsconfig.json`:

- **Strict TypeScript**, with `noUncheckedIndexedAccess` on. Indexing an
  array or record yields `T | undefined`; handle the `undefined` branch.
- **No file over 400 lines.** Split it instead.
- **No mutation of inputs.** Build and return a new object.
- **Handle every error path explicitly.** Never catch and discard.
- **Redact anything that could contain a token.** Any string derived from a
  Graph API response or an error message goes through `redact(text, token)`
  before it is logged, stored or returned. The Page Access Token must never
  reach the browser, a log line or a URL.
- Comments in English, sparse, explaining *why* rather than *what*.
- No web fonts and no third-party runtime requests. The dashboard is one
  self-contained document.

## Proposing a new rule kind

A rule kind is a value of `RuleKind` in `src/types.ts` plus a matcher in
`src/lib/rules.ts`. To add one:

1. Open an issue first describing what the kind matches and why the existing
   kinds cannot express it.
2. Add the literal to `RuleKind` in `src/types.ts`.
3. Add the value to the `CHECK (kind IN (...))` constraint. Schema changes go
   in a **new** migration file (`migrations/0002_*.sql`); never edit
   `0001_init.sql`, which is already applied on live deployments.
4. Implement the matcher in `compileRule` and give it a line in
   `describeRule` so the dashboard can explain itself.
5. Add tests covering a match, a non-match and a malformed pattern.
   `compileRule` returns `null` for an invalid pattern — it must not throw.
6. Document the kind in the rule-kind table in `docs/CONTRACT.md` and in the
   README.

Matchers must be pure, must not use catastrophic backtracking, and must be
accent-insensitive where text comparison is involved (normalise with
`normalize("NFD")` and strip combining marks).

New kinds that suppress ordinary criticism rather than spam or abuse will be
declined. `DEFAULT_RULES` in particular has to stay defensible.

## Commit convention

Conventional commits, lowercase, imperative:

```
feat: add author_allow rule kind
fix: stop re-resolving the post target on every poll
refactor: split storage helpers by table
docs: document the baseline flag
test: cover emoji_spam threshold parsing
chore: bump wrangler
perf: batch seen-comment lookups into one query
ci: run wrangler deploy --dry-run on pull requests
```

One logical change per commit. Keep the subject under 72 characters and put
the reasoning in the body.

## Pull requests

- Branch from `main`.
- Fill in the pull request template.
- Say what you tested and how. "Ran the poll loop against a real post in
  dry-run mode" is a useful sentence; "works" is not.
- Never paste an access token, a Page id or a real comment author's name into
  an issue, a pull request or a test fixture.
