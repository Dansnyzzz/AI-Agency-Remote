---
description: Add a new tool to the agent's catalogue, wired correctly end to end.
argument-hint: [what the tool should do]
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, PowerShell
---

Add a tool to the agent's catalogue. A tool is not one edit — a definition with
no implementation is a model that confidently promises something and then fails,
which is worse than not offering it at all.

## Decide the scope first, because it decides everything else

- **`cloud`** — runs wherever the API runs. Works on Vercel with no user machine
  involved. Implement in `server/tools/cloud.js` → `CLOUD_IMPLEMENTATIONS`.
- **`local`** — runs on the user's own PC through the worker. Implement in
  `worker/tools.js`. Hidden from the model entirely when no worker is online, so
  it can never be offered when it cannot run.
- **`desktop`** — drives the real mouse and keyboard. Gated separately from
  `local` and hidden unless the machine has opted in. Hold a high bar for adding
  to this set.

## The edits

1. **`server/tools/definitions.js`** — add to `TOOLS`. Read the header comment
   first; it defines every field. Get these right:
   - `readOnly: true` **only** if it cannot change anything. This exempts the
     tool from the approval prompt and keeps it alive under `readonly`/`plan`
     policy — a mutating tool marked read-only silently defeats both.
   - `needs` — the connector id, if it depends on a linked service. Without it
     the tool is advertised to accounts that have no Slack and can only fail.
   - `needsProvider` — the provider key it cannot work without.
   - `secondary: true` if it is outside the core loop. This is what gets it
     dropped first on a model whose window is under 16k.
   - `description` — the **first sentence must stand alone**, because on a model
     under 40k that is the only sentence that survives (`firstSentence`).
2. **The implementation**, in the file the scope dictates above.
3. **Risk**, in the same file: `assessRisk` and `riskReason`. A tool that
   deletes, spends money, or reaches off the machine must not be assessed
   `ordinary`.
4. **A test.** Find the suite that owns the area — `test/agent.test.mjs` for the
   loop, `test/isolation.test.mjs` if it touches per-account data, plus the
   area-specific suite.

## Then check the cost

The whole catalogue is re-sent on **every request**. Roughly 7000 tokens today.
On a 128k model that is noise; on `openai/gpt-4` (8191) it is most of the window.
So a description that earns its length on the flagship is charged to every user
on every turn. Say what the tool *is* in one sentence, then stop.

Verify with `npm test`, and confirm the new tool appears in
`availableTools({ context: 8000 })` only if it genuinely belongs there.
