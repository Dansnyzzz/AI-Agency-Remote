---
description: Change the database schema safely, the way this codebase actually does it.
argument-hint: [what the schema needs to do]
allowed-tools: Read, Edit, Grep, Glob, Bash, PowerShell
---

Change the schema. This project does **not** use numbered migration files, and
inventing one here would break the mechanism that exists.

## How it actually works

`server/store/pg.js` holds `SCHEMA_VERSION` (currently 12) above a numbered log
of what each version added. On boot, `ready()`:

1. reads `schema_version` from `settings`;
2. returns immediately if it already matches — this is the hot path, one SELECT;
3. otherwise replays **all of `server/store/schema.sql`**, statement by statement;
4. stamps the new version.

The consequence governs everything below: **`schema.sql` is replayed in full
against databases that already have data.** It is not a fresh-install script.

## The rules

- **Every statement must be idempotent.** `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. A
  bare `CREATE TABLE` throws on the second run and takes the whole boot with it.
- **Add columns, do not redefine tables.** A new column on an existing table
  needs a default or must be nullable — there are already rows, and they need a
  value. `session_epoch` is the worked example: added, then backfilled, then
  `NOT NULL`, never `NOT NULL` in one step.
- **Never write a destructive statement.** `DROP`, `TRUNCATE` and column removal
  run against real user data on every existing deployment. `.claude/hooks/guard-bash.js`
  blocks them at the shell, and they do not belong in `schema.sql` either. If
  something must genuinely go, that is a conversation with the user first.
- **Bump `SCHEMA_VERSION` and add its line to the log comment.** Without the bump
  nothing replays and the change never reaches anyone who already has a database.
  The comment is how the next person knows what version 13 was for.
- **The HTTP driver runs one statement per call** (`splitStatements`). Keep
  statements separable; do not rely on a multi-statement batch.
- **Index anything you will filter or join on**, per CLAUDE.md §7 — and remember
  almost every table here is scoped by `user_id`.

## Verify

```
npm run test:schema
npm run test:isolation
npm run test:deploy
```

- `test:schema` pins the DDL's shape.
- **`test:isolation` is the one that matters**: it runs the real SQL against a
  real Postgres and then tries to cross the boundary between two accounts. A new
  table without a `user_id` scope is exactly what it exists to catch.
- `test:deploy` replays the migration over a *populated* database and checks the
  existing account survives, the backfill happened, and a migrated database then
  skips the DDL entirely.

Report which of these ran and what they said.
