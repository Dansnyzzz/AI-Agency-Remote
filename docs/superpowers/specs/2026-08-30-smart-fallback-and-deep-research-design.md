# Chuyển key thông minh, và tầng nghiên cứu có phản biện

Ngày: 2026-08-30

Hai việc, làm theo thứ tự. **A** sửa một lỗi đang có và tự nó đã đáng làm. **B** xây trên
nền A, và không thể xây trước vì nó gọi model gấp mười lần một lượt chat bình thường.

---

# A. Chuyển key thông minh

## Vấn đề

Key hết hạn mức giữa câu trả lời thì lượt đó hỏng, và người dùng phải gõ "continue" thì hệ
thống mới chịu dùng key thứ hai. Cơ chế xoay key đã có sẵn — nó chỉ không bao giờ chạy đúng
lúc cần nhất.

`server/providers/index.js`:

```js
let streamed = false;
try {
  for await (const event of streamOne(entry, common)) {
    streamed = true;          // bất kỳ event nào, kể cả một delta `thinking`
    yield event;
  }
} catch (err) {
  const last = attempt === keys.length - 1;
  if (streamed || last || !keyExhausted(err)) throw err;
```

Một token bất kỳ đã phát ra là cờ `streamed` bật, và cờ đó tắt hẳn việc xoay key. Gõ
"continue" chữa được vì nó tạo một request mới, ở đó lỗi xảy ra *trước* token đầu tiên.

Lý do đoạn code này tồn tại được ghi ngay trên nó, và nó đúng: khởi động lại giữa câu thì
hoặc lặp lại nửa câu người dùng đã đọc, hoặc âm thầm thay thế nó. Chỗ sai không phải lý do
mà là giả định — rằng chết giữa chừng là hiếm. Với model `:free` của OpenRouter, đó là
chuyện thường ngày, và tài liệu của họ xác nhận lỗi giữa chừng đến dưới dạng SSE
`finish_reason: "error"` *sau* khi đã trả 200 OK. Tức là luôn luôn sau khi cờ đã bật.

## Vấn đề thứ hai, nặng hơn

`keyExhausted()` gộp bốn tình huống khác hẳn nhau vào một:

```js
if ([401, 402, 403, 429].includes(Number(status))) return true;
```

| Mã | Bản chất | Việc đúng cần làm | Code hiện tại |
|---|---|---|---|
| 401 / 403 | Key chết hẳn | Sang key khác ngay | Sang key khác ✅ |
| 402 | Hết tiền | Sang key khác | Sang key khác ✅ |
| 429 theo phút | Tạm thời, tự khỏi sau vài giây | Đợi đúng lúc header bảo | Sang key khác ❌ |
| 429 quota ngày | Hết hạn mức tới nửa đêm | Đợi, hoặc key tài khoản khác | Sang key khác ❌ |
| 500 / 502 / 503 | Nhà cung cấp trục trặc | Backoff rồi thử lại cùng key | Ném lỗi ❌ |

Trong toàn bộ `server/providers/` không có một dòng backoff nào, và hai header
`Retry-After` với `X-RateLimit-Reset` bị vứt đi hoàn toàn. Đó là khác biệt giữa đoán xem
phải chờ bao lâu và đọc con số nhà cung cấp đã nói sẵn.

## Hạn mức thật của OpenRouter

Tra tài liệu chính chủ thay vì đoán:

| Đã nạp | Request/phút | Request/ngày |
|---|---|---|
| < $10 | 20 | 50 |
| ≥ $10 | 20 | 1.000 |

Mốc $10 là vĩnh viễn — nạp một lần thì giữ mức 1.000 mãi, kể cả khi số dư về không.

Hai điều quan trọng hơn con số:

**Request thất bại vẫn bị trừ quota.** Nên retry mù không chỉ vô ích, nó đốt phần còn lại.
Đây là lý do trung tâm cho thiết kế bên dưới.

**Tài liệu OpenRouter nói họ quản dung lượng ở cấp toàn cục**, tức thêm key của cùng tài
khoản không nới được gì. Vài blog bên thứ ba nói ngược lại — rằng hạn mức tính theo từng
key. Xếp theo hạng nguồn thì tin nguồn chính chủ. Hệ quả cho code: **không được giả định
xoay key là luôn có tác dụng.** Ca "mọi key đều đang bị giới hạn" phải được xử lý gọn gàng
chứ không phải rơi vào lỗi.

## Thiết kế

### Phân loại lỗi thay cho một hàm nhị phân

`keyExhausted(error) → boolean` được thay bằng `classify(error) → { kind, retryAfterMs }`:

```
RATE_LIMITED   429
               → đọc Retry-After / X-RateLimit-Reset, ghi key này vào sổ nghỉ
               → thử key tiếp theo KHÔNG nằm trong sổ nghỉ
               → hết key khả dụng thì đợi tới mốc reset gần nhất rồi tiếp

KEY_DEAD       401 · 402 · 403 · "invalid api key" · "out of credit" · "billing"
               → đánh dấu key hỏng trong phiên, sang key kế tiếp ngay
               → không thử lại nó ở các bước sau của cùng lượt

UPSTREAM       500 · 502 · 503 · timeout · đứt kết nối
               → backoff luỹ thừa có jitter, CÙNG key, tối đa 3 lần
               → lỗi của nhà cung cấp, đổi key không giúp gì

FATAL          400 · context quá dài · content filter · model không tồn tại
               → ném ngay, không thử key nào khác
               → hỏng như nhau trên mọi key; thử 5 key chỉ biến một lỗi rõ ràng
                 thành năm lỗi chậm
```

Nhánh `FATAL` giữ nguyên tinh thần comment đang có trong `keyExhausted()`. Nó vốn đã đúng.

### Sổ nghỉ của từng key

`settings.js` hiện chỉ nhớ *key nào vừa chạy được* qua biến `cursor`. Thêm một sổ nữa:

```
cooldown: Map<"userId:provider:index", resetAtMs>
```

`getApiKeys()` lọc bỏ những key còn trong sổ nghỉ, và trả kèm mốc reset gần nhất để nơi gọi
biết phải đợi bao lâu nếu chẳng còn key nào.

Vì sao đáng làm: request thất bại vẫn bị trừ quota, nên thăm dò lại một key mà hệ thống đã
biết là đang bị giới hạn là tự đốt hạn mức để xác nhận điều đã biết. Với năm key thì mỗi
lượt mất năm request vào việc không cần thiết.

Sổ nằm trong bộ nhớ tiến trình, giống `cursor`. Trên Vercel mỗi instance có sổ riêng và sổ
mất khi instance ngủ — chấp nhận được: hỏng theo hướng an toàn, cùng lắm là thăm dò lại một
lần rồi ghi lại.

### Đã phát ra cái gì, chứ không phải đã phát ra hay chưa

Cờ `streamed` nhị phân được thay bằng đếm theo loại:

```js
const emitted = { text: 0, thinking: 0, toolCalls: 0 };
```

| Đã phát | Xử lý | Người dùng thấy |
|---|---|---|
| Chưa gì cả | Khởi động lại sạch trên key khác | Không thấy gì (đã đúng sẵn) |
| Chỉ `thinking` | Khởi động lại sạch | Phần suy nghĩ chạy lại, vô hại |
| Chỉ `tool_call_start` | Huỷ tool call dở, chạy lại | Bước công cụ khởi động lại |
| Đã có `text` | Xem mục dưới | Có `notice` nói rõ đã đổi key |

Ba dòng đầu là phần lớn các ca, và chúng an toàn tuyệt đối vì người dùng chưa đọc gì cả.
Riêng chúng đã xoá phần lớn nhu cầu gõ "continue".

### Khi text đã chảy ra rồi

Cách hiển nhiên là nối tiếp bằng **assistant prefill**: đưa phần text đã phát vào làm message
cuối của assistant rồi bảo model viết tiếp. **Cách đó không dùng được**, và đã kiểm chứng
trước khi viết code chứ không phát hiện lúc chạy.

Anthropic đã bỏ prefill trên toàn bộ dòng model từ 4.6 trở đi: Fable 5, Opus 5, Sonnet 5,
Opus 4.6 / 4.7 / 4.8, Sonnet 4.6 — gửi prefill là nhận **HTTP 400**. Bảng model trong
`server/providers/catalog.js` gồm đúng `claude-opus-5`, `claude-sonnet-5` và
`claude-opus-4-8`, tức cả ba model Anthropic chính của sản phẩm đều nằm trong danh sách đó.
Chỉ `claude-haiku-4-5` là còn nhận prefill — không đáng để nuôi một đường code riêng.

Phía OpenAI-compatible và OpenRouter thì prefill tuỳ nhà cung cấp phía sau, có nơi bỏ qua và
viết lại từ đầu, gây lặp. Cũng không đảm bảo được.

**Nên chỉ có một đường, dùng cho mọi provider:** phát một event `retry`, giao diện **xoá
phần dở**, chạy lại sạch trên key mới.

Chọn xoá chứ không chọn ghép liều, vì hai kiểu hỏng không ngang nhau: chữ biến mất một lần
là chuyện nhìn thấy được và hiểu ngay; một đoạn văn bị lặp hoặc ghép sai chỗ thì âm thầm, và
người đọc có thể mang nó đi dùng mà không biết. Thà hỏng ra mặt còn hơn hỏng trong im lặng.

Giá phải trả: phần text đã sinh ra bị bỏ đi, và nó đã bị tính tiền. Chấp nhận được — nó nhỏ
hơn hẳn cái giá của cả một lượt hỏng cộng với một lượt "continue" gõ tay.

Một đường code thay vì hai cũng có nghĩa là hành vi giống nhau ở mọi provider, nên thứ được
test cũng chính là thứ chạy thật.

### Nói ra, không nuốt

Giữ nguyên cách `notice` đang làm — nó vốn đã đúng, comment trong code nói rõ vì sao: một
lần chuyển key mà không ai thấy thì không phân biệt được với việc key đầu vẫn chạy tốt, cho
tới lúc hoá đơn hoặc sự cố lên tiếng.

Thêm vào đó, khi hết sạch key khả dụng thì nói thật và nói đủ: hạn mức mở lại lúc mấy giờ,
chứ không phải một chữ "failed".

## Vì sao không làm những cách kia

**Không retry mù có backoff cho mọi lỗi.** Request hỏng vẫn bị trừ quota, nên retry một lỗi
`FATAL` là trả tiền để nhận đúng lỗi đó lần nữa.

**Không xoay hết mọi key mỗi khi gặp 429.** Nếu các key thuộc cùng một tài khoản thì vô ích
theo đúng tài liệu OpenRouter, mà vẫn mất mỗi key một request.

**Không tự đổi sang model khác.** Với `:free` thì giới hạn bám theo key chứ không bám theo
model, nên đổi model không giải quyết gì. Còn tự nhảy sang model tính phí là âm thầm tiêu
tiền của người đã cố tình chọn model miễn phí.

## Kiểm thử

Thêm `test/fallback.test.mjs`, theo đúng harness tự viết đang dùng:

- `classify()` — bảng mã lỗi → nhóm, gồm cả 429 có và không có `Retry-After`
- Sổ nghỉ — key bị giới hạn thì bị bỏ qua cho tới mốc reset, sau đó được dùng lại
- Không thăm dò lại — key đang nghỉ không tốn thêm request nào
- Đứt trước token đầu → xoay key, người dùng không thấy gì bất thường
- Đứt sau khi có text → không sinh ra đoạn lặp
- Mọi key đều bị giới hạn → đợi, và báo mốc mở lại; không rơi vào lỗi
- `FATAL` → không đốt key nào khác
- `Retry-After` được tôn trọng đúng con số (dùng đồng hồ giả, không `sleep` thật)

## Định nghĩa hoàn thành cho A

- [ ] `npm run check` sạch (lint + toàn bộ test + sandbox + hooks)
- [ ] Test mới phủ đủ bảng trên
- [ ] Demo bằng chat thường với key thật đã cạn hạn mức, không gõ "continue"
- [ ] `docs` và README cập nhật nếu hành vi thấy được thay đổi

---

# B. Tầng nghiên cứu có phản biện

Làm sau khi A xong và đã demo.

## Hình dạng

Một tool `deep_research` model tự gọi, đặt trong thư mục mới `server/research/`, theo đúng
lối `server/office/` và `server/mcp/` đang đi.

```
server/research/
  index.js        runDeepResearch() — điều phối, quản ngân sách
  plan.js         phân rã câu hỏi thành 4-6 câu hỏi con
  gather.js       thu thập song song, dedupe, chấm hạng nguồn
  debate.js       Proposer → Critic → Proposer → Critic → Arbiter
  confidence.js   chấm HIGH / MEDIUM / LOW / CONFLICTING
  report.js       dựng báo cáo, ép trích dẫn
```

Chạm vào code có sẵn ở năm chỗ, mỗi chỗ một ít: định nghĩa tool, nối tool, bảng
`research_runs` trong schema, hai method store, và **export `runOne` trong `subagents.js`**
(hiện chỉ export `runParallel`). `runOne` đã làm đúng việc cần — một sub-agent read-only có
tool và có đếm token — nên viết lại là nhân bản code.

## Luồng

```
deep_research({ question })
  ├─ PLAN     1 lượt gọi → 4-6 câu hỏi con, mỗi câu 2 truy vấn khác góc độ
  ├─ GATHER   chạy song song qua runOne, chỉ tool read-only
  │           → findings + sổ nguồn: url, tiêu đề, ngày, hạng
  ├─ DEBATE   Proposer → draft, mọi claim gắn [S1][S4]
  │           Critic   → phản đối có cấu trúc
  │           ├─ không phản đối mới → DỪNG SỚM
  │           Proposer → bản sửa
  │           Critic 2 → góc nhìn khác
  │           Arbiter  → chốt; còn bất đồng thật thì trình bày cả hai
  ├─ GRADE    chấm tin cậy bằng code
  └─ REPORT   Kết luận / Bằng chứng / Độ tin cậy / Giới hạn
              + lưu transcript vào research_runs
```

Mọi vai dùng **cùng model của hội thoại**, khác nhau ở persona và system prompt. Đây là cách
brief gợi ý để tiết kiệm, và là điều kiện bắt buộc khi người dùng chạy model miễn phí.

## Hai điểm cốt lõi

**Chấm tin cậy bằng code, không hỏi model.**

```
HIGH         ≥2 nguồn độc lập (khác registrable domain), hạng từ báo uy tín trở lên
MEDIUM       1 nguồn uy tín, hoặc nhiều nguồn hạng thấp đồng thuận
LOW          không có nguồn trực tiếp — là suy luận của model
CONFLICTING  các nguồn mâu thuẫn
```

Model tự chấm độ tự tin của chính nó là thứ hiệu chuẩn kém: nó nói "rất chắc chắn" đúng vào
lúc nó bịa. Đếm số domain độc lập là dữ kiện khách quan, và test được bằng hàm thuần.

**Ép trích dẫn ở tầng code, không ở tầng prompt.**

Proposer chỉ nhận findings đã thu thập, không nhận lịch sử hội thoại — nó không có gì để dựa
vào ngoài bằng chứng. Mọi claim phải mang marker `[S1]`. `report.js` quét lại và gắn nhãn
`LOW — chưa có nguồn` cho câu nào không có marker.

Đây là khác biệt giữa nhắc model đừng bịa, và hệ thống phát hiện được khi nó bịa. Không hoàn
hảo — marker vẫn có thể gắn nhầm — nhưng nó biến ảo giác từ vô hình thành nhìn thấy được.

## Ngân sách, và hạn mức miễn phí

Một lần chạy tốn 8-12 lượt gọi model. Với key miễn phí:

| Loại key | Số lần deep_research mỗi ngày |
|---|---|
| Chưa từng nạp (50/ngày) | ~4-5 |
| Đã nạp ≥$10 (1.000/ngày) | ~80-100 |

Nên tool phải đếm quota chứ không gọi bừa, và phải tiết nhịp giữa các lượt để không vượt 20
request/phút. Trong repo đã có tiền lệ đúng kiểu này: `pacedDuckDuckGo` trong `search.js`.

Chạm trần token thì dừng, trả về những gì đã có, ghi rõ `status: budget`. Không cắt bớt
trong im lặng.

## Lưu vết để audit

```sql
CREATE TABLE IF NOT EXISTS research_runs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id      TEXT,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL,   -- complete | budget | failed | aborted
  transcript   JSONB NOT NULL,  -- các vòng, persona, phản đối
  sources      JSONB NOT NULL,
  report       TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS research_runs_user_idx ON research_runs (user_id, created_at DESC);
```

Tool result trả báo cáo gọn kèm mã run. Transcript đầy đủ nằm trong bảng chứ không nằm trong
hội thoại — nếu nhét vào hội thoại thì nó có mặt trong context của mọi lượt sau, tốn token
thật, và mất khi xoá hội thoại.

## Xử lý lỗi

- Search không ra gì → nói thẳng, confidence LOW, không lấp chỗ trống
- Một sub-agent chết → ghi rõ câu hỏi con nào không có câu trả lời
- Model trả JSON hỏng → thử lại một lần, rồi degrade, không crash
- `signal` bị huỷ → trả về phần đã xong

## Rủi ro đã biết

Cùng một model đóng cả Proposer lẫn Critic thì Critic có xu hướng đồng ý với chính mình.
Persona khác nhau giảm được, không xoá được. Cửa để sửa sau: cho Critic dùng provider khác —
hạ tầng đa provider đã sẵn, chỉ là một tham số. Để cửa đó mở trong code, không đóng cứng.

## Định nghĩa hoàn thành cho B

- [ ] `npm run check` sạch
- [ ] Unit test cho phần hạt nhân thuần: chấm tin cậy, hạng nguồn, dedupe domain, quét marker
- [ ] Integration test với provider giả lập: trần ngân sách chặn đúng, dừng sớm chạy, search
      rỗng không sinh claim bịa
- [ ] Bộ eval nhỏ có đáp án biết trước, đo tỉ lệ bịa và tỉ lệ nói "không chắc" đúng lúc
- [ ] Demo bằng một câu hỏi thật của agency, không phải dữ liệu giả

---

## Nguồn

- [OpenRouter — API Credit & Rate Limits](https://openrouter.ai/docs/api-reference/limits) — chính chủ, dùng cho mọi con số hạn mức
- Tài liệu Claude API (bản tra ngày 2026-08-30) — assistant prefill bị bỏ trên Fable 5,
  Opus 5, Sonnet 5, Opus 4.6/4.7/4.8, Sonnet 4.6; gửi prefill nhận HTTP 400
- `server/providers/index.js`, `server/providers/catalog.js`, `server/settings.js`,
  `server/subagents.js`, `server/search.js` — hiện trạng code, đọc ngày 2026-08-30
