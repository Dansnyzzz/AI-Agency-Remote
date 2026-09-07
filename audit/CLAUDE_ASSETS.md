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
| CFG-006 | LOW | No baseline discipline (L3): nothing requires measuring before changing, and no latency/token/cost baseline exists in the repo. |
