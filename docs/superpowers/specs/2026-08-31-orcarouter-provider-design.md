# Provider OrcaRouter

Ngày: 2026-08-31

Việc đầu trong ba việc: thêm OrcaRouter, rồi chế độ auto chọn model, rồi tầng
research+debate (B). Mỗi việc một chu kỳ spec→build→test riêng.

## Vì sao nhỏ

OrcaRouter (`https://api.orcarouter.ai/v1`) là một aggregator OpenAI-compatible
giống hệt OpenRouter về hình dạng: một key, hàng trăm model gồm cả model miễn
phí, và một endpoint `/models` công khai trả `{ data: [...] }`. Nên nó đi theo
đúng đường `openrouter` đã có, không phát minh gì mới.

Tra `/models` thật trước khi viết: shape gần như trùng OpenRouter. Khác biệt duy
nhất đáng kể là `max_completion_tokens` nằm ở top-level thay vì trong
`top_provider`. Field vision (`architecture.input_modalities`), giá
(`pricing.prompt`/`completion`) và context (`context_length`) đều trùng.

## Thay đổi

| Chỗ | Việc |
|---|---|
| `settings.js` | `ENV_KEYS.orcarouter = 'ORCAROUTER_API_KEY'` |
| `providers/catalog.js` | `PROVIDERS.orcarouter` — nhãn, gợi ý key `sk-orca-…`, URL console |
| `providers/index.js` | `ORCAROUTER_BASE` + `case 'orcarouter'` → `streamOpenAICompatible` với baseURL + headers attribution (đổi tên `openrouterHeaders`→`routerHeaders` vì giờ hai nơi dùng) |
| `models.js` | `normalise(entry, provider)` tham số hoá; `maxOutputOf` đọc thêm top-level `max_completion_tokens`; `CATALOGUE_SOURCES` gồm hai nguồn; `refreshLibrary` fetch cả hai độc lập rồi upsert union |
| `.env.example` | `ORCAROUTER_API_KEY` |

## Hai quyết định đáng ghi

**Gộp hai nguồn, không thay thế.** `upsertModels` là UPSERT theo id, và id mang
prefix provider (`orcarouter/…` vs `openrouter/…`), nên hai nguồn không đụng
nhau. `refreshLibrary` fetch cả hai bằng `Promise.allSettled` — một nguồn chết
không kéo nguồn kia; chỉ khi *mọi* nguồn chết mới ném lỗi, để `refreshIfStale`
giữ thư viện cũ thay vì đóng dấu "vừa refresh" lên một thư viện rỗng.

**Không đụng resolve/picker/dispatch.** `resolve(id)` tra theo id đầy đủ và
`resolveModel` dùng `sharedRow.provider`, nên model OrcaRouter tự động chọn được,
hiển thị được, và dispatch đúng case — vì id đã mang provider. Fallback đa key
cũng tự động vì OrcaRouter dùng chung `streamCompletion`.

## Kiểm thử

`test/orcarouter.test.mjs`: `normalise` đọc đúng shape OrcaRouter (free, vision,
max-output top-level, context), giá quy về USD/triệu, **và** shape OpenRouter cũ
vẫn normalise đúng (regression cho `top_provider.max_completion_tokens`); provider
đã nối vào `PROVIDERS`.

## Ngoài phạm vi

`addModelById` (paste id thủ công) giữ nguyên OpenRouter-only — model OrcaRouter
đến qua refresh tự động, không cần paste tay. Mở rộng sau nếu cần.
