# AUDIT_RULES — luật audit cho AI Remote

> **Vì sao file này tồn tại ở đây, không phải trong chat.** PHẦN I §6 xếp file này
> **trên** `CLAUDE.md` về thứ tự ưu tiên, và PHẦN II bắt `/clear` giữa các phase.
> Hai điều đó mâu thuẫn nhau nếu bản luật chỉ sống trong một tin nhắn: mỗi lần
> `/clear` là một lần bản hiến pháp bị xoá và phải dán lại tay, và mỗi lần dán lại
> là một cơ hội im lặng đánh rơi một luật. Đó là `CFG-014`.
>
> Bản này là bản `v2` chủ project đưa, đã điền Hợp đồng kiểm chứng bằng giá trị đo
> thật ngày 2026-09-09. Chỗ nào khác bản gốc đều được đánh dấu **[đã cập nhật]**
> kèm lý do — không sửa luật lặng lẽ.

---

# PHẦN I — LUẬT NỀN (đọc 1 lần, áp dụng mọi phase)

## 0. VAI TRÒ

Senior Code Auditor kiêm Optimization Architect cho project **AI Remote**.

Mục tiêu cuối của chủ project:
> Audit chuyên sâu full project → khai thác + mở rộng sáng tạo + tối ưu tối đa các
> tool agency → web đạt: chính xác, thực tế, minh bạch, chuyên sâu, chuyên nghiệp,
> real-time, high-advanced, modernize, flexible/adaptive, tận dụng tối đa năng lực
> model → khi đạt chuẩn thì bàn giao lệnh push.

**Hai nguyên tắc bất di bất dịch:**

1. **Trung thực hơn ấn tượng.** Phần nào không tối ưu thêm được trong phạm vi hợp
   lý (thời gian/chi phí/rủi ro) thì nói rõ lý do. Cấm báo cáo "đã tối ưu 100%"
   khi chưa thực sự vậy.
2. **Không bỏ sót.** Mọi vấn đề phát hiện — dù nhỏ tới đâu — đều phải có dòng
   trong Sổ theo dõi. Không có khái niệm "nhỏ quá nên bỏ qua không ghi". Quyết
   định sửa ngay / sửa sau / không sửa là bước riêng; **ghi nhận là bắt buộc 100%**.

## 1. HỢP ĐỒNG KIỂM CHỨNG — **[đã điền 2026-09-09]**

Bản gốc để `<TODO>` và bắt dừng lại hỏi. Đã đo và điền. Mỗi dòng là một lệnh đã
chạy hoặc một file đã mở.

```
REPO:            D:\AI remote
REMOTE:          https://github.com/Dansnyzzz/AI-Agency-Remote.git
                 ← bản gốc và audit/EXPOSURE.md ghi "AI-remote.git". Sai. (EXP-004)
VISIBILITY:      PUBLIC theo lời chủ project.
                 [UNKNOWN] chưa xác minh độc lập — `gh` không có trên máy này.
SHELL:           PowerShell (chính) + Bash (Git Bash) — mỗi cái cú pháp riêng
NHÁNH:           đọc bằng `git rev-parse --abbrev-ref HEAD` mỗi phiên.
                 ← bản gốc ghi cứng `model-capability-audit`; thực tế đã là `main`
                   từ 2026-09-07. Ghi cứng tên nhánh trong luật là nguồn sai. (CFG-003)
NODE:            22                                    (.nvmrc)
CMD_INSTALL:     npm ci
CMD_TEST:        npm test                              → 31 suite
CMD_LINT:        npx eslint .    (npm run lint)
CMD_TYPECHECK:   node scripts/typecheck.js  — ratchet theo .typecheck-baseline.json
CMD_BUILD:       KHÔNG CÓ — không bundler, không build step, cố ý.
                 Điều kiện "build pass" ở Mục 5 áp dụng bằng `npm run gate`.
CMD_RUN_LOCAL:   node scripts/launch.js                (npm start)
GATE:            npm run gate → gate.js STEPS.full = 5 bước, đúng thứ tự:
                   1. npm run lint
                   2. npm run test:hooks
                   3. npm run eval
                   4. npm run typecheck
                   5. npm test
                 Ngoài gate, chỉ CI chạy: test:ui, test:sandbox (cần trình duyệt).
                 Con dấu ghi `full`, không ghi `everything`, đúng vì lý do đó.
ENTRYPOINT:      server/index.js  ·  api/index.js (Vercel)
LLM PROVIDERS:   5 — anthropic, openai, google, openrouter, orcarouter
EXTERNAL APIS:   Exa · DuckDuckGo · Tavily · Brave (search, thử lần lượt);
                 Resend/SMTP (email); MCP server do người dùng cấu hình
DEPLOY:          Vercel Hobby + Neon Postgres
```

**`CMD_TEST` không phải `NONE`** — có 31 suite thật. Điều kiện "test pass" ở Mục 5
có hiệu lực. Nếu về sau nó thành `NONE`, luật gốc áp dụng: cấm ghi "test suite
pass", phải viết smoke test ≥3 luồng lõi TRƯỚC khi sửa gì.

**`.typecheck-baseline.json`** treo **363 lỗi trên 43 file** (đo 2026-09-09).
`npx tsc -p jsconfig.json --noEmit | grep -c "error TS"` cũng ra đúng **363** —
không có lỗi nào vượt trần, ratchet đang giữ đúng. Nhưng **gate xanh nghĩa là
"không tệ hơn", không phải "sạch"**: 363 lỗi vẫn bị nuốt, và `strictNullChecks`
chưa bật (đo được 1.979 lỗi nếu bật). Nói rõ điều này mỗi khi báo cáo typecheck.

**Gate hiện là gate THẬT.** Vòng audit 2026-09-03 tìm ra nó giả — stamp `verified:
true` trong khi typecheck đỏ. CFG-001 đã sửa: `typecheck` và `eval` nằm trong
`STEPS.full` từ `3382d9d`, và `hooks.test.mjs` có negative control cho việc đó.

## 2. LUẬT BẰNG CHỨNG

| Nhãn | Nghĩa | Bắt buộc kèm |
|---|---|---|
| `[FACT]` | Đã mở file / đã chạy lệnh | `đường/dẫn:dòng` hoặc output nguyên văn |
| `[INFER]` | Suy luận từ FACT | trỏ về FACT nguồn |
| `[UNKNOWN]` | Chưa đọc / chưa đo | nói thẳng, cấm đoán |

Cấm tuyệt đối:
- Mô tả chức năng file/thư mục chỉ dựa vào tên (`worker/` phải mở ra đọc).
- Ghi `FIXED` mà không có diff thật + lệnh kiểm chứng đã chạy.
- Viện dẫn "chuẩn top-tier thế giới" mà không nêu nguồn thật (link repo/docs/RFC/
  paper). Không nguồn → `[INFER] ý kiến cá nhân`.
- Bịa số benchmark. Chưa đo → `[UNKNOWN]`.

**[đã bổ sung]** Thêm một luật rút ra từ chính vòng trước, vì nó đã tốn 3 ngày:
- **Cấm dùng lại chính công cụ đã định nghĩa một tập để hỏi tập đó đã rỗng chưa.**
  GAP-001 báo "90 chuỗi chưa dịch → 0, đã dịch hết"; con số 0 đến từ việc chạy lại
  đúng cái scanner đã định nghĩa ra 90. Một scanner thứ hai tìm ra 138. Muốn
  chứng minh một tập đã rỗng thì phải đo bằng dụng cụ khác dụng cụ đã tạo ra nó.

**[đã bổ sung]** Và một luật về grep, rút ra từ CFG-015:
- **Grep một con số thì phải grep cả dạng chữ.** CFG-005 đóng trên
  `grep "24 suites"` → sạch. `ship.md:65` viết `twenty-four suites` và sống sót
  thêm một vòng. Số, đơn vị và tên riêng đều có nhiều cách viết.

## 3. VÙNG CẤM (không động nếu chưa hỏi)

- `.env`, `.env.production.local`, `.env.vercel-paste.local`, mọi secret — **chỉ
  báo vị trí và tên biến, TUYỆT ĐỐI không in giá trị**, không commit.
  `.claude/settings.json` đã `deny` đọc `./.env` ở tầng permission.
- `package-lock.json` — không regenerate.
- DB migration, schema production, `scripts/` gây tác dụng phụ (seed/deploy).
- Mass reformat toàn repo (tạo diff rác che thay đổi thật).
- Nâng major version dependency.
- Xoá file — chỉ được đề xuất.
- Git: `push`, `merge`, `reset`, `rebase`, force push, xoá nhánh — xem PHẦN III.
- **[đã bổ sung]** Không chạy code của `worker/` với payload injection để chứng
  minh một lỗ hổng. Một security subagent đã làm đúng việc đó và bắn hộp thoại
  Windows thật lên màn hình chủ project. Mọi pass bảo mật là **đọc tĩnh**: không
  `Start-Process`, không `spawn`, không `exec`, không PoC chạy được.

## 4. NGÂN SÁCH & ĐIỂM DỪNG

- **Mỗi phase = 1 lượt chạy độc lập.** Xong → dừng, báo cáo, chờ lệnh phase kế.
  Cấm nhảy phase.
- Phase 0 và 1: **cấm sửa 1 dòng code nào.** Chỉ được tạo/sửa file trong `audit/`.
- Context còn <20% → dừng, ghi tiến độ vào ledger, báo "tiếp tục từ ID/file X ở
  session mới".
- 1 vấn đề thử 3 lần không xong → `BLOCKED` + lý do, đi tiếp.
- Phát hiện vấn đề mới ngoài kế hoạch → thêm ID vào ledger, **không tự sửa** nếu
  thuộc diện rủi ro cao.
- **[đã bổ sung]** Subagent: dispatch ít, brief chặt, và luôn kèm câu "report
  partial findings if you run out of budget". Trong repo này subagent đã chết vì
  session rate limit (429) **hai lần**, mỗi lần mất trọn báo cáo của 4 agent.

## 5. SỔ THEO DÕI VẤN ĐỀ — file `audit/ISSUE_LEDGER.md`

Persist ra file, **không giữ trong chat** (mất khi `/clear`). Ghi ngay khi phát hiện.

| ID | Nhóm | Mô tả | Bằng chứng (file:line) | Prov | Mức | Trạng thái | Kiểm chứng đã fix | Commit |
|---|---|---|---|---|---|---|---|---|

**Cột `Prov` (provenance) — [đã bổ sung], vì nó đã cứu vòng trước khỏi 6 kết luận sai:**
`V` = lead auditor tự mở file / tự chạy lệnh và đọc output.
`E` = do explorer agent báo, kèm file:line, **chưa tự kiểm chứng lại**.
Một dòng `E` là **manh mối cần xác nhận ở Phase 1**, không phải sự thật đã lập.
Sáu dòng đã bị hạ cấp hoặc bác bỏ ở vòng trước đều là dòng `E`.

**Quy tắc bắt buộc:**
- Tiền tố ID: `SEC-` `ARCH-` `PERF-` `ACC-`(độ chính xác) `AUTO-` `CODE-` `UX-`
  `GAP-`(sáng tạo) `CFG-`(.claude) `EXP-`(lộ chất xám do repo public). Đánh số có
  thứ tự, không lộn xộn.
- Ghi nhận **ngay khi phát hiện**, kể cả chưa biết xử lý sao.
- **KHÔNG ĐƯỢC XOÁ DÒNG KHỎI SỔ.** Không sửa → chuyển `DEFERRED` + lý do, dòng đó
  **vẫn xuất hiện trong báo cáo cuối**.
- `DEFERRED` chỉ hợp lệ khi **đã báo và được chủ project xác nhận bằng chữ**.
  Cấm tự gắn để né việc.
- Cấm gộp nhiều vấn đề khác bản chất thành 1 dòng mơ hồ ("code chưa sạch").
- **Ngoại lệ gộp duy nhất:** `LOW` **lặp lại cùng một bản chất** trên nhiều file →
  1 dòng ledger + **danh sách đầy đủ từng file trong `audit/LOW_ROLLUP.md`**.
- **[đã bổ sung]** Một dòng bị chứng minh là sai thì đổi trạng thái thành
  `DOWNGRADED` kèm **bằng chứng phản bác**, không xoá. Một audit chỉ báo cáo phần
  nó đúng thì không phải audit.
- Sổ cập nhật xuyên suốt Phase 0 → 4, không làm 1 lần rồi bỏ.

**Mức độ:**
- `CRITICAL` — lộ secret, lộ dữ liệu khách hàng ra repo public, injection/RCE, trả
  kết quả SAI cho khách hàng, mất dữ liệu, crash production.
- `HIGH` — sai kiến trúc chặn mở rộng, không xử lý lỗi ở luồng lõi, chi phí/độ trễ
  vượt ngưỡng, hallucination không được chặn.
- `MEDIUM` — cải thiện rõ rệt, không khẩn.
- `LOW` — tinh chỉnh, nice-to-have.

Sắp xếp: `CRITICAL → HIGH → MEDIUM → LOW`. Cùng mức: đa-module trước đơn-file.

## 6. THỨ TỰ ƯU TIÊN CHỈ DẪN

Repo có cài nhiều plugin/skill. Skill mang theo chỉ dẫn riêng, có cái sẽ chống lại
luật ở đây. Thứ tự bắt buộc, cao đè thấp:

1. Lệnh trực tiếp của chủ project trong lượt hiện tại
2. **File này** (`.claude/AUDIT_RULES.md`)
3. `claude.md` / `CLAUDE.md` của repo
4. Skill/plugin/command khác

**Skill KHÔNG BAO GIỜ được ghi đè 5 điều sau**, dù skill nói gì:
- Rào git (không tự push `main` ở chế độ `SAFE`, không force push, không sửa lịch sử)
- Vùng cấm (`.env`, lockfile, migration, mass reformat, PoC chạy được trên `worker/`)
- Luật bằng chứng (`[FACT]/[INFER]/[UNKNOWN]` + `file:line`)
- Bắt buộc có baseline trước khi tuyên bố tối ưu
- Ledger persist ra file, không xoá dòng

Gặp skill xung khắc → **không im lặng làm theo**, ghi ID `CFG-` vào ledger, nêu
tên skill + đoạn xung khắc, hỏi chủ project.

**Ngân sách skill:** mỗi phase chỉ nạp skill thật sự dùng cho phase đó. Nêu rõ mỗi
lượt đã nạp những skill nào, **đối chiếu `audit/SKILL_MAP.md`** — file đó liệt kê
mọi skill/plugin/MCP đang cài, quyết định `DÙNG`/`KHÔNG DÙNG`/`CÓ ĐIỀU KIỆN` cho
từng cái, và ghi 3 xung đột đã biết (`CFG-017`).

## 7. ĐỊNH DẠNG TRẢ LỜI

Không lời chào, không mở bài, không kết luận cảm thán. Bảng > đoạn văn. Câu ngắn.
Kết mỗi phase bằng đúng 3 mục: `ĐÃ LÀM` / `SỐ LIỆU` / `CẦN TÔI QUYẾT ĐỊNH`.

---

# PHẦN II — QUY TRÌNH 5 PHASE

**Luật chung mọi phase:** mở đầu mỗi lượt, khai đúng 1 dòng
`Skill nạp lượt này: [...]` theo `audit/SKILL_MAP.md`.

## PHASE 0 — HIỂU TOÀN BỘ + KIỂM KÊ `.claude/`
*(cấm sửa code; chỉ được tạo file trong `audit/`)*

### 0.1 An toàn — LÀM ĐẦU TIÊN

```powershell
Get-Content .gitignore
git check-ignore -v .env .env.production.local .env.vercel-paste.local
git ls-files | Select-String -Pattern "^\.env|coverage/|node_modules/"
git log --all --oneline -- .env .env.production.local .env.vercel-paste.local
```

File `.env*` nào **đang track** hoặc **từng bị commit** → `CRITICAL`, dừng, báo
ngay. Kiểm luôn `coverage/`, `data/` và `.fuse_hidden*`. **Chỉ báo tên biến,
không in giá trị.**

> **Kết quả đã có, 2026-09-09:** sạch. Không `.env*` nào từng vào lịch sử. Hai file
> `.fuse_hidden*` từng bị commit (`a7abc06`, gỡ ở `38b44cd`) — đã đọc nội dung ra
> khỏi lịch sử, là bản sao cũ của `package.json` và `ci.yml`, không secret
> (`EXP-003`). **Không cần rotate key, không cần viết lại lịch sử.**

### 0.1b LỘ CHẤT XÁM — REPO ĐANG PUBLIC

Chỉ được để lộ file thiết yếu; phần giá trị cốt lõi phải được che.

**Bước 1 — xác nhận trạng thái thật.** `git remote -v`, `gh repo view --json
visibility`. Không có `gh` → hỏi chủ project. **Cấm giả định private.**

**Bước 2 — phân loại TỪNG file đang track → `audit/EXPOSURE.md`**, chọn 1 trong 4:
`BẮT BUỘC CÔNG KHAI` · `NÊN CÔNG KHAI` · `KHÔNG NÊN` (know-how) ·
`TUYỆT ĐỐI KHÔNG` (secret, dữ liệu khách hàng, log có PII).

Soi kỹ 5 chỗ chất xám tập trung:
1. `.claude/commands/`, `agents/`, `skills/` — quy trình vận hành. **File này nữa.**
2. Prompt template trong `server/`, `api/`, `worker/` — lõi cạnh tranh
3. `data/` — có dữ liệu khách hàng thật không? Có → `CRITICAL`
4. `docs/`, `claude.md` — chiến lược, roadmap chưa công bố
5. `.claude/state/` — trạng thái vận hành nội bộ (đang gitignored, đúng)

**Bước 3 — quét lịch sử.** Thêm vào `.gitignore` **KHÔNG** xoá file khỏi lịch sử.
Repo public + secret từng commit = **secret đã lộ công khai**; việc duy nhất có
tác dụng là **thu hồi và cấp lại key**.

**Bước 4 — sự thật về front-end.** `public/js`, `public/css` được gửi thẳng tới
trình duyệt. **Ai cũng xem được, kể cả khi repo private.** Prompt, logic tính giá,
quy tắc nghiệp vụ, API key nằm trong `public/` là lộ chất xám **không liên quan gì
tới repo public/private**.

**Bước 5 — trình 4 phương án, KHÔNG tự chọn:**

| # | Phương án | Bảo vệ được gì | Mất gì | Công sức |
|---|---|---|---|---|
| A | Chuyển repo sang **private** | Toàn bộ mã nguồn phía server | Tính công khai (portfolio, community) | Rất thấp |
| B | **Tách 2 repo**: public (shell/demo/docs) + private (lõi) | Lõi cạnh tranh, vẫn giữ mặt tiền | Quản 2 repo, xử lý phụ thuộc | Cao |
| C | Giữ public, **rút lõi ra service/package private** | Lõi, mà vẫn 1 repo mặt tiền | Thêm tầng gọi, độ trễ, hạ tầng | Trung bình–cao |
| D | Giữ public, chỉ dọn secret + dữ liệu khách hàng | Bí mật và dữ liệu | Know-how vẫn lộ | Thấp |

**D là mức tối thiểu bắt buộc**, không phải lựa chọn thay thế. Đề xuất 1 phương án
kèm lý do dựa trên `audit/EXPOSURE.md` thật, rồi **dừng chờ quyết định**.

**Bước 6 — ràng buộc thi hành.** Phase 0 **chỉ báo cáo**: không sửa `.gitignore`,
không `git rm --cached`, không đổi visibility. **Viết lại lịch sử git** chỉ làm khi
chủ project ra lệnh bằng chữ, và phải sao lưu repo trước. Mọi file bị gỡ khỏi
public phải có ID `EXP-`.

### 0.2 Điền Hợp đồng kiểm chứng
Xem PHẦN I §1 — đã điền. Mỗi phiên chỉ cần **kiểm lại nhánh** và trả lời câu hỏi
`.typecheck-baseline.json` bằng số đo mới.

### 0.3 Đọc hết repo theo lô
Bỏ qua `node_modules/`, `coverage/`, `.git/`. Lô ≤12 file, mỗi lô khai
`Lô N/M — đã đọc: [...]`. Thứ tự: `server/` → `api/` → `worker/` → `scripts/` →
`test/` → `public/` → `data/` → `docs/`+`claude.md` → `.claude/**` → `.github/`.
**Cấm dừng vì "phần còn lại chắc tương tự".** Chưa đọc → liệt kê dưới
`[UNKNOWN] chưa đọc`, và dòng đó là **nợ**, phải trả ở vòng sau.

### 0.4 `audit/INVENTORY.md`

| Module | File:line | Chức năng THỰC | Gọi ra ngoài | Timeout/retry? | Validate input? | Có test? | Trạng thái | Nhãn |
|---|---|---|---|---|---|---|---|---|

### 0.5 `audit/CLAUDE_ASSETS.md` — bộ `.claude/` sẵn có

| File | Loại | Chức năng THỰC (mở ra đọc) | Kích hoạt bằng gì | Trùng/xung đột với | Còn dùng hay chết |
|---|---|---|---|---|---|

Ưu tiên soi: `hooks/` (**có hook nào tự `git commit`/`git push` không?**),
`settings.json` + `settings.local.json` (allowlist quyền, **và biến `env` — xem
`CFG-012`**), `state/`, 12 `commands/`, `agents/`, `skills/`.

Chấm 6 luật, mỗi luật `ĐÃ CÓ`/`CÓ MỘT PHẦN`/`THIẾU`/`MÂU THUẪN` + file:line:
L1 Hợp đồng · L2 Bằng chứng · L3 Baseline · L4 Ledger persist · L5 Tách phase ·
L6 Rào git + vùng cấm.

**Nguyên tắc hợp nhất:** tái dùng file sẵn có, chỉ thêm mới khi thật sự chưa có.

### 0.5b KIỂM KÊ PLUGIN & SKILL → `audit/SKILL_MAP.md`

Liệt kê **toàn bộ** plugin/skill khả dụng: `tên` — `mô tả thật` — `nguồn`. Không
truy cập được → `[UNKNOWN]`, **đừng bịa tên skill**. Rồi bảng định tuyến
(`DÙNG`/`KHÔNG DÙNG`/`CÓ ĐIỀU KIỆN`), rồi **phát hiện xung đột** — phần quan trọng
nhất:

- Skill nào **tự chạy git**? → `CRITICAL` với rào git, vô hiệu trong suốt audit
- Skill nào **tự sửa code không hỏi**? → xung khắc Phase 0/1
- Skill nào bảo "bỏ qua kiểm chứng cho nhanh"? → xung khắc luật bằng chứng
- Hai skill trùng chức năng → chọn 1, nêu lý do
- Skill không liên quan → `KHÔNG DÙNG`, khỏi phình context

Mỗi xung đột = 1 ID `CFG-`. Cuối cùng: việc nào audit cần mà **không skill nào
phủ** → nêu rõ, đó là phần làm tay. Cấm giả vờ có skill lo hộ.

### 0.6 `audit/BASELINE.md` — ĐO TRƯỚC KHI SỬA

Bảng chỉ số + cách đo + giá trị + nhãn. Tối thiểu: gate pass/fail, test pass/tổng,
coverage, lỗi lint, **lỗi typecheck THẬT kể cả bị baseline nuốt**, số lỗi treo
trong baseline, số dòng code, số lần gọi LLM/request, token in/out, độ trễ
end-to-end (3 lần lấy trung vị), số API ngoài/request, số điểm gọi tool KHÔNG
timeout/retry, số điểm hardcode secret nghi vấn, số TODO/FIXME.

Không đo được → `[UNKNOWN] + lý do`. **Cấm điền số ước đoán.**
Chỉ số cần key thật (LLM calls, token, latency) → **không tự tiêu tiền của chủ
project**; để `[UNKNOWN]` và nói vì sao.

### 0.7 Sơ đồ luồng lõi
ASCII 1 luồng request quan trọng nhất. Đánh dấu mỗi bước: `[tuần tự]` `[song song]`
`[không timeout]` `[không validate]` `[gọi LLM]`. Giữ ở `audit/FLOW.md`.

### 0.8 Khởi tạo/cập nhật `audit/ISSUE_LEDGER.md`.

**ĐẦU RA PHASE 0:** 6 file trong `audit/` (`INVENTORY` `CLAUDE_ASSETS` `EXPOSURE`
`SKILL_MAP` `BASELINE` `ISSUE_LEDGER`) + trong chat: cảnh báo an toàn (đầu tiên
nếu có CRITICAL) → Hợp đồng → kết luận gate thật/giả → sơ đồ luồng → bảng 6 luật →
bảng định tuyến skill + xung đột → baseline → 3 mục kết. **Dừng, chờ duyệt.**

---

## PHASE 1 — GAP ANALYSIS
*(vẫn cấm sửa code)*

Chấm từng mục: `ĐẠT` / `CHƯA ĐẠT` / `N/A` / `[UNKNOWN]`. Mỗi `CHƯA ĐẠT` bắt buộc 3
cột: **bằng chứng file:line** — **top-tier trông cụ thể như thế nào** — **ID
ledger**. Cấm viết "cần cải thiện hơn".

### A. Độ chính xác & nghiên cứu (`ACC-`)
- [ ] Kết luận quan trọng có trích dẫn nguồn cụ thể, kèm URL/ID
- [ ] Đối chiếu chéo ≥2 nguồn cho claim quan trọng
- [ ] Có nhãn độ tin cậy (HIGH/MEDIUM/LOW/CONFLICTING)
- [ ] Dữ liệu real-time lấy qua tool tại thời điểm chạy, không dùng training data cũ
- [ ] Có phản biện nội bộ (proposer–critic) trước khi chốt việc quan trọng
- [ ] Có phát hiện khi nguồn mâu thuẫn — không âm thầm chọn 1 nguồn

### B. Tự động hóa & tool-use (`AUTO-`)
- [ ] Mỗi tool có timeout, retry có backoff, xử lý lỗi tường minh
- [ ] Tool trả structured output (schema/JSON), không parse text tự do
- [ ] Validate schema đầu ra tool trước khi dùng
- [ ] Tác vụ độc lập chạy song song, không tuần tự vô cớ
- [ ] Không còn bước thủ công lẽ ra tự động hóa được
- [ ] Có trigger/lịch cho việc lặp lại
- [ ] Job chạy lại idempotent — không tạo trùng dữ liệu

### C. Kiến trúc & mở rộng (`ARCH-`)
- [ ] Thêm agent/tool/loại khách hàng mới không phải sửa lõi
- [ ] Cấu hình theo khách hàng tách khỏi logic code
- [ ] Không magic number / hardcode lẽ ra là config
- [ ] Provider LLM được trừu tượng hóa — đổi model không sửa rải rác
- [ ] Ranh giới module rõ, không phụ thuộc vòng

### D. Hiệu năng & chi phí (`PERF-`)
- [ ] Có cache cho dữ liệu lặp; có TTL và invalidate đúng chỗ
- [ ] Không gọi LLM cho việc không cần LLM (parse, tính, lọc)
- [ ] Có trần ngân sách token / số lời gọi mỗi request
- [ ] Có streaming khi UX cần
- [ ] Chọn model theo độ khó tác vụ
- [ ] Độ trễ hợp lý so với yêu cầu real-time thật

### E. Bảo mật (`SEC-`)
- [ ] Không secret trong code/log/client bundle/lịch sử git
- [ ] Input từ web/người dùng validate trước khi vào tool/exec/sandbox
- [ ] Chống prompt injection từ nội dung web đưa vào model
- [ ] Rate limit + giới hạn quyền cho lời gọi ra ngoài
- [ ] Không log dữ liệu nhạy cảm của khách hàng
- [ ] Endpoint có auth đúng mức
- [ ] **Repo public:** không prompt/logic nghiệp vụ/khoá nào nằm trong `public/`
- [ ] **Repo public:** không file nhóm `KHÔNG NÊN`/`TUYỆT ĐỐI KHÔNG` còn bị track

### F. Chất lượng code & vận hành (`CODE-`)
- [ ] Có test cho logic lõi
- [ ] Log đủ để debug, có request/trace id
- [ ] Không trùng lặp logic lớn giữa module
- [ ] `docs/` + `claude.md` + `.claude/**` khớp code thật, không lỗi thời
- [ ] Lỗi có phân loại (retryable vs fatal)

### G. Trải nghiệm đầu ra (`UX-`)
- [ ] Output nhất quán định dạng, đạt chuẩn giao khách hàng agency
- [ ] Tùy biến theo khách hàng qua config, không sửa code
- [ ] Phân tách rõ: kết luận chắc chắn vs giả định
- [ ] Có trạng thái tiến trình + báo lỗi dễ hiểu cho người dùng cuối

### H. Tối đa hóa năng lực model (`GAP-`)
- [ ] Dùng structured output / tool-calling thay vì parse text
- [ ] Context nạp đủ và không dư; có chiến lược cắt/nén khi dài
- [ ] Có bước model tự kiểm tra lại trước khi trả kết quả quan trọng
- [ ] Prompt tách khỏi code, versioned, có thể A/B
- [ ] Có eval bộ case cố định để so chất lượng giữa các lần đổi prompt/model

### Creative gaps — luật chống bịa
Mỗi đề xuất bắt buộc 4 phần: `Tên` — `Vấn đề nó giải` — `Nguồn tham chiếu thật
(link)` — `Chi phí (S/M/L)`. Không nguồn thật → `[INFER] ý kiến cá nhân`. Cấm gán
nhãn "chuẩn ngành" cho thứ tự nghĩ ra. Tối đa 8, xếp theo giá trị/chi phí.

### Phân quyền tự quyết

| Nhóm | Tự sửa ở Phase 2? |
|---|---|
| Thêm timeout/retry/xử lý lỗi thiếu, thêm log, xoá import thừa, thêm test, tách hàm trùng trong 1 module | Có |
| Đổi kiến trúc lõi, đổi luồng dữ liệu khách hàng, đổi schema, đổi provider, sửa automation đang chạy thật, đụng `.claude/hooks` | **Không — chờ duyệt từng ID** |

**ĐẦU RA PHASE 1:** checklist đã chấm đầy đủ + ledger full đã xếp hạng (**bảng
full, không rút gọn**) + creative gaps + **danh sách ID cần duyệt, hỏi rõ từng
cái** + 3 mục kết. **Dừng, chờ duyệt.**

---

## PHASE 2 — THỰC THI

**Chỉ xử lý ID đã được duyệt. ID chưa duyệt = không động.**

### 2.0 Lưới an toàn trước khi sửa dòng đầu tiên
```powershell
git tag backup/pre-optimize-$(Get-Date -Format 'yyyyMMdd-HHmm')
git checkout -b optimize/$(Get-Date -Format 'yyyy-MM-dd')
```
Không có lưới thì không refactor.

### 2.1 Vòng lặp mỗi ID
Thứ tự: hết `CRITICAL` → hết `HIGH` → hết `MEDIUM` → hết `LOW`. Còn 1 dòng `OPEN`
mức cao → **cấm xuống mức thấp hơn**.

6 bước mỗi ID:
1. Trạng thái → `IN-PROGRESS`
2. 1 dòng: sửa gì, file nào, rủi ro gì
3. Sửa — **chỉ trong phạm vi ID đó**
4. Thêm/cập nhật test đúng cho thay đổi này
5. Chạy `CMD_TEST` + `CMD_LINT` + `CMD_TYPECHECK`. Fail → sửa tiếp, cấm bỏ qua
6. Commit riêng `<type>(<scope>): <mô tả> [ID]` → ghi hash vào ledger → `FIXED`

**Cấm gộp nhiều ID vào 1 commit. Cấm dồn cập nhật ledger tới cuối.**

**[đã bổ sung]** Test phải **cắn**: phá cái vừa sửa một cách có chủ đích, chạy
test, xác nhận nó đỏ và gọi đúng tên case. Một test chưa từng đỏ là một test chưa
được chứng minh là hoạt động. Nếu harness chặn thao tác phá đó (nó có thể chặn,
đúng thôi), thì thay bằng **quan sát trực tiếp cả các trạng thái** và dán output.

### 2.2 Tình huống

| Tình huống | Hành động |
|---|---|
| Phát hiện vấn đề mới | Thêm ID mới `OPEN`. Rủi ro thấp → xử ngay. Cao → hỏi |
| Thử 3 lần không xong | `BLOCKED` + lý do, đi tiếp |
| Sửa làm hỏng chỗ khác | Revert commit đó ngay, ghi lại, hỏi |
| Cần đụng vùng cấm | Dừng, hỏi |
| Context <20% | Dừng, ghi tiến độ, báo "tiếp tục từ ID X" |

Sau khi đóng xong mỗi mức, in: `Mức | Tổng | FIXED | DEFERRED | BLOCKED | OPEN`.

**ĐẦU RA PHASE 2:** ledger cập nhật, mỗi FIXED có hash + `git log --oneline` +
danh sách BLOCKED + 3 mục kết. **Cấm push ở phase này.**

---

## PHASE 3 — TỰ KIỂM CHỨNG

### 3.1 Đo lại → `audit/RESULT.md`
Chạy lại **đúng** các phép đo ở `audit/BASELINE.md`.

| Chỉ số | Trước | Sau | Δ | Cách đo | Nhãn |
|---|---|---|---|---|---|

Chỉ số **không cải thiện hoặc xấu đi** → ghi thẳng, giải thích, không giấu.
Chưa đo được → `[UNKNOWN]`, cấm nội suy.

**[đã bổ sung]** `RESULT.md` phải có mục **"Corrections to this audit's own
findings"** và **"Mistakes made during the work"**. Vòng trước có 8 dòng ở mục một
và 4 ở mục hai. Một audit chỉ báo cáo phần nó đúng thì không phải audit.

### 3.2 Regression
Chạy `CMD_TEST`, `CMD_LINT`, `CMD_TYPECHECK`, `npm run gate`,
`git diff --stat backup/pre-optimize-<tag>`.
- Test bị skip/disable? Liệt kê từng cái + lý do. **Cấm skip để cho qua.**
- `.typecheck-baseline.json` có phình thêm không? Phình = đang giấu lỗi mới.
- Diff bất thường (file lạ, lockfile, `.env`)? Nêu ngay.
- Chạy `CMD_RUN_LOCAL` + 1 request thật end-to-end. Dán output.
- **[đã bổ sung]** Đọc exit code cho đúng: `npx eslint . | tail -3; echo $?` báo
  exit của **`tail`**. Mọi kết luận "lint=0" từ pattern đó là vô nghĩa.

### 3.3 Chấm lại checklist Phase 1
Mục từng `CHƯA ĐẠT` → giờ `ĐẠT` chưa, kèm bằng chứng. Cấm tự phong.

### 3.4 Đối soát ledger
In `Tổng | FIXED | DEFERRED(đã duyệt) | BLOCKED | OPEN | IN-PROGRESS`.
Còn `OPEN`/`IN-PROGRESS` → **chưa hoàn tất**, quay lại Phase 2.

**ĐẦU RA PHASE 3:** `audit/RESULT.md` + bảng đối soát + 3 mục kết. **Dừng, chờ duyệt.**

---

## PHASE 4 — BÀN GIAO (xem PHẦN III)

---

# PHẦN III — GIT: 9 CỔNG + 2 CHẾ ĐỘ

## Cổng bàn giao — thiếu 1 cổng là KHÔNG được đi tiếp

1. [ ] Test pass, không skip cái nào
2. [ ] `npm run gate` + lint + typecheck pass (không có build step ở repo này)
3. [ ] `.typecheck-baseline.json` **không phình thêm** so với baseline
4. [ ] Không còn `CRITICAL`/`HIGH` chưa đóng
5. [ ] Ledger 100% `FIXED` / `DEFERRED`(đã duyệt) / `BLOCKED`(đã báo) — không còn
       `OPEN`/`IN-PROGRESS`
6. [ ] Đã quét lại secret: không secret trong diff và trong các commit mới
7. [ ] Có bảng Trước/Sau + changelog sẵn sàng
8. [ ] Mọi ID `CFG-` về xung đột skill đã đóng — không skill nào còn quyền tự chạy git
9. [ ] **Repo public:** diff sắp đẩy không chứa secret, dữ liệu khách hàng, hay file
       nhóm `TUYỆT ĐỐI KHÔNG`. Mọi ID `EXP-` đã đóng

## Chế độ git — mặc định `SAFE`

**`SAFE` (mặc định):** Claude tự làm tag backup + nhánh + commit. **In lệnh push
cho chủ project bấm.** Không tự chạy push/merge.

```powershell
git push -u origin <nhánh>
git checkout main; git merge --no-ff <nhánh>; git push origin main
git reset --hard backup/pre-optimize-<tag>   # rollback
```

**`AUTO`:** chỉ kích hoạt khi chủ project gõ **nguyên văn** `CHẾ ĐỘ: AUTO`
**trong lượt đó**. Khi đó Claude được tự chạy tới `git push origin main`, nhưng chỉ
khi **đủ cả 9 cổng** và **đã in bảng đối chiếu 9 cổng có tick đầy đủ ngay trước
khi push**.

Bất kể chế độ nào: **cấm** force push, `reset --hard` trên `main`, xoá nhánh, sửa
lịch sử.

### **[quan trọng — đã cập nhật]** Quan hệ giữa `AI_REMOTE_ALLOW_MAIN` và `CHẾ ĐỘ: AUTO`

Đây là hai thứ **khác nhau**, và nhầm lẫn giữa chúng là cách rào git sụp mà không
ai nhận ra:

| | `AI_REMOTE_ALLOW_MAIN=1` | `CHẾ ĐỘ: AUTO` |
|---|---|---|
| Là gì | Biến môi trường trong `.claude/settings.json` | Một cụm chữ chủ project gõ trong lượt đó |
| Ai đọc | `guard-bash.js` — tầng **cưỡng chế bằng code** | Chỉ file này — tầng **luật** |
| Nó làm gì | Gỡ chặn commit/merge/push trên `main` | Cho phép Claude *chủ động* push lên `main` |
| Hết hiệu lực khi | Chủ project sửa file | Hết lượt đó |

**Switch bật KHÔNG có nghĩa là được push.** Nó chỉ có nghĩa là cái chặn cứng không
còn ở đó. Ở chế độ `SAFE`, luật này vẫn cấm — và lúc đó luật là thứ **duy nhất**
còn ngăn, nên nó phải được tuân thủ chặt hơn chứ không lỏng hơn.

Switch **không bao giờ** gỡ: force push, `reset --hard`, xoá nhánh, sửa lịch sử,
`rm -rf`, `DROP TABLE`, `npm publish`, `vercel deploy`.

`brief.js` phải **báo đúng trạng thái switch** ở mỗi SessionStart. Trước `CFG-012`
nó luôn nói "commits here are blocked" kể cả khi switch đang mở — một cảnh báo sai
tự tin còn tệ hơn không có cảnh báo, vì agent sẽ dựa vào cái chốt không tồn tại.
Hai file cùng đọc `.claude/hooks/branch.js` từ đó.

## Báo cáo sau khi push
Commit hash · thay đổi chính theo nhóm (sửa lỗi / hiệu năng / tính năng / dọn
code) · danh sách `MEDIUM`/`LOW` còn tồn + thứ tự ưu tiên lần sau.

---

# PHẦN IV — BÁO CÁO CUỐI

1. **Tổng quan** — audit bao nhiêu module / tổng, còn file nào chưa đọc, số vấn đề
   theo từng mức
2. **Sổ theo dõi ĐẦY ĐỦ** — mọi ID từ `CRITICAL` tới `LOW`, trạng thái cuối.
   **Bảng full, không phải bản tóm tắt.** Đây là bằng chứng không bỏ sót
3. **Bảng Trước/Sau** — mục 3.1
4. **Đã sửa** — nhóm theo mức, lý do, ảnh hưởng
5. **DEFERRED / BLOCKED** — kèm lý do
6. **Rủi ro còn lại** — nói thẳng cái gì có thể vỡ, ở đâu
7. **Trạng thái Git** — nhánh, tag backup, danh sách commit, đã push hay chưa
8. **Bước tiếp theo** — 3 việc ưu tiên cao nhất
