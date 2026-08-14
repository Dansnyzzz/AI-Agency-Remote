# Mỗi hội thoại một trình duyệt riêng

Ngày: 2026-08-13

## Vấn đề

`worker/browser.js` giữ đúng một trình duyệt cho cả máy — `browser`, `context`, `page`,
`screencast` đều là biến ở cấp module. Hệ quả không hiện ra khi chỉ có một cuộc hội thoại,
và hiện ra ngay khi có hai:

- Tab mở trong hội thoại A xuất hiện trong `browser_tabs` của hội thoại B.
- Đăng nhập ở A thì B cũng đăng nhập — cùng cookie, cùng `localStorage`.
- `browser_close` ở một bên đóng luôn trình duyệt của bên kia.

Với một sản phẩm dùng chung một máy cho nhiều luồng việc, đó là rò rỉ trạng thái giữa những
việc lẽ ra không liên quan.

`chatId` đã có sẵn trong mỗi job (`store.claimJob` trả `{ id, chatId, tool, input }`) — chỉ là
nó chưa từng được truyền xuống tool.

## Cách ly bằng gì

**Một tiến trình Chrome, mỗi hội thoại một `BrowserContext`.** Một context có cookie,
`localStorage` và tab của riêng nó — đúng thứ một cửa sổ ẩn danh có — và tốn khoảng 20–50MB
thay vì ~250MB cho một tiến trình Chrome đầy đủ. Năm hội thoại là ~150MB thay vì hơn 1GB trên
máy của người dùng.

Đánh đổi được chấp nhận: chung một tiến trình nên tiến trình chết thì mọi hội thoại mất
trình duyệt cùng lúc. Đổi lại là thứ người ta thực sự cần — cách ly *phiên*, không phải cách
ly *sự cố*.

## Chỉ `sandbox` mới tách, và đó là điều đúng

| Chế độ | Tách theo hội thoại? | Vì sao |
|---|---|---|
| `sandbox` | **Có** | Nó vốn là thứ dùng xong bỏ. Không có gì để mất khi mỗi hội thoại một cái. |
| `profile` | Không | Nó bọc **một** hồ sơ đã đăng nhập nằm trên đĩa, và Chrome khoá thư mục đó. Tách thành nhiều hồ sơ sẽ phá đúng lý do nó tồn tại: đăng nhập một lần, nhớ mãi. |
| `attach` | Không | Nó bọc **một** Chrome thật của người dùng. Không có gì để tách. |

Quy tắc, nói thành một câu: *sandbox là loại dùng xong bỏ nên mỗi hội thoại một cái; profile
và attach vốn là số ít vì chúng bọc một danh tính có thật.*

## Khoá phiên

```
sandbox  →  chatId, hoặc 'shared' khi chatId là null
khác     →  'single'
```

`chatId` là null với sub-agent (`executeTool({ chatId: null })` trong `subagents.js`). Chúng
dùng chung ngăn `'shared'` thay vì mỗi cái một context — một sub-agent là một phần của công
việc đang chạy, không phải một cuộc hội thoại riêng.

## Vì sao không hoán đổi biến toàn cục

Cách rẻ nhất trông có vẻ là giữ nguyên các biến ở cấp module rồi tráo chúng theo `chatId`
trước mỗi lệnh. **Sai, và sai theo cách chỉ hỏng khi có tải.** Worker chạy tới
`MAX_CONCURRENT_JOBS = 4` job song song, nên `browser_click` của hội thoại A có thể chạy xen
giữa lúc `browser_open` của B vừa tráo biến — A bấm vào trang của B.

Dùng một khoá toàn cục để tuần tự hoá cũng không được: `browser_wait 30` ở A sẽ chặn B suốt
ba mươi giây, và đó đúng là loại đứng hình không ai lần ra được.

Nên trạng thái phiên là tham số truyền tường minh. Nhiều chỗ phải sửa hơn, nhưng không có
đường tắt nào an toàn.

## Giới hạn, vì nếu không thì đây là quả bom bộ nhớ

- **Tối đa 6 context.** Quá thì đóng cái lâu nhất không dùng đến.
- **Rảnh 10 phút thì đóng.** Không có nó, một hội thoại duyệt web hồi sáng sẽ giữ tab của nó
  cả ngày.

Cả hai đều là phần của tính năng, không phải tinh chỉnh để sau: thứ mở trình duyệt theo hội
thoại mà không bao giờ đóng là thứ ăn hết RAM máy người dùng trong một buổi chiều.

## Màn hình xem trực tiếp

Chỉ có một khung xem, nên chỉ một phiên được phát hình tại một thời điểm: phiên vừa thao tác
gần nhất. `screen.js` đã có `claim()` để chuyển quyền, nên cơ chế sẵn có được dùng lại chứ
không dựng thêm.

## Thay đổi

1. `worker/index.js` — `runJob` gọi `impl(job.input, { chatId: job.chatId })`.
2. `server/localTools.js` / `server/tools/execute.js` — đường in-process truyền `{ chatId }`
   giống hệt, nếu không thì máy chạy local sẽ có hành vi khác máy được pair.
3. `worker/browser.js` — thay bốn biến toàn cục bằng `Map` các phiên; mọi hàm nhận phiên làm
   tham số.

Tool nào không quan tâm đến `chatId` thì bỏ qua tham số thứ hai, nên không có implementation
nào khác phải sửa.

## Cách kiểm chứng

- Hai `chatId` khác nhau nhận hai context khác nhau; cùng `chatId` nhận lại đúng cái cũ.
- `browser_tabs` của hội thoại A không thấy tab của B — chạy thật, với hai chat mở hai trang.
- Cookie đặt ở A không đọc được ở B.
- `profile` và `attach` trả cùng một phiên bất kể `chatId`.
- Mở context thứ bảy thì cái lâu nhất không dùng bị đóng.
- `chatId` null gộp vào một ngăn duy nhất.

## Rủi ro đã biết

- **Cách ly phiên, không cách ly sự cố.** Chrome chết là mọi hội thoại mất trình duyệt.
- **Đóng theo thời gian rảnh sẽ làm mất tab của một hội thoại đang bị bỏ dở.** Đó là đánh đổi
  có chủ ý; lần dùng sau mở lại context mới và sạch.
