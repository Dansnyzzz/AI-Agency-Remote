/**
 * Tiếng Việt.
 *
 * Viết cho người không rành công nghệ. Ba nguyên tắc:
 *
 *   **Không để nguyên thuật ngữ nếu tiếng Việt có từ dùng được.** "API key" thì
 *   giữ, vì đó là cái người ta đi copy trên trang của nhà cung cấp và phải nhận ra
 *   được. "Model" cũng giữ, vì mọi nơi khác trong ngành đều gọi thế.
 *
 *   **Nói hậu quả, không nói cơ chế.** "Model miễn phí, đủ cho việc thường ngày"
 *   hữu ích hơn "rate-limited free tier".
 *
 *   **Không hứa quá.** Chỗ nào có đánh đổi thì nói ra, vì người mới là người ít có
 *   khả năng tự phát hiện nhất.
 */
export const vi = {
  /* ── chung ─────────────────────────────────────────────────────── */
  'app.name': 'AI Remote',
  'action.next': 'Tiếp tục',
  'action.back': 'Quay lại',
  'action.skip': 'Bỏ qua',
  'action.done': 'Bắt đầu dùng',
  'action.close': 'Đóng',
  'action.save': 'Lưu',
  'action.cancel': 'Huỷ',
  'action.change': 'Đổi',

  /* ── thanh bên ─────────────────────────────────────────────────── */
  'nav.newChat': 'Cuộc trò chuyện mới',
  'nav.search': 'Tìm trong hội thoại',
  'nav.projects': 'Dự án',
  'nav.artifacts': 'Tệp đã tạo',
  'nav.scheduled': 'Chạy theo giờ',
  'nav.workspace': 'Thư mục làm việc',
  'nav.settings': 'Cài đặt',
  'nav.conversations': 'HỘI THOẠI',

  /* ── thanh trên & khung soạn ───────────────────────────────────── */
  'topbar.computers': 'Máy tính',
  'topbar.panel': 'Tiến trình và màn hình',
  'composer.placeholder': 'Hỏi bất cứ điều gì…  (Enter để gửi, Shift+Enter để xuống dòng)',
  // Danh sách việc do `update_plan` vẽ trong một tin nhắn, và số đếm cạnh cùng
  // các bước đó ở thanh tiến trình.
  'chat.plan': 'Kế hoạch',

  /* ── một chuỗi thao tác ─────────────────────────────────────────── */
  'steps.browser': 'Đã dùng trình duyệt',
  'steps.desktop': 'Đã dùng máy tính',
  'steps.count': '{n} bước',
  'step.output': 'Kết quả',
  'step.seconds': '{n} giây',
  'step.browser.open': 'Mở',
  'step.browser.tabs': 'Xem các tab',
  'step.browser.switchTab': 'Chuyển sang tab',
  'step.browser.closeTab': 'Đóng tab',
  'step.browser.look': 'Đọc trang',
  'step.browser.click': 'Bấm',
  'step.browser.type': 'Gõ',
  'step.browser.press': 'Nhấn phím',
  'step.browser.back': 'Quay lại',
  'step.browser.forward': 'Đi tiếp',
  'step.browser.select': 'Chọn',
  'step.browser.hover': 'Rê chuột lên',
  'step.browser.scroll': 'Cuộn',
  'step.browser.wait': 'Chờ',
  'step.browser.close': 'Đóng trình duyệt',
  'step.desktop.windows': 'Xem các cửa sổ',
  'step.desktop.launch': 'Mở',
  'step.desktop.look': 'Nhìn màn hình',
  'step.desktop.focus': 'Chuyển sang',
  'step.desktop.click': 'Bấm',
  'step.desktop.type': 'Gõ',
  'step.desktop.key': 'Nhấn phím',
  'step.desktop.scroll': 'Cuộn',
  'step.desktop.wait': 'Chờ',
  'step.desktop.close': 'Đóng',

  /* ── kết nối một máy tính ────────────────────────────────────────── */
  'worker.copy': 'Sao chép',
  'worker.copied': 'Đã sao chép',

  /* ── trình duyệt mà máy tính đó điều khiển ───────────────────────── */
  'browser.label': 'Trình duyệt',
  'browser.sandbox': 'Sandbox — trình duyệt sạch, chưa đăng nhập gì',
  'browser.profile': 'Hồ sơ riêng — giữ nguyên đăng nhập cho lần sau',
  'browser.attach': 'Chrome của bạn — chính cái bạn đang mở',
  'browser.sandboxHint':
    'Một trình duyệt mới với hồ sơ trắng. Không có gì của bạn trong đó, và không lưu lại gì.',
  'browser.profileHint':
    'Một hồ sơ riêng nằm trên máy đó. Đăng nhập một lần qua khung xem trực tiếp là nhớ mãi. Cookie là thật, và nó nằm trên máy đó.',
  'browser.attachHint':
    'Điều khiển đúng Chrome bạn đang mở, kèm mọi tài khoản bạn đang đăng nhập. Chrome phải được khởi động kèm --remote-debugging-port={port}.',
  'browser.attachMissing':
    'Không có gì đang lắng nghe ở cổng {port} trên máy đó. Thoát hẳn Chrome, rồi mở lại kèm --remote-debugging-port={port} — hoặc chọn trình duyệt khác ở đây.',
  'browser.pending': 'Đang chờ máy đó nhận thay đổi.',
  'browser.saved': 'Đã lưu. Máy đó sẽ chuyển trong khoảng mười lăm giây.',
  'chat.planCount': '{done}/{total}',

  // Tin nhắn gõ trong lúc trợ lý còn đang chạy, chờ phía trên khung soạn cho
  // đến khi bước hiện tại xong.
  'queue.more': 'Xem thêm',
  'queue.less': 'Thu gọn',
  'queue.now': 'Gửi ngay',
  'queue.nowHint': 'Gửi ngay lập tức, không đợi bước đang chạy kết thúc',
  'queue.remove': 'Xoá tin nhắn đang chờ này',
  'composer.attach': 'Gắn ảnh hoặc tệp',
  'composer.send': 'Gửi',
  'composer.stop': 'Dừng',
  'empty.title': 'Hôm nay bạn muốn làm gì?',
  'empty.body':
    'Chọn model rồi hỏi bất cứ điều gì. Khi máy tính của bạn đã kết nối, trợ lý có thể đọc tệp, sửa code và chạy lệnh ngay trên máy đó.',

  /* ── model ─────────────────────────────────────────────────────── */
  'model.free.tooltip':
    '{model} — model miễn phí. Đủ cho hỏi đáp thường ngày; bị giới hạn số lần gọi và yếu hơn ở việc nhiều bước. Bấm để đổi.',
  'model.switched': 'Đang dùng {model}.',

  /* ── onboarding ────────────────────────────────────────────────── */
  'onb.title': 'Bắt đầu với AI Remote',
  'onb.step': 'Bước {n}/{total}',
  'onb.reopen': 'Xem lại hướng dẫn ban đầu',

  'onb.1.title': 'AI Remote làm được gì cho bạn',
  'onb.1.body': 'Đây không phải chatbot chỉ biết trả lời. Nó làm việc thật trên máy tính của bạn.',
  'onb.1.a': 'Đọc và sửa tệp, chạy lệnh, mở web — trên máy tính của bạn, bạn xem trực tiếp.',
  'onb.1.b': 'Tự làm báo giá, báo cáo, bảng tính, slide và gửi lại cho bạn tải về.',
  'onb.1.c': 'Điều khiển được từ điện thoại, máy tính bảng hay laptop khác.',
  'onb.1.note':
    'Bạn luôn thấy nó đang làm gì, và những việc nguy hiểm thì nó dừng lại hỏi bạn trước.',

  'onb.2.title': 'Dán một API key vào',
  'onb.2.body':
    'API key là mật khẩu để trợ lý gọi được model AI. Bạn tự lấy trên trang của nhà cung cấp, dán vào đây một lần là xong.',
  'onb.2.recommend':
    'Gợi ý cho người mới: dùng OpenRouter. Một key duy nhất là với tới được gần như mọi model, và có nhiều model miễn phí.',
  'onb.2.open': 'Mở phần dán key',
  'onb.2.done': 'Xong — tài khoản của bạn đã có key.',
  'onb.2.pending': 'Chưa có key nào. Chưa dán thì trợ lý chưa trả lời được.',
  'onb.2.safety': 'Key được mã hoá trên máy chủ của bạn và không bao giờ gửi về trình duyệt.',

  'onb.3.title': 'Model bạn đang dùng',
  'onb.3.free':
    'Bạn đang dùng model MIỄN PHÍ. Đủ tốt cho hỏi đáp, viết lách và việc thường ngày.',
  'onb.3.freeWarn':
    'Cần nói thật: model miễn phí bị giới hạn số lần gọi và làm việc nhiều bước kém hơn. Nếu một việc dài bị dừng giữa đường, đổi sang model trả phí là hết.',
  'onb.3.paid': 'Bạn đang dùng model trả phí — tính vào key của chính bạn.',
  'onb.3.change': 'Đổi model',
  'onb.3.note':
    'Chỉ có một model dùng cho toàn bộ ứng dụng, nên đổi ở đâu cũng là đổi ở mọi nơi.',

  'onb.4.title': 'Thử câu đầu tiên',
  'onb.4.body': 'Bấm một câu bên dưới là nó chạy luôn. Bạn xem nó làm từng bước.',
  'onb.4.try1': 'Máy tính của tôi đang chậm, kiểm tra xem vì sao',
  'onb.4.try2': 'Tìm giúp tôi 5 tin công nghệ đáng chú ý tuần này',
  'onb.4.try3': 'Làm cho tôi một file Excel theo dõi chi phí hàng tháng',
  'onb.4.note': 'Cứ nói bằng tiếng Việt bình thường. Không cần câu lệnh đặc biệt.',

  'onb.5.title': 'Mức độ tự do của trợ lý',
  'onb.5.body': 'Nút cạnh chỗ gửi tin quyết định việc gì nó tự làm, việc gì phải hỏi bạn.',
  'onb.5.guarded':
    'Có kiểm soát (nên dùng) — việc thường ngày thì tự làm; xoá tệp hay sửa ngoài thư mục làm việc thì dừng lại hỏi bạn.',
  'onb.5.auto': 'Tự chạy hết — nhanh nhất, và là mức có thể làm mất dữ liệu.',
  'onb.5.ask': 'Hỏi mọi thứ — an toàn nhất, nhưng bị hỏi rất nhiều.',
  'onb.5.honest':
    'Nói thẳng: phần kiểm tra "việc nguy hiểm" dựa trên danh sách các mẫu lệnh đã biết, không phải một cái lồng kín. Việc phá hoại theo cách lạ vẫn có thể chạy. Cần chắc chắn thì chọn "Hỏi mọi thứ".',
  'onb.5.finish': 'Xong. Bắt đầu làm việc.',

  /* ── cài đặt ───────────────────────────────────────────────────── */
  'settings.title': 'Cài đặt',
  'settings.tab.providers': 'Nhà cung cấp',
  'settings.tab.models': 'Model',
  'settings.tab.behaviour': 'Cách hoạt động',
  'settings.tab.skills': 'Kỹ năng',
  'settings.tab.tasks': 'Chạy theo giờ',
  'settings.tab.connectors': 'Kết nối',
  'settings.tab.worker': 'Máy tính',
  'settings.tab.account': 'Tài khoản',
  'settings.tab.people': 'Người dùng',
  'settings.language.label': 'Ngôn ngữ',
  'settings.language.hint': 'Áp dụng ngay, và theo tài khoản của bạn trên mọi thiết bị.',
  'settings.help.label': 'Hướng dẫn',
  'settings.help.hint': 'Xem lại hướng dẫn 5 bước dành cho người mới bắt đầu.',
/* ── MCP ───────────────────────────────────────────────────────── */
  'settings.tab.mcp': 'MCP server',
  'mcp.lede':
    'MCP server bổ sung công cụ từ bên ngoài ứng dụng — Figma, Jira, Sentry, cơ sở dữ liệu, và hàng trăm thứ khác. Cắm vào là trợ lý dùng được. Không có gì ở đây do trợ lý tự chọn: bạn tự gõ lệnh, và mọi công cụ từ server đều dừng lại hỏi bạn trước khi chạy.',
  'mcp.name': 'Tên',
  'mcp.transport': 'Kết nối kiểu nào',
  'mcp.transport.stdio': 'Một chương trình trên máy này',
  'mcp.transport.http': 'Một đường dẫn URL',
  'mcp.command': 'Câu lệnh',
  'mcp.command.hint':
    'Toàn bộ câu lệnh, đúng như bạn gõ trong terminal. Việc này chạy một chương trình trên máy bạn, nên chỉ dán thứ bạn tin được.',
  'mcp.url': 'URL của server',
  'mcp.headers': 'Header',
  'mcp.headers.hint': 'Mỗi dòng một cái, dạng Tên: giá trị. Được mã hoá trên máy chủ và không bao giờ gửi lại về trình duyệt.',
  'mcp.add': 'Kết nối',
  'mcp.connected': 'Đã kết nối',
  'mcp.none': 'Chưa có server nào. Trợ lý vẫn dùng đủ công cụ sẵn có của ứng dụng.',
  'mcp.trying': 'Đang thử khởi động server… lần đầu có thể mất một lúc để tải về.',
  'mcp.added': 'Xong — tìm thấy {n} công cụ. Trợ lý dùng được từ lượt sau.',
  'mcp.needName': 'Đặt tên cho server đã.',
  'mcp.needCommand': 'Nhập câu lệnh khởi động server.',
  'mcp.tools': '{n} công cụ',
  'mcp.broken': 'không chạy được',
  'mcp.off': 'đang tắt',
  'mcp.enable': 'Bật',
  'mcp.disable': 'Tắt',
  'mcp.remove': 'Xoá',
  'mcp.suggested': 'Server gợi ý',
  'mcp.suggested.hint': 'Bấm một cái để điền sẵn vào form. Không có gì được cài hay chạy cho tới khi bạn bấm Kết nối.',
  'mcp.needs': 'cần token',
  'mcp.presetReady': 'Đã điền sẵn {name}. Bấm Kết nối để thử.',
};
