# RESULT — measured before and after

Every row is a command that was run and an output that was read. Where something
could not be measured it says so; nothing here is interpolated.

Before = `6d10ae4`, the commit this audit started from.
After = `integrate/2026-09-04`, merged with `origin/main`.

---

## The gate

| Thing | Before | After | How measured |
|---|---|---|---|
| `npm run gate` scope | lint, test, test:hooks | lint, hooks, **eval**, **typecheck**, test | `.claude/hooks/gate.js` STEPS.full |
| Gate verdict | **green while typecheck was red** | green, and typecheck is in it | `gate.js status` → `verified:true`; `node scripts/typecheck.js` |
| `test:ui` | **skipped itself — no browser installed** | **runs; exit 0, 0 failures** | `npm run test:ui` |
| `test:sandbox` | skipped itself | runs; exit 0 | `npm run test:sandbox` |
| Suites in `npm test` | 31 (documented as "24" in 5 places) | 31, and the docs no longer name a number | `p.scripts.test.split('&&').length` |

The first row is the one that mattered. A stamp reading `verified: true` over a
tree CI would reject is worse than no stamp, and it is what let seven type errors
sit in a staged working tree unnoticed.

## Type checking

| | Before | After |
|---|---|---|
| Real `tsc` errors | 436 | 397 |
| Recorded ceiling | 429 | **397** |
| Errors above the ceiling | **+7** | 0 |
| `server/app.js` | 11 | **0** |

The ceiling moved **down** 32, never up. Every reduction came from fixing a real
contract — four functions that destructured arguments without saying which were
optional — rather than from re-recording the baseline to swallow a failure.

## Size

| | Before | After |
|---|---|---|
| `server/app.js` | 2,838 lines, ~93 routes in one file | **1,663** |
| `server/routes/` | did not exist | 6 modules, 1,296 lines |
| `public/js/app.js` | 4,787 | **4,154** — split **13.5%**, not fully; see below |
| `public/js/` client modules | 20 | 24 |

The client split is **partial and is reported as partial**. Four self-contained
sections came out — attachments, devices, model news, two-factor: 647 lines. Two
that the finding also named did not: `the gate` (317 lines) and `MCP servers`
(557) each borrow 25 identifiers from module scope and both read and write shared
mutable state, so moving them is a decision about who owns that state, not a cut
and paste. `ARCH-005` records this rather than closing on the easy 13.5%.

## Interface language

| | Before | After |
|---|---|---|
| Hardcoded English strings in `public/js` | **90** by the first scanner | **0** by that same scanner — **the scanner was wrong** |
| Same thing, measured properly | **138 candidates** | **38 — and every one of the 38 is markup, CSS or a string no person sees** |
| Locale keys | 412 | **670** |
| English/Vietnamese key parity | — | 670 = 670, no key in one and missing from the other |
| The sign-in gate | **no `gate.*` keys at all** | fully translated |

Reported as "~200 strings". The first scanner said 90; those 90 were fixed and
the same scanner then said 0, which is how this table came to claim the interface
was fully translated. It is not. Asking the instrument that defined a set whether
the set is empty is not a measurement, and the "0" stood in this file for three
days.

A second scanner — strips tags, CSS and `${}` interpolations from each literal,
then asks whether what is left is prose — finds **138**. Those 138 were worked
through: 100 translated, and the remaining **38 read one by one and classified**
— ~28 class lists, CSS, SVG and CSP markup; 8 `autopreview.js` decision reasons
that a pure function returns and nothing renders; 1 `postMessage` error for an
operation the page cannot send; 1 HTML comment used as a DOM marker. Logged as
**GAP-002** and now closed.

Two real bugs came out of the sweep, neither of which any test caught:
`loadTasks` bound its map parameter to `t`, shadowing the translator across the
entire scheduled-tasks block, and `workflows.js` built two label maps as object
literals at import — the same import-time freeze that `CODE-007` fixed in
`render.js`, sitting in a second file the whole time.

## Measured performance

| | Before | After | How |
|---|---|---|---|
| Project-shelf re-rank, per turn | 70.7 ms | **0.6 ms** | 2.4M-character shelf, 40 files, `process.hrtime.bigint()` around `selectSources` |
| RAG query embedding | one network round trip per search | cached 5 min, keyed by provider+model+text | counting stub in `rag.test.mjs` |

## Measured security

| | Before | After | How |
|---|---|---|---|
| XSS via attachment filename | **live** — rendered span gained an `onmouseover` attribute | inert | Chromium: `getAttributeNames()` before and after |
| `launch_app` metacharacters | **`notepad&ver` ran `ver`** | argv only, no shell | `spawnSync` with `echo` in place of `start` |
| Widget outbound requests | **3 beacons fired per render** (img, SVG image, CSS url) | **0** | Chromium with requests intercepted |
| stdio MCP server | any signed-in account | administrator only | `http.test.mjs`: 403 for a user, 200 for an admin |
| API keys in URLs | 2 (Google embed + probe) | 0 | both files read with comments stripped |

## Schema

| | Before | After |
|---|---|---|
| `SCHEMA_VERSION` | 16 | **17** |
| Indexes on hot predicates | 4 missing | added |
| Pairing code uniqueness | documented as needed, not attempted | partial unique index + backfill |

Verified against a real PGlite database: all five indexes present, version 17
stored, a duplicate unclaimed code refused, a claimed one still accepted.

---

## What is not measured, and why

**End-to-end latency and LLM calls per request.** Needs a live provider key.
Not run — spending the owner's credit was never authorised, and a number
invented here would be worse than none.

**Whether the interface suite covers what it appears to.** It passes, and it now
genuinely runs, but its coverage is not itself measured. Its value was
demonstrated rather than estimated: the first time it could run it caught two
real regressions this audit had introduced and every other check had missed.

**`.c8rc.json` coverage.** Recorded 2026-09-02 at 57.81/74.28/68.59 and not
re-measured; instrumenting every suite roughly doubles a run that is already
minutes long, and nothing in this audit changed which files are exercised.

---

## Corrections to this audit's own findings

Six findings were wrong or overstated, and were corrected against evidence
rather than quietly dropped. They are listed because an audit that only reports
what it got right is not an audit.

| ID | Claimed | Measured |
|---|---|---|
| PERF-002 | 16,900 tokens fixed per turn | **~10,500** — I sized `TOOLS`, not what a turn sends; deferral already cuts a 128k-window turn to 48 tools |
| ARCH-001 | pgvector probe wastes a round trip | probe already checks the column; no waste — an unrealised optimisation, not a defect |
| EXP-001/002 | prompts and catalogue leaked to the browser | **no system prompt reaches the client**; what is there is UI copy and display logic |
| CODE-011 | 2 empty catches, 1 TODO | 1 real; the others were PowerShell inside a template string and a user-facing example prompt |
| CODE-005 | 50 console.log with no logger | 2 on a request path; the rest are CLI banners |
| GAP-001 | ~200 hardcoded strings | 90 |
| GAP-001 (again) | "90 → 0, fully translated" | **~130 were still untranslated.** The 0 came from re-running the scanner that had defined the 90. Logged as GAP-002 |
| ARCH-005 | app.js is 4,677 lines | 4,787 when the work started; now 4,140 — a 13.5% split, not the six-way one the finding described |

## Mistakes made during the work

- A regex-based script cut through `#model-search`'s placeholder because the
  attribute contains a literal `>`. Caught by reading the diff line by line.
- `git checkout --theirs` was used to resolve fourteen merge conflicts, which
  takes whole files and would have discarded 557 lines of other people's work in
  `pg.js` alone. Caught by measuring what the other side had changed; the
  attempt was thrown away and redone hunk by hunk.
- `.typecheck-baseline.json` was tightened to 416 and left out of the commit, so
  the tree advertised 419 while the working copy enforced 416. Caught by
  `git status` after the gate went green.
- Lint results were being read as `npx eslint . | tail -3; echo $?`, which
  reports **tail's** exit status. Every "lint=0" from that pattern was
  meaningless. The gate was never fooled.
