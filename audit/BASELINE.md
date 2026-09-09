# BASELINE — measured before any change

Two baselines are kept. The 2026-09-03 column is the one the earlier audit round
was measured against; the 2026-09-09 column is this session's re-measurement and
is the one Phase 2 and Phase 3 must be compared to. Nothing here is estimated
unless the row says so.

**2026-09-09 state:** branch `main`, HEAD `3e8273e`, **working tree clean**.
`gate.js status` → `verified: true`, `current: true`, `scope: full`, stamped
against `3e8273e`. Every green below was re-run by hand this session rather than
read off that stamp.

---

## The gate

| Chỉ số | Cách đo | 2026-09-03 | 2026-09-09 | Nhãn |
|---|---|---|---|---|
| `npm run gate` scope | `.claude/hooks/gate.js:270-282` (`STEPS.full`) | lint + test + test:hooks | **lint + test:hooks + eval + typecheck + test** | `[FACT]` |
| `npm run check` scope | `package.json:19` | six steps | lint + typecheck + test + eval + test:sandbox + test:hooks | `[FACT]` |
| Gate stamp | `node .claude/hooks/gate.js status` | `verified:true` over a red typecheck | `verified:true`, and typecheck is inside the gate | `[FACT]` |
| **Is the gate real?** | compare scope against CI | **NO — stamped green over 7 type errors** | **YES.** The one remaining honest gap is `test:ui` + `test:sandbox`, which need a browser and are run in CI only. The stamp says `full`, not `everything`, for exactly that reason. | `[FACT]` |
| `npm run lint` | `npx eslint .` | 0 problems, exit 0 | **0 problems, exit 0** | `[FACT]` |
| `npm test` | run to completion | pass, exit 0 | **pass, exit 0** | `[FACT]` |
| Suites in `npm test` | `p.scripts.test.split('&&').length` | 31 | **31** | `[FACT]` |
| `npm run test:hooks` | run | 114 checks | **128 checks, exit 0** | `[FACT]` |
| `npm run eval` | run | — | **13/13 cases pass, exit 0** (scripted; `--live` not run) | `[FACT]` |

## Type checking

| Chỉ số | Cách đo | 2026-09-03 | 2026-09-09 | Nhãn |
|---|---|---|---|---|
| Real `tsc` errors | `npx tsc -p jsconfig.json --noEmit \| grep -c "error TS"` | 436 | **363** | `[FACT]` |
| Recorded ceiling | `.typecheck-baseline.json` `total` | 429 | **363** | `[FACT]` |
| Errors above the ceiling | subtraction | **+7 (gate was lying)** | **0** | `[FACT]` |
| Files holding frozen errors | count of `files` keys | — | **43** | `[FACT]` |
| Ratchet verdict | `node scripts/typecheck.js` | red | **green — "363 outstanding (ceiling 363)"** | `[FACT]` |

The ratchet still swallows 363 real errors. It is honest about that — it fails
only when the number rises — but a green typecheck here means "no worse", not
"clean". `strictNullChecks` is not on; enabling it was measured at 1,979 errors
and is a project of its own.

## Size

| Chỉ số | Cách đo | 2026-09-03 | 2026-09-09 | Nhãn |
|---|---|---|---|---|
| Tracked files | `git ls-files \| wc -l` | 223 | **243** | `[FACT]` |
| Lines of code (tracked, code only) | `git ls-files \| grep -E '\.(js\|mjs\|css\|html\|sql\|ps1\|sh)$' \| xargs wc -l` | 72,880 | **76,108** | `[FACT]` |
| `server/app.js` | `wc -l` | 2,838 | **1,663** | `[FACT]` |
| `server/routes/` | `ls` | did not exist | **6 modules** | `[FACT]` |
| `public/js/app.js` | `wc -l` | 4,787 | **4,154** | `[FACT]` |
| HTTP route handlers | grep over `server/app.js` + `server/routes/*.js` | ~93 | **104** | `[FACT]` |
| `SCHEMA_VERSION` | `server/store/pg.js:189` | 16 | **17** | `[FACT]` |
| Providers | `Object.keys(PROVIDERS)` | 4 | **5** — anthropic, openai, google, openrouter, orcarouter | `[FACT]` |
| Locale keys | `Object.keys()` on each locale | 412 | **670 en / 670 vi, at parity** | `[FACT]` |

## Token cost per turn

Measured with `availableTools({ workerOnline:true, desktopOnline:true, context })`
and `JSON.stringify(...).length / 4`. The estimate divisor is the repo's own.

| Window | Tools offered | Est. tokens |
|---|---|---|
| whole `TOOLS` array (not what a turn sends) | 93 | 13,326 |
| 200,000 | 48 | **6,896** |
| 128,000 | 48 | **6,896** |
| 40,000 | 48 | 4,401 |
| 16,000 | 47 | 4,325 |
| 8,000 | 47 | 4,325 |

Deferral is real and it works: a 128k turn pays 6,896 rather than 13,326, a 48%
saving. Note the *count* barely moves below 40k — the saving there comes from
`firstSentence` description trimming, not from dropping tools.

`[UNKNOWN]` — the system prompt half of the per-turn cost was not re-measured
this session; the 2026-09-03 figures were 1,791 tok with no worker and 3,614 with
worker+desktop.

## Hygiene

| Chỉ số | Cách đo | 2026-09-03 | 2026-09-09 | Nhãn |
|---|---|---|---|---|
| `.env*` tracked or in history | `git ls-files`, `git log --all --diff-filter=A` | none | **none — only `.env.example`, values blank** | `[FACT]` |
| Hardcoded secret patterns | grep for `sk-`, `AIza`, `ghp_`, `xox`, credentialed URLs | 0 | **0** in `.env.example`; full-tree scan not re-run this session | `[FACT]` / `[UNKNOWN]` |
| `fetch(` call sites | scan of `server/ api/ worker/` | 30 | **30** | `[FACT]` |
| …without an abort signal | per-site scan, one hit read by hand | 3 | **0** — the single scanner hit (`server/mcp/client.js:247`) carries `signal: AbortSignal.timeout(timeoutMs)` 12 lines below the call | `[FACT]` |
| Empty `catch {}` | grep | 2 | **3** — not re-classified; the 2026-09-03 count found 2 of 3 to be grep artefacts | `[INFER]`, needs a read |
| `TODO/FIXME/HACK/XXX` | grep | 1 | **2** | `[FACT]` |
| `console.log` in `server/ api/ worker/` | grep | 50 | **58** | `[FACT]` — mostly CLI banners; 2 request-path sites were moved to the trace logger under `CODE-005` |
| Coverage | `.c8rc.json`, recorded 2026-09-02 | 57.81 / 74.28 / 68.59 | **not re-run** | `[UNKNOWN]` |

## Still not measured, and why

| Chỉ số | Nhãn |
|---|---|
| LLM calls per typical request | `[UNKNOWN]` — needs a live provider key |
| Token in/out per request | `[UNKNOWN]` — same |
| End-to-end latency (median of 3) | `[UNKNOWN]` — same. Spending the owner's credit has not been authorised, and a number invented here would be worse than none |
| External API calls per request | `[UNKNOWN]` — depends on which tools the model chooses |
| Repo visibility, read from the API | `[UNKNOWN]` — `gh` is not installed on this machine. The owner's statement that it is PUBLIC is taken as given |
