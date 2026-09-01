# Cột sống tự chủ cho `.claude/`

Ngày: 2026-09-01

Pha 1 của hai. Mục tiêu: chạy được một mạch dài — plan → build → test → review →
commit — mà không phải hỏi từng bước, **và vẫn đáng tin**. Pha 2 (nâng cấp chính
sản phẩm AI Remote) sẽ dùng chính bộ đồ nghề này.

## Vấn đề cốt lõi: tự chủ không chết vì thiếu quyền, nó chết vì thiếu bằng chứng và thiếu trí nhớ

Bộ `.claude/` hiện tại mạnh ở phòng thủ (ba hook chặn thao tác phá huỷ, có test
riêng) nhưng trống ở chỗ duy trì một mạch dài. Bốn lỗ hổng, xếp theo mức độ giết
mạch:

1. **Không có `Stop` hook.** CLAUDE.md §5 (Definition of Done) và §10 ("đừng
   tuyên bố 100% không lỗi") hiện chỉ là văn bản. §2 của chính nó nói rằng một
   rủi ro có thể xảy ra bất kỳ lúc nào thì phải ép bằng code, không phải ghi vào
   prompt. Tuyên bố "xong" khi chưa chạy test là đúng loại rủi ro đó.
2. **Không có `PreCompact`/`PostCompact`.** Đây là điểm chết thật sự. Mạch dài
   luôn bị nén context; cái mất đi trước nhất là **chỉ thị gốc của người dùng**
   và trạng thái kế hoạch. Sau nén, agent đi tiếp bằng trí nhớ mờ và tự tin.
3. **Không có `SessionStart`.** Mỗi phiên bắt đầu mù: nhánh nào, cây bẩn ra sao,
   lần cuối cổng chất lượng xanh là khi nào.
4. **Allowlist quá hẹp, và `main` không được bảo vệ.** Mỗi commit là một lần
   dừng hỏi — tự chủ chết ngay đó. Đồng thời chưa có gì bằng code ngăn commit
   thẳng vào `main`.

## Nền tảng đã xác minh, không phải giả định

Hook API được đọc trực tiếp từ binary Claude Code 2.1.251
(`resources/native-binary/claude.exe`), không lấy từ trí nhớ. Build này hỗ trợ
**22 hook event** — nhiều hơn danh sách trong CLAUDE.md §2. Các trường mà thiết
kế này phụ thuộc, đã xác minh có thật:

| Event | Input | Output |
|---|---|---|
| `Stop` | `stop_hook_active`, **`last_assistant_message`** | `additionalContext` |
| `SubagentStop` | `stop_hook_active`, `agent_type`, `agent_id`, `agent_transcript_path`, `last_assistant_message` | `additionalContext` |
| `PreCompact` | `trigger` (manual/auto), `custom_instructions`, `transcript_path` | — |
| `PostCompact` | `trigger`, **`compact_summary`** | `additionalContext` |
| `SessionStart` | `source` (startup/resume/clear/compact/**fork**), `model` | `additionalContext`, `sessionTitle`, `watchPaths`, `reloadSkills` |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `error`, `is_interrupt`, `duration_ms` | `additionalContext` |

`last_assistant_message` là mảnh ghép quyết định: nó cho hook đọc đúng câu vừa
tuyên bố, nên §10 chuyển được từ lời khuyên thành thứ ép được.

Có một trần chặn liên tiếp phía harness (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) —
mọi hook `Stop`/`SubagentStop` phải thoát 0 ngay khi `stop_hook_active` là true,
nếu không lượt bị ép kết thúc và hook thành vô dụng.

## Kiến trúc: một sổ cái bằng chứng

`.claude/state/` (gitignored) là trục. Ghi vào từ ba nguồn, đọc ra ở ba chỗ:

```
Edit/Write ──PostToolUse──▶ gate.json .pending[]     file đã đổi, chưa được chứng minh
npm run gate ─────────────▶ gate.json .lastGreen     do CHÍNH tiến trình chạy test đóng dấu
                                  │
Stop ─────────────────────────────┴──▶ có claim "xong" + còn pending ⇒ CHẶN
PreCompact ──▶ journal.md ──┬── PostCompact ──▶ additionalContext
                            └── SessionStart ─▶ additionalContext
```

**Nguyên tắc chống tự lừa:** dấu xanh chỉ được đóng bởi tiến trình *thực sự*
chạy test. `npm run gate` = `node .claude/hooks/gate.js run` — nó tự spawn
lint/test/hooks, tự đọc exit code, tự đóng dấu. Không có đường nào đóng dấu mà
không chạy. Không parse output của người khác rồi suy đoán "chắc là pass".

**Dấu xanh tự hết hạn.** Nó gắn với `git rev-parse HEAD` cộng hash danh sách file
bẩn. Một commit mới hoặc một lần sửa mới làm dấu cũ vô hiệu ngay, không cần ai
xoá. Đây là lý do sổ cái không cần logic hết hạn theo thời gian.

## Các thành phần

### 1. `hooks/gate.js` — sổ cái + trình chạy cổng

CLI ba lệnh:

- `run` — chạy `npm run lint`, `npm test`, `npm run test:hooks` tuần tự; đóng dấu
  `lastGreen` **chỉ khi** cả ba exit 0. Cờ `--fast` chạy lint + test:hooks thôi
  (vài giây) cho vòng lặp ngắn; dấu ghi rõ `scope: "fast"` và **không** thoả mãn
  `Stop` cho một claim hoàn thành.
- `status` — in JSON trạng thái (pending, lastGreen, còn hiệu lực hay không).
- `note <file>` — ghi một file vào pending.

Thêm `"gate": "node .claude/hooks/gate.js run"` vào `package.json` scripts.

`gate.json` hình dạng:

```json
{
  "pending": [{ "file": "server/agent.js", "at": "2026-09-01T…" }],
  "lastGreen": { "at": "…", "head": "1cf9a9e…", "dirty": "sha256…", "scope": "full" }
}
```

### 2. `hooks/ledger.js` — `PostToolUse` · Edit|Write

Ghi file vừa sửa vào `pending`. Tách khỏi `lint-changed.js` để mỗi hook giữ đúng
một việc. Bỏ qua file không phải nguồn (markdown, `.claude/state/**`) — một lần
sửa README không nên đòi chạy 24 suite.

### 3. `hooks/verify-stop.js` — `Stop` và `SubagentStop`

Chặn **chỉ khi cả hai** đúng:

- (a) còn `pending` sau dấu xanh cuối, **và**
- (b) `last_assistant_message` chứa tuyên bố hoàn thành.

Không claim thì không chặn — hỏi đáp, khảo sát, giải thích đều không bị cản. Khi
không chặn mà vẫn còn pending, trả `additionalContext` nhắc tên file chưa được
chứng minh: nhắc, không phải tường.

Bộ nhận diện claim bắt **cả tiếng Việt lẫn tiếng Anh** — repo này làm việc bằng
tiếng Việt: *xong, hoàn thành, đã sửa, đã test, chạy test rồi, all tests pass,
done, ready to merge, fixed*. Danh sách sẽ sai theo cả hai hướng và điều đó chấp
nhận được: bắt nhầm thì tốn một lần chạy `npm run gate`, bỏ sót thì mất một lần
chặn. Không có cái nào đắt.

`SubagentStop` dùng cùng script, cùng logic, có `agent_type` trong thông báo —
một subagent tuyên bố "đã viết test và pass" mà không chạy là cùng một lỗi.

Thoát 0 vô điều kiện khi `stop_hook_active`.

### 4. `hooks/journal.js` — `PreCompact`

Trước khi nén, trích từ `transcript_path` (JSONL) và ghi `.claude/state/journal.md`:

- **chỉ thị gốc của người dùng** (mọi user message, cắt độ dài) — thứ đắt nhất bị mất
- trạng thái `TodoWrite` cuối cùng
- file đã đổi trong phiên (từ sổ cái), nhánh, 5 commit gần nhất
- `trigger` và `custom_instructions`

Có trần kích thước (~8 KB) để bản thân journal không thành thứ làm đầy context.

### 5. `hooks/brief.js` — `SessionStart` + `PostCompact`

Trả `additionalContext`: nhánh hiện tại, cây bẩn, dấu xanh cuối còn hiệu lực
không, và journal nếu có. Với `PostCompact` (hoặc `SessionStart` nguồn `compact`)
nó ghép cùng `compact_summary` — bản tóm tắt của harness nói *đã làm gì*, journal
nói *được yêu cầu làm gì*, và cái sau mới là cái hay mất.

`SessionStart` cũng đặt `sessionTitle` theo nhánh, để nhiều phiên song song phân
biệt được.

### 6. `hooks/recover.js` — `PostToolUseFailure`

Khi một tool lỗi, trả `additionalContext` là gợi ý phục hồi **cụ thể cho repo
này**, tra theo dấu hiệu trong `error`: cổng đang bận, Postgres cục bộ chưa chạy
(`npm run db:init`), Playwright thiếu browser, `ENCRYPTION_KEY` thiếu, lệnh bị
hook chặn. Không mục nào khớp thì im lặng (thoát 0, không context) — một hook nói
bừa vào mọi lỗi còn tệ hơn không có.

### 7. `guard-bash.js` mở rộng — ép ranh giới đã chọn

Thêm ba luật, ép đúng ranh giới người dùng đặt ra (sửa + test + commit trên nhánh
riêng; không tự merge, không tự push, không tự deploy):

- `git commit` khi HEAD ở `main`/`master` → chặn, bảo tạo nhánh trước.
- `git merge` khi HEAD ở `main`/`master` → chặn.
- `git push` lên `main`/`master` → chặn.

Push nhánh khác **không** bị chặn nhưng cũng **không** vào allowlist → vẫn hỏi
người dùng. Nhánh hiện tại đọc bằng `git rev-parse --abbrev-ref HEAD`; đọc lỗi
thì fail open, như mọi guard khác ở đây.

### 8. `commands/ship.md` — mạch nối cả vòng

Explore → Plan → TDD build → `qa-tester` → `code-reviewer` → `npm run gate` →
commit từng bước trên nhánh feature. Dừng hỏi ở đúng hai điểm: sau Plan, và khi
gate đỏ hai lần liên tiếp cho cùng một nguyên nhân.

### 9. Permissions

Thêm vào allowlist: `git add`, `git commit`, `git checkout -b`, `git switch -c`,
`git branch`, `git stash`, `npm run gate`, `node .claude/hooks/gate.js *`.
**Không** thêm: `git push`, `git merge`, `vercel`.

## Kiểm thử

Mọi hook mới vào `hooks/hooks.test.mjs` — chuẩn repo đã tự đặt ra, và
`npm run check` đã gọi `test:hooks` nên chúng chặn merge sẵn. Ca bắt buộc:

- Stop **không** chặn khi không có claim hoàn thành
- Stop chặn khi có claim và còn pending
- Stop thoát 0 khi `stop_hook_active` (sai chỗ này thì lượt bị ép kết thúc)
- dấu xanh mất hiệu lực sau khi HEAD đổi
- dấu `--fast` không thoả mãn một claim hoàn thành
- guard chặn `git commit` trên `main`, **không** chặn trên nhánh feature
- guard vẫn cho `git push --force-with-lease` trên nhánh feature (hồi quy của lỗi
  `\b` đã từng có)
- `journal.js` chịu được transcript rỗng hoặc hỏng
- mọi hook fail open khi stdin là rác

Test phải chạy sổ cái trong thư mục tạm, không đụng `.claude/state/` thật.

## Vì sao không làm cách kia

- **Không cho `Stop` tự chạy `npm test`.** 24 suite mất vài phút; một hook treo
  lượt vài phút mỗi lần kết thúc sẽ bị tắt trong một tuần, và khi đó nó không bảo
  vệ gì cả — đúng lập luận `.claude/README.md` đã dùng cho các guard hiện có.
- **Không đóng dấu xanh bằng cách đọc output của `npm test` trong `PostToolUse`.**
  Suy đoán "output trông giống pass" là đúng loại tự lừa mà cả cơ chế này sinh ra
  để chống. Tiến trình chạy test phải là tiến trình đóng dấu.
- **Không chặn mọi lần Stop khi còn pending.** Sẽ chặn cả những lượt chỉ trả lời
  một câu hỏi. Một guard chặn nhầm thường xuyên là một guard bị tắt.
- **Không bật `FileChanged`, `PermissionRequest`, `PostToolBatch`.** Mỗi hook là
  một tiến trình chạy trên mọi sự kiện. Ghi vào README như hướng mở, bật khi có
  nhu cầu đo được.
- **Không đụng code sản phẩm ở pha này.** Pha 2 làm việc đó, bằng chính bộ này.

## Rủi ro đã biết

- Bộ nhận diện claim là heuristic ngôn ngữ, sẽ sai cả hai hướng. Giảm nhẹ: bắt
  nhầm chỉ tốn một lần chạy gate; bỏ sót chỉ mất một lần chặn, không mất dữ liệu.
- Hook chạy trên mọi sự kiện tương ứng, nên mỗi cái phải khởi động nhanh và
  **fail open**. Không hook nào được import gì ngoài thư viện chuẩn của Node.
- `.claude/state/` là trạng thái cục bộ, gitignored. Máy khác không thừa hưởng
  dấu xanh — đúng ý muốn: bằng chứng phải là bằng chứng trên máy đang chạy.
