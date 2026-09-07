# EXPOSURE — what is public, and what that costs

**Repo:** `https://github.com/Dansnyzzz/AI-remote.git`
**Visibility:** stated by the owner as PUBLIC. **Not independently confirmed** — the `gh` CLI is
not installed on this machine, so I could not read the visibility flag from the API. Everything
below assumes the owner's statement is correct.

**223 tracked files.**

---

## 1. The safety result first

| Check | Command | Result |
|---|---|---|
| `.env*` tracked | `git ls-files` | **Clean** — only `.env.example`, and every value in it is blank |
| `.env*` ever committed | `git log --all -- .env .env.production.local .env.vercel-paste.local` | **No commits. Never in history.** |
| `.env` ignored | `git check-ignore -v` | Yes — `.gitignore:3` and `:9` |
| `coverage/`, `node_modules/`, `data/` tracked | `git ls-files` | **None** |
| Hardcoded secrets in source | grep for provider key shapes, credentialed URLs, default passwords | **0 hits** across `server/ worker/ public/ api/ scripts/` |
| Customer data in repo | `data/` is gitignored; no data files tracked | **None** |

**No rotation is required. No history rewrite is required.** That is the important conclusion and
it is unusual — most repos audited at this size have at least one leaked value in history.

The one historical blemish, `EXP-003`: two `.fuse_hidden*` files were swept in by a blanket
`git add -A` and untracked in commit `38b44cd`. I read their content out of history and compared
it: they were byte-stale copies of `package.json` and `.github/workflows/ci.yml`. No secrets.
They remain readable in old commits and that is harmless.

---

## 2. Classification of what is tracked

### `BẮT BUỘC CÔNG KHAI` — must be public
`README.md`, `LICENSE` (absent — see §5), `.env.example`, `.mcp.json.example`, `.gitignore`,
`.nvmrc`, `package.json`, `package-lock.json`, `eslint.config.js`, `jsconfig.json`, `.c8rc.json`,
`vercel.json`, `.github/workflows/ci.yml`, `logo.png`.

`.env.example` deserves a note: it is 250 lines of genuinely good operator documentation with
every value blank. It is a model of how to write one.

### `NÊN CÔNG KHAI` — fine to be public
All of `test/` (39 files), `scripts/`, `api/index.js`, `docs/vercel-config.md`, `public/setup.ps1`,
`public/setup.sh`, `public/launcher.html`, `public/logo.png`.

The two setup scripts are byte-identical for every deployment and take the token from an
environment variable rather than interpolating it into the script body — which is exactly why they
are safe to serve publicly. The rationale is written at `setup.ps1:3-6` and `setup.sh:4-7`.

### `KHÔNG NÊN` — reveals operational know-how

| What | Files | What it gives away |
|---|---|---|
| **The agent's system prompt** | `server/agent.js:32-330` | ~14,500 characters of tuned instructions: the sign-in-page stop rule, the plan/do-not-plan test, the two-browsers distinction, the per-policy briefs. This is the product. |
| **The tool catalogue** | `server/tools/definitions.js` (2,233 ln) | 93 tool definitions plus the risk grading that decides what stops for approval |
| **Research pipeline design** | `server/research/*` | The proposer–critic–arbiter structure, the confidence formula, the reputable-domain list |
| **Built-in skills** | `server/skills/builtin.js` | The document-format conventions that make the output good |
| **Design specs and plans** | `docs/superpowers/**` (10 files) | Unreleased design work: auto-model mode, the agency autonomy spine, multi-step workflows, smart key fallback |
| **The `.claude/` operating manual** | 9 agents, 12 commands, 3 skills, 10 hooks | How this project is actually built and governed |

**Not yet classified in detail:** the explorer assigned to read every file under `.claude/` and
`docs/` failed before producing output (session rate limit). The table above is from the file
listing and my own reading of `.claude/settings.json`, `gate.js`, `verify-stop.js` and
`guard-bash.js` only. A file-by-file pass over `.claude/commands`, `.claude/agents`,
`.claude/skills` and `docs/superpowers` is still owed.

### `TUYỆT ĐỐI KHÔNG` — must never be public
**Nothing in this category is tracked.** Checked and confirmed clean.

---

## 3. The part that has nothing to do with repo visibility

`public/js` and `public/css` are sent to every browser that opens the app. Making the repository
private would not hide one byte of it. Two findings there are therefore exposure regardless of
what you decide about GitHub:

- **EXP-001** — the client ships 39 tool names with their argument schemas
  (`public/js/render.js:72-143`) and 11 tuned prompts (`pages.js:460-497`, `app.js:201-206`),
  purely to render text labels. Both could be sent as an already-rendered display string.
- **EXP-002** — business rules in the client: the free-tier rule and the 45-day "new model" window
  (`models.js:121-134`, `:31`), the cost-display and cache-hit thresholds (`app.js:2151-2159`), the
  shared-key monetisation bands (`app.js:3062-3079`), and three functions that deliberately mirror
  a server rule — MCP slug derivation (`app.js:2481-2486`), the CSV reader
  (`viewer.js:121-142`) and the JSONB message-storage schema (`app.js:4550-4562`).

Fixing these is worth more than any visibility change, because it is the only fix that works.

---

## 4. The four options — for the owner to choose

| # | Option | Protects | Costs | Effort |
|---|---|---|---|---|
| A | Make the repo **private** | All server-side source: the system prompt, the tool catalogue, the research pipeline, `.claude/` | Portfolio value, community, some free CI tiers | Very low |
| B | **Split in two** — public shell/demo/docs, private core | The competitive core, while keeping a public face | Two repos, split code, dependency plumbing | High |
| C | Keep public, **extract the core** to a private service or package behind an interface | The core, with one public front | An extra call layer, more latency, more infrastructure | Medium–high |
| D | Keep public, **clean secrets and customer data only** | Secrets and data | Know-how stays exposed | Low |

**D is the minimum floor, not an alternative — and on this repo D is already done.** There is
nothing to clean. So the real choice is: accept the current exposure, or move up to A, B or C.

**My recommendation: A, and only if the know-how genuinely matters commercially.**

The reasoning, stated plainly rather than hedged. The system prompt in `server/agent.js` is the
single most valuable artefact in this repository — it is thousands of words of behaviour tuned
against real failures, and its comments explain *why* each rule exists, which is worth more than
the rules. B and C both cost weeks and would fracture a codebase whose main virtue is that it is
coherent and unusually well commented. A costs one click and protects everything server-side
immediately.

But A protects nothing that already ships to the browser, so **whichever you choose, EXP-001 and
EXP-002 still need fixing.** And if the repository is serving as a portfolio piece — which, given
the quality of the commenting, it plausibly is — that is a real reason to stay public, and the
honest answer is then "accept the exposure and fix the client-side leakage".

---

## 5. Two smaller things

- **No `LICENSE` file is tracked.** A public repository with no licence is, by default, all rights
  reserved: nobody may legally use, copy or fork it. If the repository is public in order to be
  useful to others, that is probably not the intent. If it is public as a portfolio, it may be
  exactly the intent. Worth a deliberate decision either way.
- **`README.md` and `claude.md` have not been checked against the code.** The explorer assigned to
  do that failed. Documentation drift is not an exposure risk, but it is on the outstanding list.

---

## 6. Constraint honoured

Per the Phase 0 rules, this pass **reported only**. Nothing was changed: no edit to `.gitignore`,
no `git rm --cached`, no visibility change, no history rewrite. History rewriting is destructive
and affects every fork and clone; on the evidence above there is no reason to do it at all.
