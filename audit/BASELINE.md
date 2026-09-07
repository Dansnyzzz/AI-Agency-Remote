# BASELINE — measured before any change

Measured 2026-09-03 on branch `main`, working tree **dirty** (46 staged files).
Every row is a real command that was run. Nothing here is estimated unless labelled.

| Chỉ số | Cách đo | Giá trị | Nhãn |
|---|---|---|---|
| `npm run gate` scope | read `.claude/hooks/gate.js:196-206` | `lint` + `test` + `test:hooks` only | `[FACT]` |
| `npm run check` scope | `package.json:19` | lint + typecheck + test + eval + test:sandbox + test:hooks | `[FACT]` |
| Gate stamp says | `node .claude/hooks/gate.js status` | `"verified": true`, scope `full` | `[FACT]` |
| **Typecheck actually** | `node scripts/typecheck.js` | **FAILS — errors went up** | `[FACT]` |
| Real tsc error count | `npx tsc -p jsconfig.json --noEmit` | **436** | `[FACT]` |
| Errors frozen in baseline | `.typecheck-baseline.json:2` | **429** | `[FACT]` |
| New errors not in baseline | 436 − 429 | **7** across 4 files | `[FACT]` |
| Lint | `npx eslint .` | **0 problems, exit 0** | `[FACT]` |
| Test suite (31 suites) | `npm test` | **PASS, exit 0** | `[FACT]` |
| Coverage | `.c8rc.json` recorded 2026-09-02 | statements 57.81 / branches 74.28 / functions 68.59 | `[FACT]` (not re-run) |
| Tracked files | `git ls-files \| wc -l` | 223 | `[FACT]` |
| Lines of code (tracked, code only) | `git ls-files \| grep -E '\.(js\|mjs\|css\|html\|sql\|ps1\|sh)$' \| xargs wc -l` | **72,880** | `[FACT]` |
| — server/ | same | 26,765 | `[FACT]` |
| — test/ | same | 16,253 | `[FACT]` |
| — public/js/ | same | 11,968 | `[FACT]` |
| — worker/ | same | 5,995 | `[FACT]` |
| — .claude/hooks/ | same | 1,691 | `[FACT]` |
| HTTP routes | grep `api.(get\|post\|put\|patch\|delete)` in `server/app.js` | ~93 | `[FACT]` |
| Tool catalogue size | `JSON.stringify(TOOLS).length` | 53,302 chars ≈ **13,326 tokens** | `[FACT]` |
| Tool count | `TOOLS.length` | **93** | `[FACT]` |
| System prompt — no worker | `buildSystemPrompt()` | 7,163 chars ≈ 1,791 tok | `[FACT]` |
| System prompt — worker+desktop | `buildSystemPrompt()` | 14,455 chars ≈ **3,614 tok** | `[FACT]` |
| **Fixed prompt overhead / turn** | catalogue + system | **≈ 16,900 tokens** before a single user word | `[FACT]` |
| Agent step budget | `server/settings.js:11` | `maxSteps: 30` | `[FACT]` |
| Parallel tool cap | `server/util/parallel.js:23` | `MAX_PARALLEL_TOOLS = 4` | `[FACT]` |
| Per-request token ceiling | grep | **none** — only a monthly per-account quota | `[FACT]` |
| Default monthly quota | `server/usage.js:12-14` | **null** unless `DEFAULT_MONTHLY_TOKEN_LIMIT` is set | `[FACT]` |
| `fetch(` calls in server+worker+api | grep | 30 | `[FACT]` |
| fetch WITHOUT timeout | per-call awk scan | **3** — `server/connectors.js:28,41,54` | `[FACT]` |
| Empty `catch {}` blocks | grep | 2 | `[FACT]` |
| Hardcoded-secret pattern hits | grep over js/json/html | **0** | `[FACT]` |
| `.env*` tracked or in history | `git ls-files`, `git log --all` | **none** — only `.env.example` | `[FACT]` |
| TODO/FIXME/HACK/XXX | grep | **1** | `[FACT]` |
| `console.log` in server/api/worker | grep | 50 | `[FACT]` |
| LLM calls per typical request | not traced end to end | | `[UNKNOWN]` — needs a live key |
| End-to-end latency (median of 3) | not run | | `[UNKNOWN]` — needs a live provider key; will not spend the owner's credit without instruction |
| External APIs per request | varies by tool choice | | `[UNKNOWN]` — depends on the model's tool calls |
