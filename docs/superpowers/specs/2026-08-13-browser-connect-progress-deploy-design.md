# Kết nối máy tính từ bản deploy, browser connect, và progress từng bước

Ngày: 2026-08-13

Ba mảng độc lập, chung một chủ đề: làm cho việc "AI điều khiển máy tính của tôi" hoạt động
được trên bản deploy, dùng đúng trình duyệt tôi muốn, và cho tôi nhìn thấy nó đang làm gì.

Ràng buộc xuyên suốt: **mọi tính năng phải đi qua đường worker + pairing**, scope theo
`user.id`. Không tính năng nào được dựa vào `usesInProcessTools()` — đường đó chỉ dành cho
admin trên một server chạy local (`server/localTools.js:21`), nên nếu dựa vào nó thì chỉ chủ
máy mới dùng được. Mỗi account pair máy của họ, token riêng, và không account nào nhìn thấy
máy của account khác.

---

## A. Bản deploy trên Vercel không kết nối được với máy tính

### Vấn đề

`npm start` chạy `scripts/launch.js`, vốn dựng **cả** server local **và** worker. Worker lấy
`SERVER_URL` mặc định là `http://localhost:5173` (`worker/index.js:31`). Nên:

1. Worker gọi `POST /api/pair/start` tới **server local**.
2. Mã pairing được ghi vào DB **local** (PGlite dưới `data/pgdata`).
3. Người dùng nhập mã đó vào app đang chạy trên Vercel, vốn dùng DB Neon.
4. `claimPairing` tra `sha256(code)` trong Neon, không thấy row nào, trả lỗi "code không hợp lệ".

Không có gì hỏng về mặt kỹ thuật — hai hệ thống chưa từng nói chuyện với nhau. Nhưng phần
hướng dẫn trong Settings (`public/index.html`, panel `worker`) ghi "clone this repo,
`npm install`, then `npm start`", mô tả đúng luồng chạy local và **sai** luồng deploy, mà lại
được hiển thị nguyên văn trên chính bản deploy. Người dùng làm đúng theo hướng dẫn và vẫn thất bại.

`npm run pair` có tồn tại (`launch.js --pair --no-server`) nhưng `--pair` **không được xử lý**
trong `launch.js` — chỉ `--no-server`, `--no-worker`, `--tunnel` được đọc. Và kể cả khi chạy,
nó vẫn trỏ vào localhost vì không có cách nào truyền URL vào.

### Thiết kế

**1. `scripts/launch.js` nhận địa chỉ server.**

- `--server <url>`, `--server=<url>`, hoặc một URL trần làm positional argument. Cả ba dạng,
  vì người ta gõ cả ba.
- Chỉ chấp nhận `http:`/`https:`. Bất kỳ thứ gì khác bị từ chối kèm câu giải thích, chứ không
  im lặng nối chuỗi thành một URL vô nghĩa rồi để `fetch` báo lỗi khó hiểu ba giây sau.
- URL được ghi vào `worker/.env` để lần chạy sau không phải nhập lại. Lời hứa của sản phẩm là
  "pair một lần rồi máy tính của bạn luôn ở đó"; bắt gõ lại URL mỗi lần khởi động là phá lời hứa đó.
- `--pair` hàm ý `--no-server`: nó có nghĩa "chỉ kết nối máy này vào một server khác", nên
  dựng thêm một web app local là thừa và gây nhầm lẫn về việc mã pairing thuộc về đâu.

**2. Đổi server thì bỏ token cũ.**

Một `WORKER_TOKEN` chỉ có giá trị trên đúng server đã cấp nó. Trỏ worker sang server khác mà
giữ token cũ sẽ cho HTTP 401, và worker hiện tại phản ứng bằng cách gọi `repair()` xin mã mới —
hành vi đúng, nhưng đi kèm dòng chữ "This computer is no longer paired", vốn sai và đáng sợ:
máy tính vẫn được pair, chỉ là với server khác.

Nên `worker/.env` ghi kèm `SERVER_URL` bên cạnh token, và khi URL được yêu cầu khác với URL đã
lưu, `launch.js` xoá token trước khi khởi động worker. Kết quả là một mã pairing mới, sạch sẽ,
kèm câu giải thích đúng.

**3. Server nói cho client biết địa chỉ công khai của chính nó.**

`/api/bootstrap` trả thêm:

- `publicUrl` — `PUBLIC_URL` nếu được đặt, ngược lại suy từ header của request
  (`x-forwarded-proto` + `host`). Client không thể tự suy được một cách đáng tin khi có proxy
  đứng trước.
- `serverless` — `isServerless()`, để giao diện biết nên hiện hướng dẫn nào.

**4. Panel Computers hiện đúng lệnh, kèm nút Copy.**

Thay `<ol class="steps">` cứng bằng khối do JS dựng:

- Trên bản deploy: `npm run connect -- <publicUrl>` — một dòng, copy được, đã có sẵn URL thật.
- Trên bản chạy local: giữ `npm start` như cũ, vì ở đó nó đúng.

Có `npm run connect` trong `package.json` trỏ tới `launch.js --pair`.

**5. Long-poll thích ứng, để bản deploy không tự đốt hạn mức.**

`GET /api/worker/jobs` giữ request mở 25 giây (`server/app.js:383`). Trên máy local đó là miễn
phí. Trên Vercel, một worker chạy 24/7 nghĩa là một serverless function chạy gần như liên tục:
khoảng 3.400 giờ function mỗi tháng, vượt xa hạn mức Hobby. Đây là vấn đề tôi phát hiện thêm
khi đọc code, không nằm trong yêu cầu ban đầu, nhưng nó biến "kết nối được" thành "kết nối được
đến khi hết hạn mức", nên nó thuộc về bản sửa này.

Thiết kế: server phân biệt **bận** và **rỗi** cho từng account.

- **Bận** — có job nào được tạo trong `ACTIVE_WINDOW_MS` (2 phút) gần đây: giữ 25 giây như cũ.
  Đây là lúc người dùng đang thực sự chờ, và độ trễ quan trọng hơn chi phí.
- **Rỗi**: trả lời ngay `{ job: null, sleepMs }`, worker ngủ đúng chừng đó rồi hỏi lại.

Đánh đổi, nói rõ: **tool call đầu tiên sau một quãng rỗi sẽ chậm thêm tối đa `sleepMs`.**
Các call sau đó không chậm, vì lúc đó account đã chuyển sang trạng thái bận. Với `sleepMs`
mặc định 4000, cái giá là tối đa 4 giây một lần cho lần đầu tiên, đổi lấy khoảng 85% thời gian
chạy function. Trên bản local, `sleepMs` là 0 và không có gì thay đổi.

`WORKER_IDLE_SLEEP_MS` cho phép chỉnh, kể cả về 0 để tắt hẳn hành vi này.

### Cách kiểm chứng

- `test/deploy.test.mjs` mở rộng: phân tích cờ của `launch.js` (ba dạng `--server`, URL sai
  giao thức bị từ chối, `--pair` kéo theo `--no-server`), và việc xoá token khi đổi server.
- `test/devices.test.mjs` mở rộng: `/api/worker/jobs` trả ngay kèm `sleepMs` khi rỗi, và giữ
  request khi vừa có job.
- `test/http.test.mjs`: `/api/bootstrap` trả `publicUrl` và `serverless`.

---

## B. Connect browser — dùng trình duyệt thật, và chọn được trình duyệt nào

### Vấn đề

`worker/browser.js` đang chạy đúng một chế độ: `chromium.launch()` rồi `browser.newContext()`
— một Chrome mới tinh với context trắng. Không cookie, không đăng nhập, không extension. Muốn
AI đọc Gmail của bạn thì nó phải đăng nhập lại từ đầu, mỗi lần.

### Thiết kế

Ba chế độ, chọn theo từng máy:

| Mode | Cơ chế | Dùng khi |
|---|---|---|
| `sandbox` | `chromium.launch()` + context mới. Y như hiện nay. | Mặc định. Việc gì không cần đăng nhập. |
| `profile` | `chromium.launchPersistentContext(dir, { channel: 'chrome' })` | Muốn đăng nhập **một lần** rồi nhớ mãi. |
| `attach` | `chromium.connectOverCDP(endpoint)` | Muốn AI điều khiển đúng Chrome bạn đang mở. |

**Vì sao `profile` dùng thư mục riêng chứ không phải profile Chrome của bạn.** Chrome khoá
thư mục `User Data` khi đang chạy. Trỏ Playwright vào đó trong lúc bạn đang mở Chrome sẽ hỏng
— không phải "đôi khi", mà là luôn luôn, và thông báo lỗi thì không nói gì về nguyên nhân. Nên
`profile` dùng `<DATA_DIR>/browser-profile`, một hồ sơ bền vững của riêng worker: bạn đăng nhập
vào đó một lần, qua chính panel xem trực tiếp, và nó nhớ mãi qua các lần khởi động lại. Đó là
95% giá trị của "dùng trình duyệt thật" mà không có 100% rủi ro hỏng profile chính của bạn.

**`attach` là thứ gần Claude in Chrome nhất.** Nó nối vào một Chrome đã chạy sẵn với
`--remote-debugging-port`, và điều khiển đúng những tab bạn đang mở, với đúng mọi đăng nhập
bạn đang có. Đổi lại, Chrome phải được khởi động kèm cờ đó. Worker dò `http://127.0.0.1:9222`
(và cổng cấu hình được) khi khởi động và khi mode đổi; nếu không thấy, giao diện nói rõ phải
làm gì thay vì chỉ hiện một lựa chọn bị vô hiệu hoá không giải thích.

**Ba điều bắt buộc phải đúng trong `attach`, nếu không nó sẽ phá Chrome của người dùng:**

1. **Không tạo context mới.** `browser.newContext()` trên một kết nối CDP tạo một context ẩn
   danh — mất sạch session, tức là mất chính thứ khiến người ta chọn chế độ này. Dùng
   `browser.contexts()[0]`.
2. **Không `context.close()` khi kết thúc.** Đó là các tab của người dùng. Chỉ ngắt kết nối.
3. **Không `browser.close()`.** Nó sẽ tắt Chrome của người dùng, kèm mọi thứ họ đang mở.

Với `profile`, persistent context vừa là browser vừa là context — `browser` là `null`. Mọi chỗ
trong `browser.js` đang kiểm tra `browser?.isConnected()` để quyết định "đã mở chưa"
(`tabs()`, `ensureContext()`) phải chuyển sang một vị từ duy nhất hiểu cả ba chế độ, nếu không
`profile` sẽ báo "không có tab nào" trong khi tab đang mở ngay đó.

**Truyền lựa chọn xuống máy.** Thêm cột `devices.browser_mode` bằng
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, đúng quy ước migration sẵn có của
`server/store/schema.sql`. Kênh xuống máy là phần trả lời của heartbeat, giống hệt cách
`workspace` đang đi (`server/app.js` heartbeat → `config`), nên không cần kết nối vào trong.
Worker áp dụng bằng cách đóng browser hiện tại; lần dùng tool tiếp theo mở lại ở chế độ mới.
Đổi chế độ giữa chừng mà giữ nguyên browser cũ sẽ là nói dối về việc đang chạy ở đâu.

**Máy báo lên có gì.** `workerInfo()` thêm `browsers`: các channel cài đặt được
(`chrome`/`msedge`), có endpoint CDP nào đang mở không, và hồ sơ bền vững đã tồn tại chưa. Dò
một lần khi khởi động và khi mode đổi — không phải mỗi 15 giây, vì mở socket dò cổng mỗi
heartbeat là lãng phí cho một câu trả lời gần như không bao giờ đổi.

**Giao diện.** Trong panel Computers, mỗi máy có một ô chọn "Trình duyệt" kèm một dòng nói rõ
chế độ đang chọn nghĩa là gì và nó có sẵn sàng không. Chọn `attach` khi không dò thấy CDP thì
hiện đúng câu lệnh khởi động Chrome kèm cờ, cho hệ điều hành của máy đó.

### Cách kiểm chứng

- `test/desktop.test.mjs` hoặc test mới: `browserMode` được chuẩn hoá, giá trị lạ bị từ chối,
  và `config.browserMode` xuất hiện trong phần trả lời heartbeat.
- `test/schema.test.mjs`: cột `browser_mode` tồn tại sau khi init.
- Việc launch/attach browser thật không được test tự động — nó cần một Chrome thật. Nói rõ
  điều này thay vì giả vờ có coverage.

---

## C. Progress từng bước

### Vấn đề

Mỗi tool call đã là một thẻ `<details>` có spinner → ✓/✗ (`public/js/render.js:386`). Hai
khoảng trống so với thứ người dùng muốn:

1. **Đọc như log máy.** Nhãn là tên tool thô (`browser_click`) cộng JSON tham số. Một lượt duyệt
   web mười bước là mười dòng như nhau, phải đọc kỹ mới biết chuyện gì xảy ra.
2. **Không có ảnh.** Worker đã chụp ảnh sau mỗi hành động (`pushStill`, `worker/browser.js:321`)
   nhưng ảnh đó chỉ chảy vào panel xem trực tiếp và biến mất. Cuộn lại lịch sử thì không còn gì.

### Thiết kế

**1. Nhãn thân thiện.** `summariseToolInput` được bổ sung một hàm `describeStep(name, input)`
trả về `{ verb, detail }` — "Mở trang" + `vercel.com`, "Bấm" + mô tả phần tử, "Chờ" + `3 giây`.
Đi qua `t()` như mọi chuỗi khác, nên tài khoản tiếng Việt đọc được tiếng Việt. Tool nào chưa có
mô tả riêng thì rơi về hành vi hiện tại, nên không tool nào bị vỡ giao diện vì chưa được thêm vào bảng.

**2. Gom nhóm.** Các tool call liên tiếp **cùng một họ** (`browser_*`, `desktop_*`) mà **không
có prose xen giữa** được gộp vào một thẻ: "Đã dùng trình duyệt · 8 bước", mở ra là danh sách
từng bước. Prose xen giữa thì cắt nhóm — đó là ranh giới tự nhiên giữa hai việc khác nhau, và
gộp qua nó sẽ nói dối về cấu trúc của lượt làm việc.

Đây là thay đổi thuần frontend. Không đổi protocol, không đổi DB.

**3. Thumbnail.** Tool browser trả về `{ output, shot }` với `shot` là JPEG base64 đã thu nhỏ
(bề ngang ~320px). Đường đi:

```
worker/browser.js  →  { output, shot }
server/tools/execute.js  →  saveGenerated(...)  →  { content, shot: { id } }
server/agent.js  →  ...(shot ? { shot } : {})       (y hệt cách `file` và `widget` đã đi)
public/js/render.js  →  <img> trong bước, bấm mở viewer
```

Lưu qua bảng `attachments` bằng `saveGenerated()`, và **tham chiếu bằng id** — không nhồi
base64 vào cột result của `messages`. Một cuộc hội thoại duyệt web dài sẽ làm phình vài MB
trong Neon free tier nếu làm cách kia, và lịch sử hội thoại là thứ được đọc lại nhiều nhất.

Giới hạn, để một lượt chạy dài không âm thầm ăn hết dung lượng:

- Chỉ tool browser/desktop mới đính ảnh.
- Tối đa 12 ảnh mỗi lượt; sau đó bỏ qua, im lặng — thiếu một ảnh minh hoạ không đáng làm hỏng
  một tool call đang chạy.
- Mỗi ảnh không quá 40KB sau khi nén.

### Cách kiểm chứng

- `test/ui.test.mjs`: gom nhóm cắt đúng chỗ khi có prose xen giữa; nhãn rơi về mặc định cho
  tool lạ.
- `test/i18n.test.mjs`: mọi khoá nhãn mới đều có cả `en` và `vi`.
- `test/attachments.test.mjs`: ảnh được lưu qua `saveGenerated` với đúng `kind`, và giới hạn
  số ảnh mỗi lượt được tôn trọng.

---

## Những gì cố tình **không** làm

- **Chrome extension MV3.** Đó là cách Claude in Chrome hoạt động thật, và nó cho phép điều
  khiển Chrome mà không cần cờ debug. Cái giá là một extension phải build, phải cài dev-mode,
  cộng một cầu messaging — nhiều việc hơn hẳn, đổi lấy phần tăng thêm mỏng so với `attach`.
- **Panel Progress cố định bên phải.** Đã cân nhắc và bỏ: dòng chat đã có đủ chỗ, và thêm một
  cột nữa sẽ ép layout trên điện thoại, vốn là thiết bị chính của sản phẩm này.
- **Icon riêng cho từng loại hành động.** Nhãn thân thiện đã giải quyết vấn đề "liếc là hiểu".

## Rủi ro đã biết

- **`attach` phụ thuộc vào việc người dùng khởi động Chrome kèm cờ.** Không có cách nào vòng
  qua mà không viết extension. Giao diện phải nói thẳng điều đó chứ không để người ta tự đoán.
- **Long-poll thích ứng thêm độ trễ cho tool call đầu tiên sau quãng rỗi.** Đã nêu con số cụ
  thể ở phần A và cho phép tắt.
- **Hồ sơ bền vững ở chế độ `profile` chứa cookie đăng nhập thật, nằm trên đĩa của máy worker.**
  Cùng mức nhạy cảm với profile Chrome bình thường, nhưng nó là một thư mục **mới** mà người
  dùng không biết mình đang tạo ra. Cần nói rõ trong giao diện, và cần có nút xoá.
