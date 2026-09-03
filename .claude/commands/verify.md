---
description: Run the full Definition of Done gate from CLAUDE.md §5 and report honestly.
allowed-tools: Bash, PowerShell, Read, Grep, Glob
---

Run the quality gate. **Run the commands — do not predict their output.**

```
npm run gate
```

That is lint, the hook suite, the agent eval, type-check, then the 31 suites —
in that order, cheapest failure first — and it stamps the evidence ledger only
if every one of them passes. It takes a few minutes. Let it finish.

If you would rather run them by hand, the same set is:

```
npm run lint
npm run test:hooks
npm run eval
npm run typecheck
npm test
```

`npm run check` runs those five plus `test:sandbox`.

**Type-checking is not optional here.** It used to be missing from both this
command and `npm run gate`, and a tree with seven type errors that CI rejected
was stamped green locally. It is a ratchet against `.typecheck-baseline.json`:
it fails only when the count goes *up*, so there is never a reason to skip it.

Two suites are not in `npm test` and are worth knowing about:

- `npm run test:ui` — drives the real app in a real browser via Playwright. It
  skips itself when there is no browser to drive, so a "pass" here can mean
  "did not run". Check which.
- `npm run test:capabilities` and `npm run test:sandbox` — not in the default
  run either. Run them if you touched capability gating or the sandbox.

Then walk CLAUDE.md §5 item by item and report against **what actually ran**:

- [ ] lint clean
- [ ] type-check within baseline — say the number, and say if the baseline moved
- [ ] all suites pass — say how many, and name any that were skipped
- [ ] diff read line by line: no dead code, no debug `console.log`, no unused vars
- [ ] no secret or API key added to tracked files (`.env` is gitignored; `.env.example` must stay valueless)
- [ ] security implications of this specific change considered (§6)
- [ ] performance implications if it touched a hot path (§7)
- [ ] new UI is responsive and keyboard-reachable
- [ ] docs/README/comments updated if public behaviour changed

Per CLAUDE.md §10: do not claim "100% no bugs". State which gates ran, what they
said, and what remains unverified. If a box does not apply, say why rather than
quietly skipping it.
