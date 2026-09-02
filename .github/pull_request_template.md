## What this changes

<!-- One or two sentences. Link the issue it closes: Closes #123 -->

## Why

<!-- The reasoning, not the diff. What was wrong or missing before? -->

## How it was tested

<!--
Be specific. "Ran the poll loop against a real post in dry-run mode and
confirmed the link rule matched" is useful; "works" is not.
-->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] New behaviour is covered by tests

## Type of change

- [ ] feat — new capability
- [ ] fix — bug fix
- [ ] refactor — no behaviour change
- [ ] docs
- [ ] test
- [ ] chore / ci / perf

## Checklist

- [ ] Commits follow the conventional-commit convention (`feat:`, `fix:`, …)
- [ ] No file exceeds 400 lines
- [ ] No input is mutated; new objects are returned instead
- [ ] Every error path is handled explicitly — nothing is caught and discarded
- [ ] Anything that could contain the Page Access Token passes through `redact()`
      before it is logged, stored or returned
- [ ] No token, secret, real Page id or real comment author appears in the diff,
      the tests or this description
- [ ] Shared types are imported from `src/types.ts`, not redeclared
- [ ] Schema changes are in a **new** migration file, not an edit to `0001_init.sql`
- [ ] `docs/CONTRACT.md` updated if a signature or a rule kind changed

## Breaking changes

<!-- Migrations to run, config to add, behaviour operators must know about. "None" is a fine answer. -->
