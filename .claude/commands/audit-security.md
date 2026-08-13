---
description: Security review against CLAUDE.md §6 and this app's actual threat model.
allowed-tools: Read, Grep, Glob, Bash, PowerShell
---

Audit security. This app is unusual: it hands a language model a shell, a
browser, and the mouse of a real machine, and it is multi-tenant. So the ordinary
web checklist is necessary and nowhere near sufficient.

Report findings with severity and a concrete failure scenario. Do not report
"consider using HTTPS"-grade filler.

## 1. Tenancy — the one that ends the project

Every account's data must be unreachable from every other account. Almost every
query in `server/store/pg.js` is scoped by `user_id`; **find any that is not.**

- A store method taking an id without also taking `userId`.
- A route reading `req.params` or `req.body` for an id and trusting it.
- A new table with no user scope at all.

`npm run test:isolation` is the executable version of this and is the single
most important suite in the repo. Run it.

## 2. Secrets

- `SESSION_SECRET` and `ENCRYPTION_KEY` must stay **separate** — rotating the
  first to sign everyone out must not destroy every stored provider key.
- Stored API keys are encrypted (`server/crypto.js`). Confirm nothing logs a
  decrypted key, and check `server/redact.js` still covers what reaches logs.
- `.env` must stay gitignored; `.env.example` must never carry a real value.
- Grep the tree for hard-coded `sk-`, `AIza`, `tvly-`, bearer tokens.

## 3. The model is an untrusted input source

Prompt injection is not hypothetical here — a page the model reads can tell it
what to do next, and it holds real tools.

- **SSRF**: `server/util/safeFetch.js` resolves every hop and refuses private
  addresses, re-checking on redirect. Confirm every outbound fetch the model can
  aim goes through it — a direct `fetch()` on a model-supplied URL reaches cloud
  metadata at 169.254.169.254 and hands out credentials.
- **Approval policy**: `assessRisk`/`riskReason` in `server/tools/definitions.js`
  must not classify anything destructive as `ordinary`, and `readOnly: true` must
  be true.
- **Path containment**: workspace-relative file tools must not escape via `..`
  or an absolute path. Note `FILE_ACCESS=full` deliberately lifts this locally.
- **MCP tools** are discovered per account at runtime and bypass the static
  catalogue. Check `server/mcp/` scopes and times them out.

## 4. The ordinary layer, done properly

- authN/authZ on every route — especially any added since the last audit, and
  admin-only routes in particular.
- `server/ratelimit.js` on login, register, password reset. Confirm reset
  responses do not reveal whether an account exists.
- Server-side validation of everything, regardless of client validation.
- `/api/cron/*` requires `CRON_SECRET`; without it these are open URLs that do
  real work.
- Security headers and framing rules — `test/http.test.mjs` pins them.

## 5. Dependencies

```
npm audit --audit-level=high
```

Advisory, not blocking. Report anything with a patch available.

Finish with severity-ranked findings and a recommendation for each. Per CLAUDE.md
§10, do not certify the app as secure — say what you checked and what you found.
