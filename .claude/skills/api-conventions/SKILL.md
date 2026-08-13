---
name: api-conventions
description: Use when adding, changing, or reviewing an HTTP route in server/app.js — covers auth, error shape, status codes, rate limiting, validation, and the serverless constraints every route runs under.
---

# API conventions

Every route in this app lives in `server/app.js` and runs in two very different
places. Read an adjacent route before writing a new one; the patterns below are
already there.

## The shape

```js
app.post(
  '/api/thing',
  rateLimit('thing'),            // anything unauthenticated
  wrap(async (req, res) => {     // wrap() catches async throws
    try {
      const result = await doIt(body(req), req, res);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
  }),
);
```

- `wrap()` — always. An unhandled async rejection in Express takes down the
  request with no useful response.
- `body(req)` — the parsed body. Validate it here, on the server, regardless of
  what the client already checked (CLAUDE.md §6).
- Errors are `{ error, code? }`. `error` is a **sentence a person can act on**,
  not an exception string. `code` is for the client to branch on.

## Status codes, as used here

| | |
|---|---|
| `400` | the request is wrong |
| `401` | not signed in, or a bad credential — `{ error: 'unauthorized' }` |
| `403` | signed in and **not allowed** — a closed deployment refusing a registration is this, not a 400. The client can then say something true. |
| `404` | no such thing *for this user* — never reveal that it exists for someone else |
| `429` | rate limited |
| `503` | the deployment is misconfigured; name the missing variable |

## Auth — decide explicitly, every time

There is no default. For each new route state who may call it:

- **session** — `currentUser(req)`; the ordinary case
- **worker** — `requireWorker`, a bearer token identifying whose computer calls.
  The device row identifies the machine; **ignore any id the client reports** and
  use the one its token proves.
- **cron** — `requireCron` with `CRON_SECRET`. Without it these are public URLs
  that do real work.
- **admin** — check it, and test that a non-admin gets 403.

## Tenancy

Every store call takes `userId`. Never trust an id from `req.params` or
`req.body` to identify *whose* row it is — take the id from the session and scope
the query. This is what `test/isolation.test.mjs` exists to catch.

## Serverless constraints

- No module-level mutable state that matters: instances are reused across
  invocations **and across users**.
- No writable filesystem, nothing surviving between requests, no timers.
- Long work must stream, both for the user and to stay inside 300s.

## Not-found and unknown paths

An unknown `/api/*` path must answer **as an API** — JSON, not the HTML shell.
`test/http.test.mjs` pins this, along with the security headers and the framing
rules. Run it after touching anything here.
