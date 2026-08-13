---
description: Add or update an LLM provider so every model adapts flexibly and cheaply.
argument-hint: [provider name]
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, PowerShell, WebFetch, WebSearch
---

Add or correct a provider in `server/providers/`. **Look the current API up
before writing any of it** — CLAUDE.md §3 exists because a signature that changed
last quarter is the most expensive kind of bug to debug backwards.

## The shape

- `server/providers/index.js` — `streamOne` routes provider → adapter, and
  `streamCompletion` wraps every one of them in key rotation. New providers plug
  into the `switch`.
- `server/providers/openaiCompatible.js` — **try this first.** Anything speaking
  the OpenAI wire format needs only a `baseURL` and headers, which is exactly how
  OpenRouter is supported. A new adapter file is for a genuinely different
  protocol, not a different host.
- `server/providers/catalog.js` — `PROVIDERS` for the label, key hint and console
  URL; `CATALOG` only for first-party models worth pinning.

## The rules that are easy to get wrong

- **Never hard-code `max_tokens: 32000`.** `outputBudget(entry)` in `index.js`
  decides it from the model's own `maxOutput`, clamped inside its context window.
  Forty-five catalogue models cap below 32000, and `openai/gpt-4` has an
  8191-token *total* window — asking it for 32000 output asks for four times
  everything it has.
- **Prefer moving aliases to pinned versions.** `gemini-2.5-flash` was not
  removed, it was restricted, and it kept appearing in `ListModels` while
  answering *"no longer available to new users"* mid-sentence. `-latest` is the
  pointer that survives a rotation.
- **Yield, do not return.** Adapters are async generators emitting
  `{type:'text'|'thinking', delta}`, `{type:'tool_call_start', id, name}`,
  `{type:'notice', text}` and a final `{type:'done', stopReason, toolCalls, usage}`.
  `usage` is what makes cost estimation and the token budget real.
- **Classify failures honestly.** `keyExhausted(err)` decides whether another key
  is worth trying. Only 401/402/403/429 and genuine quota or rate-limit messages
  qualify. A missing model or a malformed request fails identically on all five
  keys, and retrying turns one clear error into five slow ones.
- **A key must not be retried once text has streamed.** Half a sentence followed
  by a second attempt either duplicates or silently replaces what the user has
  already read.

## Verify

`npm test` covers the loop, and `server/providers/index.js` exports `__testing`
with `keyExhausted` and `outputBudget` for exactly this. Confirm a model with a
small window gets a small budget, and that a refused key emits a visible
`notice` — a fallback nobody can see is indistinguishable from the first key
having worked, right up until the bill arrives.
