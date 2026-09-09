# CLAUDE ASSETS — the `.claude/` toolkit, read rather than assumed

The explorer assigned to this failed on a session rate limit, so this pass was done by the lead
auditor directly. Hooks, `settings.json`, all 12 command frontmatters, all 9 agent frontmatters and
all 3 skill frontmatters were read. **`verify.md` was read in full**; the remaining commands were
read at frontmatter level plus targeted greps. Agent and skill bodies were **not** read in full —
`[UNKNOWN]` where that matters.

---

## 1. Hooks — the only rules a model cannot argue with

| File | Ln | What it actually does | Trigger | Verdict |
|---|---|---|---|---|
| `gate.js` | 265 | The evidence ledger. Only a process that itself ran the suites and read their exit codes may write a green stamp. Stamp records HEAD + a hash of the dirty set, so a commit or an edit invalidates it with no bookkeeping. | CLI + imported by hooks | Works — **but the wrong scope. CFG-001.** |
| `verify-stop.js` | 149 | Blocks a completion claim (English + Vietnamese patterns, with negation handling) when the gate does not cover what is on disk. Says so as context when there is no claim. | Stop, SubagentStop | Works; inherits CFG-001 |
| `guard-bash.js` | 200 | Blocks commits on `main`, force-push, push to a protected branch, registry publishing, and `reset --hard`. | PreToolUse Bash/PowerShell | Works — **matches literal text. CFG-002.** |
| `guard-write.js` | 81 | Guards Edit/Write targets. | PreToolUse Edit/Write | `[UNKNOWN]` — not read |
| `brief.js` | 120 | SessionStart/PostCompact briefing: branch, dirty count, gate state. | SessionStart, PostCompact | Works — but see §4 |
| `journal.js` | 183 | Writes a run journal before the window is compacted. | PreCompact | `[UNKNOWN]` — not read |
| `ledger.js` | 29 | Notes an edited file as changed-but-unproven. | PostToolUse Edit/Write | Read via `gate.js note` |
| `lint-changed.js` | 63 | Lints the file just edited. | PostToolUse Edit/Write | `[UNKNOWN]` — not read |
| `recover.js` | 71 | Runs after a failed tool call. | PostToolUseFailure | `[UNKNOWN]` — not read |
| `io.js` | 76 | Shared payload/block/pass helpers. | library | Read indirectly |

**Does any hook run git commit or push by itself?** **No.** Checked every `spawnSync` in
`.claude/hooks/`: `brief.js:28` and `gate.js:96` run read-only git (`rev-parse`, `status`);
`guard-bash.js:30` runs `rev-parse`; `gate.js:213` spawns npm. Nothing writes to git. The prompt-level
git rules are therefore not being quietly undermined — good.

**`settings.json` permissions.** The allowlist is conservative and read-mostly: `git status/diff/log/show`,
`git add`, `git commit`, `git checkout -b`, `git switch`, `git branch`, `git stash`, plus the test and
lint targets. **No `git push`, no `git merge`, no `git reset`.** Deny list covers `./.env`,
`./worker/.env` and `./data/pgdata/**`. `settings.local.json` exists, is gitignored, and only adds two
`node -e` forms. This is well done.

---

## 2. Commands — overlap and drift

All 12 exist and none references a missing npm target (the two apparent misses in my scan were grep
artefacts of the `test:*` wildcard, confirmed by hand).

**Genuine overlap:**

| Pair | Overlap | Verdict |
|---|---|---|
| `/verify` ↔ `npm run gate` ↔ `npm run check` | All three claim to be "the gate" and **all three are different sets** | Real conflict — see §3 |
| `/audit-security` ↔ agent `security-auditor` | Same brief, same threat model | Duplication, but defensible: one is user-invoked, one is dispatchable |
| `/audit-performance` ↔ agent `performance-optimizer` | Same | Same |
| `/gen-docs` ↔ agent `technical-writer` | Same | Same |
| `/eval` ↔ `npm run eval` | The command is a thin wrapper with judgement attached | Fine |

**No dead commands found.** Each of the 12 has a distinct job.

**Documentation drift — measured:**

- **Five places say the suite is "24 suites". It is 31.** `verify.md:14`, `brief.js:66`,
  `verify-stop.js:123`, `verify-stop.js:136`, `README.md:65`. Counted from `package.json`:
  `p.scripts.test.split('&&').length` → **31**.
- **`verify.md:15` says `npm run check` "does all three in one go".** It does **six**: lint,
  typecheck, test, eval, test:sandbox, test:hooks.
- **`verify.md` is titled "the full Definition of Done gate from CLAUDE.md §5" and omits
  type-checking entirely** — neither in its command block nor in its checklist. CLAUDE.md §5 lists
  "Lint & type-check sạch" as a required item. The command that exists to enforce §5 does not check
  the §5 item that is currently red.

---

## 3. The central conflict: three gates, three different scopes

| Name | Runs | Includes typecheck? |
|---|---|---|
| `npm run gate` (`gate.js:196-206`) — **the only thing that stamps "verified"** | lint, test, test:hooks | **No** |
| `/verify` (`verify.md:9-12`) — **the command named after §5** | lint, test, test:hooks | **No** |
| `npm run check` (`package.json:19`) | lint, **typecheck**, test, eval, test:sandbox, test:hooks | Yes |
| CI (`ci.yml:28-77`) | lint, **typecheck**, eval, test, test:hooks, test:ui, test:sandbox | Yes |

Two of the four omit the check that is failing right now. The stamp that the Stop hook enforces is
written by the weakest of them. **This is CFG-001 and it is the most consequential `.claude/`
finding**: the machinery is excellent and it is measuring the wrong thing.

The fix is one line — add `['run','typecheck']` to `STEPS.full` in `gate.js` — plus updating
`verify.md`. I have not made it: Phase 0 forbids code changes.

---

## 4. Scoring the six laws the audit brief asks for

| Law | State | Evidence | Where it should live |
|---|---|---|---|
| **L1 Verification contract** (pinned commands) | **CÓ MỘT PHẦN** | `verify.md` names commands but the set is wrong and incomplete; nothing pins Node version or entrypoint | `.claude/commands/verify.md` |
| **L2 Evidence rule** (FACT / INFER / UNKNOWN) | **CÓ MỘT PHẦN** | The spirit is everywhere — `verify.md:7` "Run the commands — do not predict their output", CLAUDE.md §10 — but there is no explicit three-label vocabulary | CLAUDE.md §9, or a new skill |
| **L3 Baseline before change** | **THIẾU** | `.typecheck-baseline.json` is a ratchet, and `.c8rc.json` records a coverage baseline — but nothing requires measuring before a change. No latency, token or cost baseline exists. | `.claude/commands/verify.md` or a new `/baseline` |
| **L4 Persisted ledger** | **ĐÃ CÓ, for the gate only** | `gate.js` + `.claude/state/gate.json` persist *verification* state and are gitignored so a green stamp means "ran here". There is no persisted **issue** ledger — which is why `audit/ISSUE_LEDGER.md` had to be created. | `audit/` (now exists) |
| **L5 Phase separation and stop points** | **ĐÃ CÓ** | `verify-stop.js` is exactly this, and it is well built: it blocks only when *both* something is unproven and a completion claim was made. | `.claude/hooks/verify-stop.js` |
| **L6 Git fence and forbidden zones** | **ĐÃ CÓ** | `guard-bash.js` blocks commit-on-main, force-push, protected-branch push; `settings.json` denies `.env` and `data/pgdata`; no push/merge/reset in the allowlist. Weakness is the matching method (CFG-002), not the coverage. | `.claude/hooks/guard-bash.js`, `settings.json` |

**Consolidation principle honoured:** nothing here needs a new parallel command set. The two real
gaps — L3 and the L1 scope error — are both fixed by editing files that already exist.

---

## 5. Agents and skills

Nine agents, all with `description` fields written as *when to invoke*, which is the form that
actually works. Model assignment is deliberate: `opus` for the seven that reason about design or
risk, `sonnet` for `qa-tester` and `technical-writer`. Three skills cover accessibility, API
conventions and token budget — and each maps onto a real finding class in this audit
(ACC-002…005, the route conventions, PERF-002), which suggests they were written from experience
rather than from a template.

`[UNKNOWN]`: agent and skill **bodies** were not read in full, so I cannot say whether their
content has drifted from the code the way `verify.md` has. Worth one pass in Phase 1 —
particularly `accessibility-checklist`, given that this audit found 13 unlabelled inputs and a
keyboard trap in a codebase that ships an accessibility skill.

---

## 6. New ledger rows from this pass

| ID | Mức | Mô tả |
|---|---|---|
| CFG-004 | MEDIUM | `/verify` claims to be the CLAUDE.md §5 gate but omits type-checking from both its command block and its checklist, and misdescribes `npm run check` as running "all three" when it runs six. |
| CFG-005 | LOW | Five places state the suite is "24 suites"; it is 31. `verify.md:14`, `brief.js:66`, `verify-stop.js:123`, `verify-stop.js:136`, `README.md:65`. |

---

# 7. Re-read, 2026-09-09 — closing the `[UNKNOWN]` in §5

§5 above left agent and skill **bodies** unread. All 12 commands, all 9 agents and
all 3 skills have now been read in full, plus `claude.md`, `docs/` and `README.md`'s
architecture map. The question §5 asked — *has their content drifted from the code
the way `verify.md` had?* — has an answer: **yes, in four of them.**

## 7.1 What the bodies turned out to say

| File | Verdict |
|---|---|
| `commands/verify.md` | **Corrected since §2 was written.** Now names 31 suites, includes typecheck, describes the real five-step gate, and opens with the before-number rule from CFG-006. It is the best of the twelve. |
| `commands/ship.md` | **Drifted.** ":65 — lint, twenty-four suites, and the hook tests". Five steps, 31 suites. CFG-005 missed it because the number is spelled in words → `CFG-015`. |
| `commands/migrate.md` | **Drifted.** ":12 — `SCHEMA_VERSION` (currently 12)". It is 17 → `CODE-012`. Otherwise the strongest command in the set: the idempotency rules and the "replayed in full against databases with data" framing are exactly right. |
| `commands/audit-tokens.md`, `new-tool.md` | **Drifted, mildly.** Both call the catalogue "~7000 tokens" → `CODE-015`. |
| `commands/audit-security.md` | Sound. Its threat model — a model holding a shell, a browser and a real mouse — matches what the code does, and its five sections map onto findings this audit actually produced. |
| `commands/audit-performance.md`, `deploy-check.md`, `eval.md`, `gen-docs.md`, `new-provider.md`, `trace.md` | Sound. `deploy-check.md`'s Vercel schema traps and `trace.md`'s "what is deliberately not logged" are both load-bearing and correct. |
| `skills/api-conventions` | **Drifted.** "Every route lives in `server/app.js`" — false since ARCH-004 → `CODE-013`. The drift is in the `description:` too, which is what the harness matches on, so the failure is silent. |
| `skills/token-budget` | Mildly stale (`CODE-015`) but conceptually the most valuable file in `.claude/`: the per-step vs per-turn distinction is the thing everything else gets wrong. |
| `skills/accessibility-checklist` | Sound, and §5's suspicion was unfounded — the checklist names every failure class this audit found (ACC-002…005, UX-001). It was not wrong; it was not run. |
| All 9 agents | Sound. No drift found. Each is written as *when to invoke*, each carries this repo's real constraints (no framework in `public/`, no test framework in `test/`, one round trip per statement in `store/`), and none contradicts CLAUDE.md or the audit rules. |

**Still no dead command and no dead agent.** The consolidation principle from §4
continues to hold: every gap found this pass is fixed by editing a file that
already exists.

## 7.2 The six laws, re-scored

| Law | 2026-09-03 | 2026-09-09 | What changed |
|---|---|---|---|
| **L1 Verification contract** | CÓ MỘT PHẦN | **ĐÃ CÓ, with one hole** | `verify.md` now pins the right five commands and the 31 suites. Still nothing pins the Node version or entrypoint, and `ship.md` states a different, wrong set → `CFG-015` |
| **L2 Evidence rule** | CÓ MỘT PHẦN | **CÓ MỘT PHẦN** — unchanged | The spirit is enforced (`verify-stop.js` blocks an unproven completion claim; `verify.md:7`), but no file defines the `[FACT]/[INFER]/[UNKNOWN]` vocabulary. It lives only in the audit prompt → `CFG-014` |
| **L3 Baseline before change** | THIẾU | **ĐÃ CÓ** | CFG-006 landed at `4385ef4`: `verify.md` now requires a before-number, absolute figures in the commit, or an explicit "not measured" |
| **L4 Persisted ledger** | ĐÃ CÓ (gate only) | **ĐÃ CÓ** | `audit/ISSUE_LEDGER.md` exists, is tracked, and now carries 78 rows across four rounds |
| **L5 Phase separation and stop points** | ĐÃ CÓ | **ĐÃ CÓ** | `verify-stop.js`, 128 hook checks green |
| **L6 Git fence and forbidden zones** | ĐÃ CÓ | **MÂU THUẪN** | CFG-010 added an owner's switch and it is **currently on**, lifting commit/merge/push on `main` — while `brief.js:53` still tells every session the fence is up. The fence is real, the reporting of it is not → `CFG-012` |

L3 closed and L6 opened. That is the honest summary of the six months of
`.claude/` work between the two scorings: the measurement discipline was fixed,
and the enforcement layer grew a switch whose state nothing reports.

## 7.3 The one thing missing from `.claude/` entirely

`.claude/AUDIT_RULES.md` does not exist, though PHẦN I §6 of the audit rules ranks
that path **above `CLAUDE.md`** in precedence. The constitution governing this
audit lives only in a chat message, and the rules mandate `/clear` between phases.
→ `CFG-014`.
| CFG-006 | LOW | No baseline discipline (L3): nothing requires measuring before changing, and no latency/token/cost baseline exists in the repo. |
