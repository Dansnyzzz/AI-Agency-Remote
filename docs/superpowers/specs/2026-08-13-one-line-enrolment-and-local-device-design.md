# Một dòng lệnh, tự khởi động, và máy đang ngồi là máy đang dùng

Ngày: 2026-08-13

Ba thay đổi để "máy tính của tôi luôn sẵn ở đó" đúng nghĩa, trên một sản phẩm
**công khai cho người dùng toàn cầu** — điều này quyết định phần lớn thiết kế bên dưới.

Trạng thái hiện tại, sau bản trước: thêm một máy là clone repo, `npm install`,
`npm run connect -- <url>`, đọc mã 8 ký tự, gõ vào web. Sau khi khởi động lại máy thì
phải chạy lại lệnh. Và với hai máy cùng online, trợ lý chọn máy có heartbeat gần nhất —
không phải máy bạn đang ngồi trước.

---

## Ràng buộc không thể vòng qua

**Trang web không thể khởi động chương trình trên máy người dùng.** Đó là tính chất bảo
mật của trình duyệt, không phải thiếu sót cần khắc phục. Nên "mở web là máy tự nối" bắt
buộc phải có sẵn thứ gì đó đang chạy trên máy đó — và đó chính là lý do phần 2 tồn tại.

Cái *có thể* xoá bỏ là: gõ lệnh dài, gõ mã pairing, và chạy lại sau mỗi lần khởi động.

---

## A. Ghi danh bằng một dòng lệnh

### Thiết kế

Nút **"Thêm máy tính này"** trong app sinh một dòng lệnh kèm **enrolment token** — do
server cấp cho đúng tài khoản đang đăng nhập, dùng một lần, sống 10 phút:

```powershell
$env:AIR_TOKEN='<token>'; irm https://<app>/setup.ps1 | iex
```

Script tự làm: kiểm tra Node ≥ 20 → tải mã nguồn → `npm install` → ghi `SERVER_URL` →
**đổi token lấy device token** → đăng ký tự khởi động → chạy worker.

**Token đi qua biến môi trường, không nhúng vào thân script.** Nếu nội dung script được
ghép chuỗi từ tham số rồi `iex`, mọi ký tự trong tham số đó là mã sẽ chạy. Biến môi
trường không có đường trở thành mã.

### Đảo chiều pairing, và cái giá của nó

Luồng cũ an toàn **nhờ chính chiều của nó**: máy hiện mã, người đã đăng nhập vào tài khoản
*của mình* gõ mã vào. Không ai lừa được bạn gõ mã của họ, vì mã đi hướng ngược lại.

Đảo chiều mở ra một hướng tấn công có thật, và trên sản phẩm công khai thì nó đáng kể:

> Kẻ tấn công đăng ký một tài khoản trên chính deployment này, lấy dòng lệnh cài đặt của
> **họ**, gửi cho nạn nhân kèm một lý do nghe hợp lý. Nạn nhân dán. Máy nạn nhân giờ thuộc
> tài khoản kẻ tấn công — shell, toàn bộ ổ đĩa, điều khiển màn hình.

Đây là mô hình phát tán mã độc tiêu chuẩn, và không có gì trong luồng cũ cho phép nó.

**Xử lý: trình cài đặt phải nói rõ nó sắp trao máy này cho ai, và bắt gõ YES.**

```
  This will give  someone@example.com  full access to this computer:
  its files, a shell, and control of your screen.

  Continue only if that is your own account.
  Type YES to continue:
```

Nạn nhân vẫn có thể gõ YES — nhưng khi đó đó là một quyết định có thông tin, không phải
một lần dán trông vô hại. Cùng cách Tailscale và TeamViewer dùng, và cùng lý do.

Với chủ tài khoản thật, cái giá là **một lần gõ, một lần cho mỗi máy mới** — vẫn ít hơn
hẳn so với đọc và gõ mã 8 ký tự.

### API

Dùng lại bảng `pairings` sẵn có, chỉ đảo chiều dòng chảy.

| | |
|---|---|
| `POST /api/devices/enrolment` | Cần session. Tạo token, trả `{ token, expiresInSec, command }`. Ghi một dòng `pairings` với `code_hash = sha256(token)`, `user_id` = tài khoản, `expires_at` = +10 phút. |
| `POST /api/pair/enrol` | Không cần session — token *là* thứ xác thực. Không có `confirm`: trả `{ account }` và **không tiêu thụ dòng nào**, để trình cài đặt hiện email lên hỏi. Có `confirm: true`: tiêu thụ dòng đó, tạo device, trả device token. |
| `GET /setup.ps1`, `GET /setup.sh` | Script cài đặt, phục vụ từ chính origin của app. Nội dung tĩnh — không có phần nào do người dùng điều khiển. |

Cả hai endpoint pair đều đi qua rate limit sẵn có (`rateLimit('pair')`), vì cả hai đều
không cần session.

Token là bí mật nằm trong một dòng lệnh người dùng dán, mà lịch sử shell có ghi lại. Cùng
mức nhạy cảm với mã pairing, chỉ là cửa sổ dài hơn — nên vẫn 10 phút và vẫn dùng một lần.

---

## B. Tự khởi động, chạy ẩn

`scripts/autostart.js` với `--install`, `--uninstall`, `--status`.

| Nền tảng | Cách làm | Trạng thái |
|---|---|---|
| Windows | Task Scheduler *At log on*, chạy qua một shim `.vbs` để không hiện cửa sổ console | Viết và **thử thật** |
| macOS | LaunchAgent plist trong `~/Library/LaunchAgents` | Viết, **không thử được** |
| Linux | systemd user unit trong `~/.config/systemd/user` | Viết, **không thử được** |

Hai dòng cuối được nói rõ là chưa chạy thật, ở đây và trong README. Một dấu tích cho nhánh
code chưa từng chạy còn tệ hơn một khoảng trống được thừa nhận.

**Vì sao là "at log on" chứ không phải service.** Một service chạy ở session 0, nơi không
có desktop nào cả — các tool `desktop_*` sẽ không thao tác được gì. Cùng lý do đã ghi trong
README ở mục máy ảo luôn bật.

Gỡ cài phải dễ ngang cài. Một thứ tự khởi động cùng máy mà không nói được cách tắt là một
thứ người ta sẽ gỡ bằng cách xoá cả thư mục.

---

## C. Máy đang mở web là máy đang dùng

### Vấn đề

`workerStatus` chọn `prefs.activeDevice` nếu có, không thì máy có `last_seen` gần nhất
(`server/localTools.js:87`). Với hai máy cùng online, "gần nhất" là ngẫu nhiên đối với
người dùng: bạn ngồi ở laptop, gõ "mở file này", và nó mở trên máy để ở nhà.

### Trình duyệt biết nó đang ở máy nào bằng cách nào

Worker mở một cổng loopback trả về đúng một thứ:

```
GET http://127.0.0.1:8765/whoami  →  { deviceId, name }
```

Ba ràng buộc, mỗi cái đóng một lỗ:

- **Chỉ nghe `127.0.0.1`**, không phải `0.0.0.0`. Máy khác trong mạng LAN không hỏi được.
- **Không nhận lệnh.** Chỉ một route, chỉ GET, chỉ trả định danh. Không có gì để lạm dụng
  kể cả khi ai đó gọi được.
- **`Access-Control-Allow-Origin` chỉ đúng `SERVER_URL` của worker.** Nếu để `*` thì mọi
  trang web trên internet đều dò được bạn đang chạy AI Remote và máy tên gì — một vectơ
  fingerprint được tặng không.

Kèm `Access-Control-Allow-Private-Network: true` cho preflight, vì Chrome chặn request từ
trang công khai vào loopback nếu thiếu.

Nếu trình duyệt vẫn chặn, hoặc worker không chạy: **không đoán bừa**, rơi về hành vi cũ.

### Không lưu vào prefs — và đây là điểm quan trọng

Ý ban đầu là ghi máy tìm được vào `prefs.activeDevice`. Sai, và sai theo cách chỉ lộ ra khi
dùng thật: `prefs` thuộc về **tài khoản**, không thuộc về trình duyệt. Mở web trên cả hai
máy cùng lúc thì trang ở máy 1 ghi đè thành máy 1, trang ở máy 2 ghi đè lại thành máy 2, và
cứ thế — hai tab đánh nhau, cả hai đều sai một nửa thời gian.

Thay vào đó trình duyệt gửi kèm **`deviceHint` theo từng lượt chat**. Không trạng thái toàn
cục, không có gì để đánh nhau, và mỗi tab đúng với chỗ nó đang đứng.

Đường đi: client → `POST /api/chats/:id/run` → `runAgent({ deviceHint })` → `executeTool` →
`runViaWorker` → `workerStatus(user, prefs, hint)`.

### Thứ tự ưu tiên

1. **Bạn đã bấm "Work on this one"** — tôn trọng cho đến khi bạn bấm *"Dùng máy tôi đang ngồi"*.
   Một lựa chọn tường minh bị phần mềm âm thầm ghi đè là lỗi tệ hơn hẳn việc chọn nhầm máy.
2. **`deviceHint`** — máy đang mở web, nếu nó thuộc tài khoản này và đang online.
3. **Máy có heartbeat gần nhất** — như hiện tại.

Server **luôn** kiểm tra device được gợi ý thuộc tài khoản đang đăng nhập. `deviceHint` đến
từ trình duyệt, và mọi thứ đến từ trình duyệt đều là thứ ai đó có thể tự gõ ra.

---

## Cách kiểm chứng

- `test/devices.test.mjs` — enrolment: token cấp cho đúng account; gọi không `confirm` trả
  email mà **không** tiêu thụ; có `confirm` thì tiêu thụ và cấp device token; token dùng lần
  hai bị từ chối; token hết hạn bị từ chối; token của account khác không chạm được máy này.
- `test/devices.test.mjs` — thứ tự ưu tiên: pin thắng hint, hint thắng "gần nhất", hint của
  device thuộc account khác bị bỏ qua.
- `test/deploy.test.mjs` — `/setup.ps1` và `/setup.sh` phục vụ được, không cần session, và
  **không** chứa phần nào ghép từ tham số.
- `test/launcher.test.mjs` — autostart: sinh đúng lệnh `schtasks`, shim `.vbs` là ASCII,
  `--status` đọc lại được thứ `--install` đã tạo. Chạy thật trên Windows; macOS/Linux chỉ
  kiểm tra nội dung tệp sinh ra, và nói rõ là chưa chạy thật.
- Cổng loopback: kiểm tra chỉ bind `127.0.0.1`, chỉ có một route, và CORS từ chối origin lạ.

## Rủi ro đã biết

- **Enrolment token trong lịch sử shell.** Giảm bằng TTL 10 phút và dùng một lần; không xoá
  bỏ được hoàn toàn.
- **Chrome có thể siết thêm Private Network Access.** Nếu loopback bị chặn, phần C mất tác
  dụng và app rơi về hành vi cũ — không hỏng, chỉ kém thông minh hơn.
- **Autostart trên macOS và Linux chưa chạy thật.**
