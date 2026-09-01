# Workflow nhiều bước — việc tự động không đứt giữa chừng

Ngày: 2026-09-01

Pha 2, lát cắt 1. Cho một việc tự động gồm nhiều bước **phụ thuộc nhau** chạy tới
nơi mà không cần ai ngồi trông: *"mỗi thứ Hai: lấy số, vẽ chart, viết deck, gửi
mail"*.

## Vấn đề thật, không phải vấn đề tưởng tượng

Một `schedule_task` hôm nay **đã là một lượt agent đầy đủ với 90 tool**, nên nó đã
chain được nhiều việc trong một lượt. Nếu không nói rõ cái đang thiếu thì thứ xây
ra sẽ trùng với thứ đang có. Ba thứ thiếu, đều có thật và đều vô hình:

1. **Không chạy hết được.** `vercel.json` đặt `maxDuration: 300` — trần của gói
   Hobby. Bốn bước có gọi LLM và tool dễ vượt. Invocation bị cắt giữa chừng: mail
   có thể đã gửi, có thể chưa; lần nổ kế tiếp **làm lại từ đầu** và gửi lần nữa.
   Không có khái niệm resume ở bất kỳ đâu trong `server/scheduler.js`.
2. **Nửa vời trong im lặng.** `prefs.maxSteps` kết thúc vòng lặp bằng *"Stopped
   after N steps. Send a message to continue."* — hợp lý khi có người ngồi đó,
   vô dụng lúc 5 giờ sáng. `runTask` vẫn ghi `status = 'ok'`.
3. **Không thấy vỡ ở đâu.** `scheduled_tasks` có đúng một cột `last_status` cho
   một việc bốn phần.

Cron của gói free chỉ nổ **một lần mỗi ngày** (`vercel.json`, `0 16 * * *`), nên
"để lần sau chạy lại" không phải một chiến lược phục hồi.

## Kiến trúc

### Bước là một lượt agent bình thường

Mỗi bước chạy như một lượt `runAgent` trong **một hội thoại chung của lần chạy**.
Bước N nhìn thấy bước 1..N−1 vì chúng nằm cùng transcript — phụ thuộc dữ liệu có
sẵn, không cần cơ chế truyền kết quả nào mới. **Không viết máy móc agent mới.**

Hệ quả tốt thứ hai: kết quả là một hội thoại đọc được như mọi hội thoại khác,
đúng lập luận `scheduler.js` đã dùng cho task thường.

### Hai bảng

```sql
workflows      id, user_id, title, steps JSONB, model, cron, tz,
               next_run_at, enabled, last_run, created_at
workflow_runs  id, workflow_id, user_id, chat_id, status, steps JSONB,
               cursor INT, lease_until TIMESTAMPTZ, started_at, finished_at
```

`workflows.steps` là định nghĩa: `[{ id, instruction }]`.
`workflow_runs.steps` là trạng thái thực thi từng bước:
`[{ id, status, started_at, finished_at, summary, error }]`.

`status` của run: `running | done | failed | needs_attention | cancelled`.

### Chạy theo lease, cắt được giữa chừng

Claim bằng đúng khuôn `FOR UPDATE SKIP LOCKED` mà `claimDueTask` đã dùng, đặt
`lease_until = now + 5 phút`. Chạy các bước liên tiếp cho tới khi hết việc **hoặc
tiêu hết ngân sách thời gian (~200s)**, dưới trần 300s một biên đủ để ghi trạng
thái và trả lời. Rồi thả lease và trả về. Lần nhúc nhích sau chạy tiếp từ
`cursor`.

Điều này khiến workflow **không phụ thuộc vào việc chạy xong trong một
invocation**, tức là nó dùng được trên gói free chứ không chỉ trên máy chạy liên
tục.

### Điểm đạo đức của thiết kế: một bước dở dang không bao giờ được chạy lại

Trước khi chạy bước *i*, nó được đánh dấu `running` và ghi thời điểm. Khi một
tiến trình khác reclaim run đó và thấy một bước còn `running`, bước ấy chuyển
thành **`unknown`** và cả run chuyển sang **`needs_attention`**. Không chạy lại,
không đoán.

Không ai — kể cả người viết code — trả lời được "mail đã gửi chưa" khi tiến trình
chết đúng lúc gọi API. Lặp lại một tác dụng phụ khi không có ai trông tệ hơn hẳn
việc dừng lại và hỏi, và CLAUDE.md §6 nói rõ: dừng và xác nhận trước một thao tác
không thể đảo, thay vì tự quyết.

### Kích hoạt

Không thêm đường kích hoạt nào. Dùng lại đúng hai đường đã có:
`/api/cron/run-tasks` hằng ngày, và cú nhúc nhích từ trình duyệt
(`runDueTasksForUser`) mà `scheduler.js` đã giải thích kỹ vì sao phải nằm ở
endpoint riêng chứ không phải trong `/bootstrap`.

### Hai tool, không phải bốn

`server/tools/definitions.js` cắt catalogue theo **tỷ lệ cửa sổ**, nên mỗi tool
thêm vào là thuế đánh lên mọi request của mọi tài khoản.

- `workflow_write` — tạo / sửa / xoá qua một trường `action`
- `workflow_status` — liệt kê workflow và trạng thái từng bước của lần chạy gần nhất

Cả hai `scope: 'cloud'`, `secondary: true` để bị bỏ trước khi cửa sổ chật.

### Giao diện

Một trang liệt kê workflow, lần chạy gần nhất, và trạng thái **từng bước** — vì
"không thấy vỡ ở đâu" là một trong ba vấn đề, và một tool trả JSON không giải
quyết nó cho người dùng.

`public/js/app.js` đã 4307 dòng. Màn hình này đi vào **module riêng**
(`public/js/workflows.js`) theo lối `project-page.js` và `workspace.js` đang làm,
chứ không nối thêm vào file đó.

## Kiểm thử

`test/workflow.test.mjs` — mới:

- resume: giết giữa chừng, chạy lại, tiếp từ đúng `cursor`
- một bước `running` khi bị reclaim → `unknown` + `needs_attention`, **không chạy lại**
- ngân sách thời gian cắt đúng chỗ và thả lease
- một bước hết `maxSteps` cho ra `failed`, không phải `ok`
- lease còn hiệu lực thì tiến trình thứ hai không claim được

Cộng thêm: bảng mới **bắt buộc** vào `test/isolation.test.mjs` (SQL thật, rồi thử
vượt ranh giới giữa hai tài khoản), shape vào `test/schema.test.mjs`, và suite mới
vào script `test` trong `package.json` hoặc nó không chạy trong CI.

## Vì sao không làm cách kia

- **Không DAG, không nhánh, không điều kiện.** Danh sách có thứ tự phủ đúng nhu
  cầu đã nêu. Một DAG là một sản phẩm riêng, và nó kéo theo trình soạn thảo đồ
  thị, phát hiện chu trình, và một ngôn ngữ điều kiện.
- **Không truyền kết quả giữa các bước bằng biến.** Transcript chung đã làm việc
  đó, và nó còn đọc được bằng mắt.
- **Không retry bước có tác dụng phụ.** Xem trên.
- **Không mở rộng `scheduled_tasks`.** Một task một-prompt và một workflow nhiều
  bước có vòng đời khác nhau; nhồi cả hai vào một bảng làm mọi truy vấn phải hỏi
  "cái này là loại nào".
- **Không thêm màn hình vào `public/js/app.js`.** Xem trên.

## Rủi ro đã biết

- Ngân sách 200s là một con số chọn theo trần 300s. Nếu một bước đơn lẻ vượt 200s
  thì nó vẫn có thể bị cắt giữa chừng — và khi đó cơ chế `unknown` là thứ giữ cho
  hệ thống trung thực, chứ không phải thứ ngăn được việc đó.
- Nhiều run của cùng một workflow chồng nhau bị chặn bằng lease chứ không bằng
  khoá logic; hai tiến trình cùng lúc là chuyện `SKIP LOCKED` xử lý, một tiến
  trình chết là chuyện `lease_until` xử lý.
