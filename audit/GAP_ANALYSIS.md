# GAP ANALYSIS — Phase 1

Scored 2026-09-10 against `main` + `audit/server-worker-2026-09-09`, HEAD `21236f4`.
Gate green (full) at `4f1cd89`; every change since is markdown.

Each row is `ĐẠT` / `CHƯA ĐẠT` / `N/A` / `[UNKNOWN]`. Every `CHƯA ĐẠT` carries three
things, as the rules require: evidence at `file:line`, what top-tier would concretely
look like, and a ledger ID. Nothing says "cần cải thiện hơn".

---

## A. Độ chính xác & nghiên cứu (`ACC-`)

| # | Mục | Chấm | Bằng chứng | Top-tier trông như thế nào | ID |
|---|---|---|---|---|---|
| A1 | Kết luận quan trọng trích dẫn nguồn cụ thể kèm URL/ID | **ĐẠT** | `research/report.js` enforces markers; every claim carries `S#` ids resolved to URLs | — | — |
| A2 | Đối chiếu chéo ≥2 nguồn | **ĐẠT** | `confidence.js:66-69` — HIGH requires two independent registrable domains **that were opened** | — | — |
| A3 | Nhãn độ tin cậy | **ĐẠT** | HIGH/MEDIUM/LOW from `grade()`, CONFLICTING from the debate | — | — |
| A4 | Dữ liệu real-time lấy qua tool lúc chạy | **ĐẠT** | `gather.js` runs the live four-engine chain per query | — | — |
| A5 | Phản biện nội bộ trước khi chốt | **ĐẠT** *(deep_research only)* | `debate.js` proposer→critic→arbiter | — | — |
| A6 | Phát hiện nguồn mâu thuẫn | **ĐẠT, có điều kiện** | `confidence.js:11-13` states plainly that the grader only counts; CONFLICTING is the arbiter model's judgement, carried through honestly rather than computed | Code-level disagreement detection (claim-level clustering across sources) rather than a model self-report | — (documented limitation, not a defect) |
| A7 | Thang uy tín phù hợp thị trường phục vụ | **CHƯA ĐẠT** | `gather.js:4-7` — `REPUTABLE` is 12 Anglophone outlets, hardcoded; `confidence.js:71` | Source standing configurable per account, so a Vietnamese-market agency can register domestic outlets. VnExpress + Tuổi Trẻ + Thanh Niên, all fetched, should be able to reach HIGH | `ACC-006` |
| A8 | Model không trả lời khi thiếu ngữ cảnh | **CHƯA ĐẠT — nghiêm trọng** | `compact.js:141-165` + `agent.js:796` — after auto-compaction the provider receives the summary and **nothing else**; reproduced by execution | The turn that triggers compaction answers the question that was asked. Summary placed *before* the tail it does not cover | **`ACC-007`** |

## B. Tự động hóa & tool-use (`AUTO-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| B1 | Mỗi tool có timeout, retry có backoff, lỗi tường minh | **ĐẠT** | 30 `fetch` sites, **0** without an abort signal; `execute.js` `DEFAULT_LOCAL_TIMEOUT_MS` + `GRACE_MS`; `classify()` at `providers/index.js:154-174` separates retryable from fatal | — | — |
| B2 | Tool trả structured output, không parse text tự do | **N/A trên đường ra** | Tool results are prose by design — the model is the consumer | — | — |
| B3 | Validate schema đầu ra tool trước khi dùng | **CHƯA ĐẠT** | `openaiCompatible.js:192-199` — a failed argument parse becomes `{__unparsed}`; `grep -rn "__unparsed"` → **1 hit, the write**. `execute.js:172-185` checks the tool *name*, never the input shape | `strict: true` on the OpenAI-compatible tool definitions as `anthropic.js:141-150` already does, and a refusal — not a default-argument run — when arguments do not parse | **`AUTO-005`** |
| B4 | Tác vụ độc lập chạy song song | **ĐẠT** | `util/parallel.js:23`, `MAX_PARALLEL_TOOLS = 4` | — | — |
| B5 | Không còn bước thủ công lẽ ra tự động hóa được | **ĐẠT** | scheduler, workflows, cron, worker job queue | — | — |
| B6 | Có trigger/lịch cho việc lặp lại | **ĐẠT** | `scheduler.js` + `/api/cron/*`, DST-correct | — | — |
| B7 | Job chạy lại idempotent | **CHƯA ĐẠT** | `agent.js:698-735` — resume re-executes outstanding tool calls with no idempotency key; `workflows.js:200-222` and `claimDueTask` both refuse to, on the same kind of path | An idempotency key per tool call, stored with the call, checked before re-execution — so a resumed turn cannot send the same email twice | `AUTO-007` |
| B8 | Trạng thái chạy phản ánh kết quả thật | **CHƯA ĐẠT** | `scheduler.js:178` — `status` starts `'ok'` and only an error event or a throw moves it, so `max_steps` and every non-complete `stop.kind` store `last_status='ok'` | The stored status carries the same vocabulary `providers/stop.js` already produces, so a truncated unattended run is visibly truncated | `AUTO-006` |
| B9 | Huỷ tool thực sự huỷ | **CHƯA ĐẠT** | `execute.js:65-68` — the job is force-completed "Cancelled by the user" while the worker may still be running it | Cancellation propagates to the worker; the model is told what actually happened | `CODE-017` |

## C. Kiến trúc & mở rộng (`ARCH-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| C1 | Thêm agent/tool/khách hàng mới không phải sửa lõi | **ĐẠT** | `new-tool.md` names four fixed edit points; `CLOUD_IMPLEMENTATIONS` / `worker/tools.js` maps | — | — |
| C2 | Cấu hình theo khách hàng tách khỏi logic | **CHƯA ĐẠT** | `gather.js:4-7` — the reputable-domain list is a business rule with no per-account override, no store column, no config | Source standing, tone and house rules configurable per account | `ACC-006` |
| C3 | Không magic number lẽ ra là config | **ĐẠT** | `settings.js`, `LIMITS` exports, named constants throughout | — | — |
| C4 | Provider LLM được trừu tượng hoá | **ĐẠT** | `providers/index.js` `streamOne` switch; five providers, three adapters | — | — |
| C5 | Ranh giới module rõ, không phụ thuộc vòng | **CHƯA ĐẠT** | 3 cycles over 76 modules — `execute→cloud→subagents→execute`, and `agent→execute→cloud→{scheduler,workflows}→agent` | No cycles. Failing that, an explicit test asserting no member evaluates an imported binding at module top level — the property that currently keeps them harmless and that nothing checks | `ARCH-008` |
| C6 | Một bản cài store, không trôi lệch | **ĐẠT** | `pglite.js:4`, `:203-208` — thin driver adapter into `createPgStore`, overrides nothing | — | — |
| C7 | Ghi transcript an toàn khi ghi đồng thời | **CHƯA ĐẠT** | `schema.sql:178` is a plain index; `pg.js:1011` computes `MAX(seq)+1` | Unique `(chat_id, seq)`, reached by backfill-then-constrain — **not** a blind index add | `ARCH-007` |

## D. Hiệu năng & chi phí (`PERF-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| D1 | Cache cho dữ liệu lặp, có TTL và invalidate | **ĐẠT** | RAG query cache (5 min, bounded at 64); project shelf re-rank 70.7ms → 0.6ms with pinned invalidation | — | — |
| D2 | Không gọi LLM cho việc không cần LLM | **ĐẠT** | `roleModel.js` moves compaction/extract/plan to the cheap tier; `calc`, parsers and rankers are code | — | — |
| D3 | Trần ngân sách token / số lời gọi mỗi request | **CHƯA ĐẠT** | `settings.js:11` `maxSteps: 30` is a **count**; grep finds no token or cost bound per request. Distinct from `PERF-003` (monthly quota, closed) | A per-turn token and cost ceiling, enforced between steps, surfaced to the user when hit | `PERF-009` |
| D4 | Streaming khi UX cần | **ĐẠT** | SSE token-by-token from all three adapters | — | — |
| D5 | Chọn model theo độ khó tác vụ | **ĐẠT** | `roleModel.js`, `autoPick.js` | — | — |
| D6 | Output budget đúng cửa sổ của model | **CHƯA ĐẠT** | `providers/index.js:66-71` returns a flat **32,000 unclamped** when an entry has neither `maxOutput` nor `context` — the aggregator path, i.e. OpenRouter/OrcaRouter | The clamp applies on every path; a sparse entry gets a conservative budget, not the largest one | `PERF-010` |
| D7 | Không N+1 trên driver một-round-trip-mỗi-câu | **CHƯA ĐẠT** | `rag.js:239` — `for (…) await store.replaceDocChunks(…)`, one round trip per file. The store method itself is bulk | One call for the whole batch. 40 files should cost one round trip, not 40 | `PERF-012` |
| D8 | Độ trễ end-to-end hợp lý | **[UNKNOWN]** | Never measured — needs a live provider key, and spending the owner's credit was not authorised | — | — |

## E. Bảo mật (`SEC-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| E1 | Không secret trong code/client/lịch sử git | **ĐẠT** | No `.env*` tracked or ever committed; 0 hardcoded key patterns; the two historical `.fuse_hidden` files read and found benign | — | — |
| E2 | Không secret trong log | **CHƯA ĐẠT** | `util/trace.js:102-107` emits `errMsg: error.message` unredacted; **10** `log.error` call sites, several unpacking provider errors. `readableFailure` redacts the same string on the way to the browser | `redactSecrets` on the log path too — one choke point, as the response path already has | `SEC-018` |
| E3 | Input validate trước khi vào tool/exec | **CHƯA ĐẠT** | `execute.js:172-185` validates the tool name only — see B3 | — | `AUTO-005` |
| E4 | Chống prompt injection từ nội dung web | **CHƯA ĐẠT — nghiêm trọng** | `untrusted()` has **5** call sites; the local/worker branch of `executeTool` wraps nothing, so `browser_look` delivers a page as trusted text while `web_fetch` on the same URL is enveloped. GitHub/Notion likewise | Every path carrying content the model did not author is enveloped, without exception, and the envelope is applied at the choke point rather than per-tool | `SEC-015`, `SEC-019` |
| E5 | Rate limit + giới hạn quyền cho lời gọi ra ngoài | **ĐẠT, có ghi chú** | `ratelimit.js` on auth routes, DB-backed, `trust proxy` at one hop. It fails open by design and logs nothing when it does | A log line when the limiter is bypassed, so the window is visible afterwards | `SEC-020` |
| E6 | Endpoint có auth đúng mức | **ĐẠT** | Routes re-read this round; `/api/pair/poll` is deliberately unauthenticated and safe (UUID-keyed, one-time, TTL, rate-limited) | — | — |
| E7 | SSRF — mọi fetch model nhắm được đi qua `safeFetch` | **CHƯA ĐẠT** | `mcp/client.js:357` calls `assertPublic` and **discards the records it returns**; `:247` then uses bare `fetch`. `safeFetch.js:96-108` documents this exact TOCTOU as the reason pinning exists | Every outbound hop pinned to the address that was checked, MCP included | `SEC-016` |
| E8 | Không tool phá hoại nào bị chấm `ordinary` | **CHƯA ĐẠT** | `definitions.js:1892-1895` — the shell regex omits `python`, `node`, `perl`, `ruby`, `mshta`, `wscript`, `cscript`, and misses `zsh` | Grade by *what the target can do*, not by a name list; unknown executables default to sensitive | `SEC-017` |
| E9 | Repo public — không prompt/khoá trong `public/` | **ĐẠT** | Re-checked: no system prompt reaches the client (`EXP-001` downgraded on evidence) | — | — |
| E10 | Repo public — không file `TUYỆT ĐỐI KHÔNG` bị track | **ĐẠT** | `data/` never committed; no customer data tracked | — | — |
| E11 | Ranh giới chứa đường dẫn | **ĐẠT** | `worker/paths.js:84-110` — `path.relative` not `startsWith`; realpath of the deepest existing ancestor; absolute/UNC/drive-relative all refused. `set_workspace` moves the boundary but is `ALWAYS_SENSITIVE` | — | — |
| E12 | Tenancy | **ĐẠT** | Store scoped by `user_id` throughout; `screenHub` rooms keyed per account; `localTools` sinks owner-bound; `deviceHint` matched against the account's own machines | — | — |

## F. Chất lượng code & vận hành (`CODE-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| F1 | Có test cho logic lõi | **ĐẠT, có lỗ** | 31 suites, 142 hook checks, 13 eval cases. But `activeTranscript` — the function `ACC-007` lives in — is covered by **nothing** | A failing test for `ACC-007` written before the fix | `ACC-007` |
| F2 | Log đủ để debug, có trace id | **ĐẠT** | `util/trace.js` AsyncLocalStorage; every line in a turn carries the request id | — | — |
| F3 | Không trùng lặp logic lớn | **ĐẠT** | `CODE-007` rollup closed; `branch.js` now holds the one definition of the git fence | — | — |
| F4 | Tài liệu khớp code | **CHƯA ĐẠT** | `migrate.md:12` says schema 12, it is 17; `ship.md:65` says "twenty-four suites", it is 31 across 5 steps; `api-conventions` says every route is in `app.js`, six groups moved to `routes/`; `README.md:1598` says four providers, there are five | Every stated number checked against the code, and the spelled form grepped as well as the digits | `CODE-012`, `CFG-015`, `CODE-013`, `CODE-014`, `CODE-015` |
| F5 | Lỗi có phân loại retryable vs fatal | **ĐẠT** | `classify()` at `providers/index.js:154-174` — status before message text, 429 rests the key, 401/402/403 kill it, 5xx/408 retry with backoff | — | — |
| F6 | Không mất công việc đã trả tiền | **CHƯA ĐẠT** | `agent.js:943` persists the assistant message only after the stream ends; Stop or a mid-stream death discards text the user watched arrive, and the next turn re-sends and re-bills | Streamed text persisted incrementally, so a stop keeps what was produced | `CODE-016` |

## G. Trải nghiệm đầu ra (`UX-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| G1 | Output nhất quán, đạt chuẩn giao khách hàng | **ĐẠT** | `skills/builtin.js` carries the document conventions per format, loaded only when they apply | — | — |
| G2 | Tuỳ biến theo khách hàng qua config | **ĐẠT một phần** | User skills, project briefings and `prefs.systemPrompt` exist; source standing does not — see C2 | — | `ACC-006` |
| G3 | Phân tách kết luận chắc chắn vs giả định | **ĐẠT** | Confidence labels on research output; the untrusted envelope marks what the model did not author — where it is applied (see E4) | — | — |
| G4 | Trạng thái tiến trình + lỗi dễ hiểu | **ĐẠT, có lỗ** | SSE `status` phases, `stopNote` for truncation/refusal, approval bar with `aria-live`. But every `toast(err.message)` is server-authored English — the server has no locale | Error codes, or an account-language header, so a Vietnamese user gets Vietnamese failures | carried from the i18n round — still open, no ID assigned yet |
| G5 | Accessibility | **ĐẠT** | `ACC-002…005`, `UX-001…004` all closed: 19 controls named, tablists real, menus focus-managed, keyboard trap gone, contrast raised | — | — |

## H. Tối đa hoá năng lực model (`GAP-`)

| # | Mục | Chấm | Bằng chứng | Top-tier | ID |
|---|---|---|---|---|---|
| H1 | Structured output / tool-calling thay vì parse text | **ĐẠT một phần** | Tool-calling throughout; `anthropic.js:141-150` sets `strict: true`. `openaiCompatible.js:153` does not — see B3 | — | `AUTO-005` |
| H2 | Context nạp đủ và không dư; chiến lược cắt/nén | **CHƯA ĐẠT** | The strategy exists and is well designed — `COMPACT_AT` 0.82, `KEEP_RECENT` 8, chained summaries — and it is **wired up wrongly**: the tail it keeps never reaches the model | The design as written: summary, then the tail | **`ACC-007`** |
| H3 | Model tự kiểm tra trước khi trả kết quả quan trọng | **CHƯA ĐẠT** | `debate.js` does proposer/critic/arbiter for `deep_research` only; the main agent loop has no self-check step at any point | A verification pass before an expensive or irreversible answer, as the research pipeline already demonstrates is worth it | *(no ID — deliberate design space, raised as a creative gap below)* |
| H4 | Prompt tách khỏi code, versioned, A/B được | **CHƯA ĐẠT** | `agent.js:34-330` builds 4,922–14,369 chars from JS literals; `grep PROMPT_VERSION\|prompts/` → 0 hits | Prompts as versioned data with an id recorded on each turn, so two variants can run side by side and the eval can attribute a change | `GAP-003` |
| H5 | Eval bộ case cố định | **ĐẠT một phần** | `test/eval/` 13 cases in the gate, deterministic, no key needed. `eval:live` is implemented and **has never been run** | The live run in a nightly, so prompt edits are measured rather than assumed | `GAP-003` |
| H6 | Chi phí cố định mỗi lượt được quản lý | **ĐẠT** | Deferral cuts a 128k turn from 13,326 to **6,896** est. tokens of catalogue; `firstSentence` trimming below 40k; `cache_control: ephemeral` on the system block | — | — |

---

## Điểm tổng

| Nhóm | ĐẠT | ĐẠT một phần / có ghi chú | CHƯA ĐẠT | [UNKNOWN] |
|---|---|---|---|---|
| A Độ chính xác | 5 | 1 | 2 | 0 |
| B Tool-use | 4 | 0 (1 N/A) | 4 | 0 |
| C Kiến trúc | 4 | 0 | 3 | 0 |
| D Hiệu năng | 4 | 0 | 3 | 1 |
| E Bảo mật | 6 | 1 | 5 | 0 |
| F Chất lượng | 3 | 2 | 2 | 0 |
| G Đầu ra | 3 | 2 | 0 | 0 |
| H Năng lực model | 2 | 2 | 3 | 0 |
| **Tổng** | **31** | **8** | **22** | **1** |

The single `[UNKNOWN]` is end-to-end latency, and it stays that way: it needs a live
provider key, and spending the owner's credit was never authorised. A number invented
here would be worse than none.

## Ba điều đáng chú ý về hình dạng của kết quả này

**Phần lớn cái sai không phải do thiếu hiểu biết — mà là một cơ chế đúng bị nối sai chỗ.**
`ACC-007`: the compaction design is careful and its own doc line states the invariant;
the summary is simply appended where the invariant says it must not be. `SEC-016`:
`assertPublic` was rewritten to return its records *specifically* so callers could pin,
and one caller throws them away. `SEC-015`: the untrusted envelope was extended to
`search_docs` on the stated grounds that it was the only unenveloped path; the whole
worker branch was never wrapped. `PERF-010`: the clamp exists and is skipped.
`CFG-018`: the docs exemption was built and stops at the commit boundary.

**Cái vá rồi mở lại chiếm tỷ lệ cao hơn cái chưa từng vá.** Four of this round's
findings are re-openings of classes this repo has already closed once, at a different
door. That is an argument for fixing at choke points rather than at call sites.

**Bốn trong bốn claim của agent mà tôi kiểm sâu đều lệch.** Two up (`ACC-007` High→Critical,
`SEC-018` 2 sites→10), two down (`CODE-020` and `PERF-011` downgraded to non-defects).
The `Prov` column is not bureaucracy; it is the difference between an audit and a rumour.
