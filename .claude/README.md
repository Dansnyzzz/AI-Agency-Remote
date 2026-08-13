# `.claude/` — the working scaffold

What is in here, why each piece exists, and what was deliberately left out.

`CLAUDE.md` at the repo root is the constitution: rules that are always true.
This directory is everything that constitution says should *not* live in a prompt
— §2 draws the line, and it is worth restating, because it is the only thing that
decides where a new piece of guidance belongs:

| If it is… | it goes in | because |
|---|---|---|
| always true | `CLAUDE.md` | it must be loaded every session |
| a repeatable procedure | `skills/` | it loads itself when the work matches |
| noisy or context-hungry | `agents/` | it runs in its own context and reports back |
| something you invoke by hand | `commands/` | you decide when |
| a rule that must not be optional | `hooks/` | a prompt can be argued with; an exit code cannot |
| a connection to the outside | `.mcp.json` | it is configuration, not instruction |

## `hooks/` — the part that is not advisory

Everything else here is guidance the model can, in principle, talk itself out of.
These are enforced by the harness.

| Hook | Fires on | Blocks |
|---|---|---|
| `guard-bash.js` | `PreToolUse` · Bash, PowerShell | recursive force-delete, force-push, `reset --hard`, `DROP`/`TRUNCATE`, deleting `data/pgdata` or `.env`, `npm publish`, `vercel deploy` |
| `guard-write.js` | `PreToolUse` · Edit, Write | writes to `data/`, `.env`, `package-lock.json`, `node_modules/` |
| `lint-changed.js` | `PostToolUse` · Edit, Write | nothing — it lints the single file just written and reports problems back |

Wired in `settings.json`. Exit code 2 blocks the call and hands stderr to the
model, which is why every message says what to do *instead* rather than just no.

They are deliberately narrow. A guard that blocks a third of what a developer
legitimately types gets switched off within a week, and then it protects nothing.

**They are tested**, in `hooks/hooks.test.mjs`, and wired into `npm run check`:

```
npm run test:hooks
```

That test is not ceremony. It caught `guard-bash.js` blocking
`git push --force-with-lease` — the exact command its own error message
recommends — because `\b` matches at the hyphen in `--force-with-lease`. A guard
nobody tested is a guard that fails on the day it matters.

## `commands/` — invoked by hand

| Command | For |
|---|---|
| `/verify` | the CLAUDE.md §5 Definition-of-Done gate, run for real |
| `/deploy-check` | Vercel Hobby readiness — the schema traps that fail a build |
| `/migrate` | schema changes, which here work by **replay**, not numbered files |
| `/new-tool` | adding to the agent's 86-tool catalogue, wired end to end |
| `/new-provider` | adding an LLM provider without reintroducing a flat `max_tokens` |
| `/audit-security` | tenancy, prompt injection, secrets |
| `/audit-tokens` | what the app spends of the user's budget, measured |
| `/audit-performance` | cold starts, N+1, unbounded growth |
| `/gen-docs` | finding claims in the docs that have rotted |

## `agents/` — delegated, each in its own context

`security-auditor`, `code-reviewer`, `database-architect`, `backend-engineer`,
`frontend-engineer`, `qa-tester`, `performance-optimizer`, `ui-ux-designer`,
`technical-writer`.

Use one when the work is large enough that its exploration would crowd out the
main conversation, or when a second opinion should not be anchored by it.

## `skills/` — load themselves when the work matches

- `api-conventions` — route shape, status codes, auth, tenancy
- `accessibility-checklist` — keyboard, screen readers, contrast, i18n, states

## What was left out, and why

CLAUDE.md §11 sketches a fuller tree. §5 also says an item that does not apply
should be named rather than quietly skipped, so:

- **`seo-specialist`** — not applicable. This app is a login-gated private
  workspace; it has no public content to rank, and adding the agent would imply
  work that should never be done here. If a public marketing page is ever added,
  this becomes applicable immediately.
- **`deployment-checklist` / `db-migration` skills** — they would duplicate
  `/deploy-check` and `/migrate`. Deployment and migration are decisions you
  make deliberately, so a command you invoke is the right shape; a skill that
  loads itself is not.
- **`brand-voice`** — folded into `agents/technical-writer.md`, which is where
  the voice is actually described.
- **`.mcp.json`** — shipped as `.mcp.json.example` rather than enabled. Every
  MCP server adds its whole tool schema to **every request of every session**.
  The Playwright server alone is ~20 tools. Given how much of this codebase
  exists to keep the token bill down, turning that on by default would
  contradict the thing it is protecting. Copy the example and enable what you
  are actually using, when you are using it.

## Adding to this

If you find yourself giving the same instruction twice, it should have been a
skill the first time. If a mistake could happen at any moment and would be
expensive, it does not belong in a prompt — it belongs in a hook, with a test.
