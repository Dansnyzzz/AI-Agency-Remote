# Chế độ Auto chọn model + nút gạt vision

Ngày: 2026-08-31

Việc thứ hai trong ba. Cho người dùng không biết model nào mạnh: một lựa chọn
"Auto" tự chọn model **free** tốt nhất, kèm nút gạt ưu tiên model đọc được ảnh.

## Vấn đề cốt lõi: "mạnh nhất" không có trong metadata

Model có metadata về context, giá, vision — không có "độ thông minh". Một
heuristic kiểu "context lớn nhất" sẽ tự tin chọn model to nhưng dở. Nên "tốt
nhất" là một **thứ tự family curated** (deepseek trước, như người dùng chỉ ra),
và trong một family thì mới nhất + context lớn nhất. Thứ tự duy trì bằng tay vì
đó là chỗ trung thực cho một phán đoán chất lượng. Model free thay đổi liên tục
nên **không hardcode một model cụ thể** — chỉ hardcode thứ tự family.

## Kiến trúc

**`server/autoPick.js`** (mới):
- `AUTO_ID = 'auto'`, `isAuto(id)`.
- `FAMILY_PRIORITY` — deepseek, qwen, meta, mistral, google, xai, ... Family
  không có trong list vẫn được dùng, chỉ xếp sau mọi family đã liệt kê.
- `pickAutoModel(userId, { vision })`:
  1. Lấy model free từ thư viện.
  2. **Provider khả dụng** = `getApiKeys(userId, provider)` trả ≥1 key. Vì
     `getApiKeys` (việc A) đã loại key đang nghỉ, một model chỉ bị bỏ khi **mọi**
     key của provider đó đều cooldown — người xếp nhiều key fallback được tiêu
     hết trước khi model biến mất. Tra một lần mỗi provider.
  3. Lọc vision nếu bật.
  4. Xếp theo family rank → mới nhất → context. Trả model đầu, hoặc `null`.

**`server/agent.js`** — resolve `auto` mỗi lượt (vì "tốt nhất" đổi khi refresh
hoặc cooldown thay đổi). `messages` được load trước resolve để biết lượt có ảnh.
Vision hiệu dụng = `autoVision || hasImages` — lượt có ảnh tự nâng vision, vì
model không đọc được ảnh thì đang trả lời nửa tin nhắn. `null` → dừng lượt với
thông báo rõ, **không** tự dùng model trả phí. Model đã chọn được nói ra qua một
`status` notice, nên lựa chọn không bao giờ vô hình.

**`server/settings.js`** — `DEFAULT_PREFS.autoVision = false`; `setPrefs` ép
boolean.

**Frontend** — card "Auto" đầu picker (id `auto`, đi qua cùng click handler);
chip topbar hiện "Auto"; `refreshModelFacts` không resolve `auto` (không phải id
thật) mà đặt free=true, vision=true; nút gạt vision trong Settings → Behaviour
theo đúng pattern `auto-compact`/`auto-preview` (chuỗi English tĩnh như chúng,
nên không đụng i18n).

## Vì sao không làm cách kia

- **Không heuristic thuần metadata** — "mạnh" không suy được từ context/giá.
- **Không hardcode model cụ thể** — model free đổi tên/gỡ liên tục.
- **Không tự dùng paid khi hết free** — người chọn Auto (free) để không tốn
  tiền; âm thầm tiêu tiền là phản bội lựa chọn đó.
- **Không tôn trọng vision toggle một cách mù quáng** — lượt có ảnh mà chọn model
  không đọc ảnh thì vô nghĩa, nên ảnh tự nâng vision cho lượt đó.

## Kiểm thử

`test/autopick.test.mjs`: thứ tự family + mới nhất; lọc vision; **một key nghỉ
không bỏ model, mọi key nghỉ mới bỏ**; provider không key bị bỏ qua; không key
hoặc không free → `null`. Backend nối vào agent kiểm qua `test/agent.test.mjs`
vẫn xanh.

## Cần xác nhận thị giác

Frontend (card Auto, chip, nút gạt) không chạy được trong harness không-DOM,
nên cần chạy app thật để xác nhận hiển thị — như bug `<br>` chỉ hiện khi chạy
thật. Logic và lint đã qua; hình thức cần mắt người.
