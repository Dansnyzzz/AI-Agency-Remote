# Changelog

## 2026-09-15 (night) — emails that look finished

Branch `feat/email-design`.

### Changed

- **`send_email` sends a designed email.** The body is Markdown, laid out by `server/mailTemplate.js`:
  a branded header, the date and subject as a title, section headings with an accent bar (a line
  written in capitals becomes one, capitals kept), lists, tables, callouts, quiet "Nguồn:/Sources:"
  lines, and a footer naming the sender with a reply hint — in Vietnamese or English. Tables and inline
  styles only, 600px wide, no images, fonts or scripts, so it renders the same in Gmail, Outlook and on
  a phone and carries nothing a filter scores as remote content. A plain-text part is sent beside it.
- **The password-reset email uses the same layout.**
- The tool tells the model to write Markdown, not HTML.

## 2026-09-15 (evening) — the app is Synapse; mail written to reach the inbox

Branch `feat/synapse-brand-and-inbox`.

### Changed

- **Renamed from AI Remote to Synapse** everywhere a person reads the name: the page, sign-in,
  onboarding, emails, server messages, the worker and launcher banners, the authenticator label for
  newly enrolled two-factor, and the author metadata of generated Word, Excel and PowerPoint files.
  `test/i18n.test.mjs` fails if the old name comes back.
- **Email From line is the deployment's name only.** "Lan Nguyen via …" <mailbox@gmail.com> looked
  like impersonation to spam filters. The person is now in Reply-To and a footer line.
- **Every text email has an HTML part** beside it, plain and escaped.

### Not renamed, on purpose

- The worker's autostart task (`AI Remote worker`) and the folder downloaded files live in
  (`AI Remote\files`): existing installs depend on those names.
- Browser storage keys, the `ai-remote` package name, install folders and the Vercel URL.
- Authenticator apps keep the label an account was enrolled with until two-factor is set up again.

## 2026-09-15 (later) — email for each person, and formulas that render

Branch `feat/email-per-user-and-math-render`.

### Fixed

- **`send_email` said "sent" when the provider refused.** `sendEmail` returns `{ ok: false }`
  rather than throwing, and the tool ignored it. A refusal is now reported as the email NOT sent,
  with the provider's reason.
- **Formulas printed as raw TeX.** `$…$`, `$$…$$`, `\(…\)` and `\[…\]` are typeset with KaTeX
  0.18.7, served from `public/vendor/katex` and loaded only when a reply contains one. Prices such
  as "$5 and $10" stay text.
- **Code under a bullet was mangled.** A fenced block indented under a list item renders inside that
  item; ``````lang code`````` on one line is inline code.

### Changed

- **`send_email` writes on the user's behalf.** `to` is optional — empty sends to the account's
  registered address — and accepts up to ten addresses. The From line names the person, and
  Reply-To is their address.
- **Gmail in two variables:** `GMAIL_USER` and `GMAIL_APP_PASSWORD`.

### Upgrade notes

- To send from the deployment's Gmail, set `GMAIL_USER` and `GMAIL_APP_PASSWORD` (an App
  Password) in the hosting environment and redeploy.
- `katex` is a dev dependency; after upgrading it run `npm run vendor:katex` — the test suite fails
  until the vendored copy matches.

## 2026-09-15 — Auto is OpenRouter's free router; a Languages tab; full translation

Branch `feat/auto-openrouter-free-languages`.

### Changed

- **Auto is `openrouter/free`.** It used to rank the library by a hand-kept family order and
  had a separate "prefer a model that reads images" setting. OpenRouter's router now picks a free
  model per message, including one that reads images, so the setting is gone. Auto needs an
  OpenRouter key; an OrcaRouter key alone no longer runs it.
- **Settings → Models is replaced by Settings → Languages.** The language choice moves out of
  Behaviour into its own tab. Adding a model by id and checking the built-ins lose their buttons;
  `POST /api/models` and `POST /api/models/audit` still work.

### Added

- **Complete Vietnamese.** Every label, hint, placeholder and tooltip in the page, every string the
  modules build (menus, cards, badges, statuses, the model picker), and the server's own sentences —
  HTTP errors, stream status and retry lines, approval reasons, connector help, MCP suggestions,
  stored workflow step errors.
- `server/i18n` translates at the response boundary from the `X-Language` header;
  `scripts/server-messages.js` lists every server sentence from the source.
- `test/server-i18n.test.mjs`, and a markup-coverage check in `test/i18n.test.mjs`.

### Upgrade notes

- The `autoVision` preference is ignored and no longer saved.
- `espree` is now a direct dev dependency (it was already installed through ESLint).

## 2026-09-14 — server and worker audit

Branch `audit/server-worker-2026-09-09`, from `main` at `3e8273e`. Every entry has a
ledger ID in `audit/ISSUE_LEDGER.md` with the evidence and the test that holds it;
`audit/RESULT.md` has the before/after measurements.

### Upgrade notes — read before deploying

- **Schema 18.** `chats.next_seq` is added and back-filled on first start. Nothing to
  run by hand; a database already at 18 skips it. (`ARCH-007`)
- **Worker: plain `http://` to an internet host is now refused.** `https://` works
  anywhere, `http://localhost` works, and a private-network address works with a
  warning. Set `ALLOW_INSECURE_SERVER=1` in `worker/.env` only if you accept the
  token and every command crossing the network unencrypted. (`SEC-032`)
- **Image generation uses `gemini-3.1-flash-image`.** Google shut down the Imagen 4
  endpoint the app used on 2026-08-17. Same Google key; checked against the SDK's
  types but **not yet run against a live key**. (`GAP-008`)
- **`openai/o4-mini` is substituted with `openai/gpt-5.6-terra` after 2026-10-23**,
  and the turn says so. (`GAP-009`)
- **Now asks first:** `schedule_task`, `workflow_write`, `skill_write`. (`SEC-027`)
- New optional variables, documented in `.env.example`: `MAX_TURN_TOKENS`,
  `RESEARCH_REPUTABLE_DOMAINS`, `ALLOW_INSECURE_SERVER`.

### Security

- Web pages, files, command output, GitHub and Notion text read by tools are marked
  as untrusted content at one exit, whichever path produced them. (`SEC-015`, `SEC-019`)
- The MCP http transport connects to the address it checked, closing DNS rebinding.
  (`SEC-016`)
- `python -c`, `node -e` and other interpreters launched as apps count as shells.
  (`SEC-017`)
- Server logs are redacted like replies. (`SEC-018`, `SEC-020`)
- An upsert can no longer cross an account boundary. (`SEC-021`)
- `export_pdf` can no longer print local files. (`SEC-022`)
- Read-only and plan mode refuse a changing tool even if the model names one it was
  not offered; an approval binds to the calls it was shown for. (`SEC-023`)
- A dangling link cannot carry a write out of the workspace. (`SEC-025`)
- A sub-agent runs only tools it was offered. (`SEC-026`)
- Re-pairing a computer to another account clears the last account's background
  commands and browser session. (`SEC-028`)
- One MCP server with a badly named tool, or two servers whose names reduce to the
  same id, no longer break every turn. (`SEC-029`)
- Under the `auto` policy, one turn sends at most five unapproved messages.
  (`SEC-030`)
- Credentials on the clipboard are redacted before the model reads them. (`SEC-031`)

### Correctness and reliability

- After auto-compaction the model keeps the recent turns and the question, not just
  the summary. (`ACC-007`)
- Vietnamese national press counts as a reputable source in research. (`ACC-006`)
- A tool call whose arguments were cut off is refused, not run on defaults; every
  call is checked against its schema first. (`AUTO-005`, `GAP-004`)
- An unattended run that was cut off is no longer recorded as ok. (`AUTO-006`)
- Resuming never repeats a call that may already have happened. (`AUTO-007`, `AUTO-008`)
- Pressing Stop stops the command on the computer, downloads and indexing included.
  (`AUTO-009`, `CODE-017`)
- Stopping keeps the half of the answer already shown. (`CODE-016`, `CODE-018`)
- Writing one memory note no longer erases the others. (`CODE-023`)
- A schema upgrade that fails part way on a local install leaves nothing half built.
  (`ARCH-009`)
- Sub-agents are only offered connectors the account has linked. (`CODE-026`)

### Cost and performance

- A per-turn token ceiling on shared keys (`MAX_TURN_TOKENS`). (`PERF-009`)
- A model that states no output limit gets a cautious budget, not 32,000.
  (`PERF-010`, `PERF-013`)
- Indexing a folder takes two statements, not two per file. (`PERF-012`)
- Image generation books its token usage. (`CODE-024`)

### Tooling and repository

- The gate stamp is judged by source content, so documentation commits do not expire
  it; sub-agents are never blocked at Stop. (`CFG-018`–`CFG-020`)
- The brief reports branch protection as it really is; cutting a release counts as
  publishing. (`CFG-012`, `CFG-017`, `CFG-021`)
- The prompt carries a version fingerprint the eval pins. (`GAP-003`)
- Four route files git treated as binary are plain text again, with a test.
  (`CODE-025`)
- No tracked source file may contain a raw control byte. (`CODE-022`)
- `claude.md` renamed to `CLAUDE.md`; stale numbers corrected across docs.
  (`CFG-016`, `CODE-012`–`CODE-015`, `CODE-027`)
- Type-error ceiling 363 → 362. Coverage 61.06% statements / 75.21% branches /
  75.32% functions.

### Not done, and why

- `GAP-005` prompt A/B, `GAP-006` OpenAI strict mode, `CODE-021` booking abandoned
  streams: each needs a live key, spend, or data the provider does not report.
- `GAP-010` translated server errors and `GAP-011` a self-check pass in the agent
  loop are features awaiting a decision, not defects.
