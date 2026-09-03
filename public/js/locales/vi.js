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
  'nav.workflows': 'Chuỗi việc',
  'nav.workspace': 'Thư mục làm việc',
  'nav.settings': 'Cài đặt',
  'nav.conversations': 'HỘI THOẠI',

  /* ── thanh trên & khung soạn ───────────────────────────────────── */
  'topbar.computers': 'Máy tính',
  'topbar.panel': 'Tiến trình và màn hình',
  'composer.placeholder': 'Hỏi bất cứ điều gì…  (Enter để gửi, Shift+Enter để xuống dòng)',
  // Khi một lượt đang chạy thì ô này làm việc khác, nên nó nói ra: gửi lúc này
  // là xếp hàng đợi — tin nhắn chờ hiện rõ và vào ở ranh giới bước kế tiếp,
  // chứ không mở một cuộc hội thoại thứ hai đè lên cái đang chạy.
  'composer.placeholderRunning': 'Xếp thêm một tin nhắn…',
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
  'setup.warning':
    'Dòng lệnh này trao cho người chạy nó toàn quyền trên máy đó — tệp, shell, và điều khiển màn hình. Chỉ chạy trên máy của chính bạn, và đừng bao giờ dán một dòng do người khác gửi.',
  'setup.expires': 'Dùng được trong {n} phút, và chỉ một lần.',

  /* ── máy tính mà trợ lý thao tác ─────────────────────────────────── */
  'devices.followsYou': 'Trợ lý thao tác trên máy bạn đang mở trang này.',
  'devices.pinned': 'Đang ghim vào một máy, bất kể bạn ngồi ở đâu.',
  'devices.unpin': 'Theo máy tôi đang ngồi',
  'devices.unpinned': 'Sẽ dùng máy bạn đang ngồi.',

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
  'composer.queue': 'Xếp hàng đợi — sẽ vào ở bước kế tiếp',
  'composer.stop': 'Dừng',
  'composer.stopped': 'Đã dừng.',
  'mirror.watching': 'Đang chạy ở tab khác — đang theo dõi…',
  /* Trợ lý đang làm gì, ở dòng ngay trên khung soạn. */
  'status.thinking': 'Đang suy nghĩ…',
  'status.compacting': 'Đang tóm tắt các lượt cũ…',
  'status.tool': 'Đang chạy {name}…',
  // Khác hẳn với suy nghĩ, và chính chỗ khác đó mới đáng nói: nhà cung cấp
  // chưa bắt đầu trả lời. Số giây tăng dần, vì một con số biết nhúc nhích là
  // thứ phân biệt 'đang chờ' với 'không biết chuyện gì'.
  'status.waiting': 'Đang chờ {model} bắt đầu — {n}s',
  'status.waitingFree': 'Đang chờ {model} — model miễn phí phải xếp hàng lúc đông ({n}s). Đổi model nếu lâu quá.',

  /* ── vì sao câu trả lời dừng lại ─────────────────────────────────
   *
   * Chỉ hiện khi câu trả lời *chưa* trọn vẹn. Ba trong số này trước đây kết
   * thúc y hệt một lượt bình thường: luồng ngắt, vòng quay biến mất, và đoạn
   * cuối đơn giản là không có kết. Nói rõ đã xảy ra chuyện gì chính là khác
   * biệt giữa "trợ lý đã trả lời" và "trợ lý bị cắt ngang".
   */
  'stop.truncated':
    'Bị cắt ngang — câu trả lời chạm giới hạn độ dài đầu ra của model này. Bảo nó viết tiếp, hoặc chọn model có giới hạn đầu ra lớn hơn.',
  'stop.refused':
    'Hệ thống an toàn của nhà cung cấp đã từ chối yêu cầu này nên model không tạo ra gì cả. Hãy diễn đạt lại, hoặc đổi model.',
  'stop.filtered':
    'Bộ lọc nội dung của nhà cung cấp đã chặn câu trả lời này. Phần bạn thấy chỉ là phần lọt qua được.',
  'stop.recitation':
    'Dừng lại vì câu trả lời đang chép lại tài liệu nguồn quá sát. Hỏi lại bằng lời của bạn thì thường sẽ qua.',
  'stop.unknown': 'Nhà cung cấp kết thúc câu trả lời này mà không nói lý do.',

  'approval.title': 'Duyệt các hành động này?',
  'composer.label': 'Tin nhắn',

  /* ── chính khung hội thoại ───────────────────────────────────────
   *
   * Những chuỗi này người dùng gặp ở *mọi* lượt — phần suy luận gập lại, kết
   * quả của một tool, các nút trên một tài liệu — mà trước đây đều là tiếng
   * Anh cứng, trong khi nút đổi ngôn ngữ trong Cài đặt lại nói ngược lại.
   */
  'chat.reasoning': 'Suy luận',
  'chat.noOutput': '(không có kết quả)',
  'chat.noResult': '(không ghi nhận được kết quả)',
  'chat.diagram': 'Sơ đồ',
  'chat.open': 'Mở',
  'chat.download': 'Tải về',
  'chat.openNamed': 'Mở {name}',
  'chat.copy': 'Sao chép',
  'chat.edit': 'Sửa',
  'chat.summaryFold': 'Đọc bản tóm tắt',
  'chat.compacted': 'Đã tóm tắt {n} tin nhắn cũ để lấy thêm chỗ',
  'chat.compactedOne': 'Đã tóm tắt 1 tin nhắn cũ để lấy thêm chỗ',

  /* ── những gì hiện ra trong lúc một lượt đang chạy ───────────── */
  'status.reconnecting': 'Đang kết nối lại…',
  'status.restarting': 'Đang viết lại câu trả lời đó…',
  'status.paused': 'Đã tạm dừng sau nhiều lần nối lại. Gửi một tin nhắn để chạy tiếp.',
  'status.streamFailed': 'Luồng dữ liệu bị lỗi.',
  'status.queued': 'Đã gửi — trợ lý sẽ đọc ở bước kế tiếp.',
  'status.pickedUp': 'Đã tiếp nhận: "{text}"',
  'status.folded': 'Đã gộp {n} tin nhắn cũ thành một bản tóm tắt để lấy thêm chỗ.',
  'usage.tokens': '{n} token',
  'usage.thisTurn': 'lượt này',
  'usage.cached': '{n}% từ cache',
  /* ── chip chế độ, ngay cạnh nút Gửi ──────────────────────────────
   *
   * Năm chế độ và câu giải thích cho từng cái. Nó nằm ngay cạnh nút gửi — thứ
   * được nhìn nhiều nhất trong app — mà trước đây luôn là tiếng Anh.
   */
  'policy.guarded.label': 'Có kiểm soát',
  'policy.ask.label': 'Hỏi trước',
  'policy.auto.label': 'Tự chạy',
  'policy.plan.label': 'Lập kế hoạch',
  'policy.readonly.label': 'Chỉ đọc',
  'policy.guarded.hint':
    'Đọc, sửa file trong workspace, điều khiển trình duyệt và các lệnh thường ngày đều chạy thẳng. ' +
    'Xoá, ghi ra ngoài workspace, đụng vào đường dẫn hệ thống Windows và đóng cửa sổ chưa lưu thì dừng lại hỏi. ' +
    'Phép kiểm tra đó là một danh sách các mẫu nguy hiểm đã biết, không phải sandbox — thứ phá hoại mà nó chưa biết vẫn sẽ chạy.',
  'policy.auto.hint': 'Không chặn gì cả, kể cả hành động phá huỷ. Nhanh nhất, và cũng là cái có thể làm mất việc.',
  'policy.ask.hint': 'Mọi thay đổi đều chờ bạn duyệt. An toàn nhất, và cũng làm phiền nhất — bạn sẽ bị hỏi rất nhiều.',
  'policy.plan.hint': 'Tìm hiểu và đọc, rồi trả về một kế hoạch thay vì tự làm. Không có gì trên máy bạn bị thay đổi.',
  'policy.readonly.hint': 'Trợ lý được xem, nhưng các tool có thể thay đổi bất cứ thứ gì thì không bao giờ được đưa cho nó.',

  /* Model được yêu cầu nghĩ kỹ tới mức nào, năm nấc từ rẻ tới cẩn thận. */
  'effort.low': 'Thấp',
  'effort.medium': 'Vừa',
  'effort.high': 'Cao',
  'effort.xhigh': 'Rất cao',
  'effort.max': 'Tối đa',
  /* ── các kệ: Dự án, Tệp đã tạo, Chạy theo giờ ────────────────────
   *
   * Bốn màn hình gọi t() đúng 0 lần. Hai từ điển vẫn khớp nhau suốt thời gian
   * đó — chính vì vậy test:i18n không hề phát hiện ra.
   */
  'pages.projects.title': 'Dự án',
  'pages.projects.new': 'Dự án mới',
  'pages.sortBy': 'Sắp xếp theo',
  'pages.filterBy': 'Lọc theo',
  'pages.order.updated': 'Sửa gần nhất',
  'pages.order.created': 'Ngày tạo',
  'pages.order.name': 'Tên',
  'pages.order.archived': 'Đã lưu trữ',
  'pages.projects.noneMatch': 'Không có dự án nào khớp.',
  'pages.projects.none': 'Chưa có dự án nào.',
  'pages.projects.noneHint':
    'Một dự án gom hướng dẫn và tài liệu của nó vào một chỗ, và mọi hội thoại mở trong đó đều trả lời dựa trên các tài liệu ấy.',
  'pages.projects.archivedNoneMatch': 'Không có dự án lưu trữ nào khớp.',
  'pages.projects.archivedNone': 'Chưa lưu trữ gì.',
  'pages.pinned': 'Đã ghim',
  'pages.optionsFor': 'Tuỳ chọn cho {name}',

  'pages.artifacts.title': 'Tệp đã tạo',
  'pages.artifacts.new': 'Tệp mới',
  'pages.artifacts.none': 'Chưa có tệp nào.',
  'pages.artifacts.noneMatch': 'Không có gì khớp.',
  'pages.artifacts.newHint': 'Cứ nói bạn muốn tạo gì — một báo cáo, một bảng tính, một trang nhỏ.',
  'pages.kind.all': 'Tất cả',
  'pages.kind.page': 'Trang',
  'pages.kind.code': 'Mã nguồn',
  'pages.kind.document': 'Văn bản',
  'pages.kind.sheet': 'Bảng tính',
  'pages.kind.deck': 'Slide',

  'pages.tasks.title': 'Việc chạy theo giờ',
  'pages.tasks.new': 'Việc mới',
  'pages.tasks.none': 'Chưa đặt việc nào.',
  'pages.order.next': 'Lần chạy tới',
  'pages.tasks.describe': 'Mô tả cho trợ lý',
  'pages.tasks.describeHint': 'Nói nó chạy gì và khi nào — "8 giờ sáng mỗi ngày trong tuần, tìm…"',
  'pages.tasks.manual': 'Tự thiết lập',
  'pages.tasks.scheduled': 'Đã đặt lịch.',
  'pages.tasks.openResult': 'Mở kết quả',
  'pages.tasks.pause': 'Tạm dừng',
  'pages.tasks.resume': 'Chạy lại',
  'pages.tasks.remove': 'Xoá',
  'pages.tasks.removeConfirm': 'Xoá nhé?',
  'pages.tasks.every': 'mỗi {cron}',
  'pages.tasks.once': 'một lần',
  'pages.tasks.next': 'lần tới {when}',
  'pages.tasks.paused': 'đang tạm dừng',
  'pages.tasks.last': 'lần trước {status}',

  /* Bốn gợi ý mở đầu hiện ra khi kệ Chạy theo giờ còn trống. */
  'pages.idea.briefing.name': 'Tóm tắt buổi sáng',
  'pages.idea.briefing.what': 'Đêm qua có gì thay đổi trong những thứ bạn theo dõi, đã tìm và tóm tắt sẵn.',
  'pages.idea.briefing.when': 'Các ngày trong tuần lúc 08:00',
  'pages.idea.watch.name': 'Theo dõi một chủ đề',
  'pages.idea.watch.what': 'Kiểm tra tin tức về một chủ đề, và chỉ lên tiếng khi thật sự có gì mới.',
  'pages.idea.watch.when': 'Hằng ngày lúc 09:00',
  'pages.idea.report.name': 'Báo cáo tuần',
  'pages.idea.report.what': 'Một file Word tóm tắt cả tuần, tạo sẵn và để lại trong hội thoại.',
  'pages.idea.report.when': 'Thứ sáu lúc 16:00',
  'pages.idea.tests.name': 'Kiểm tra thư mục làm việc',
  'pages.idea.tests.what': 'Chạy test trên máy bạn và báo lại cái nào hỏng.',
  'pages.idea.tests.when': 'Các ngày trong tuần lúc 09:00',
  /* Thời gian tương đối, và hai con số trên thẻ dự án. Tiếng Việt không biến
     đổi danh từ theo số nhiều, nên đây là cả cụm chứ không phải gốc từ cộng
     's' — cũng chính vì thế mà `plural()` không dịch thẳng được. */
  'when.justNow': 'vừa xong',
  'when.minutes': '{n} phút trước',
  'when.hours': '{n} giờ trước',
  'when.yesterday': 'hôm qua',
  'when.days': '{n} ngày trước',
  'count.sources': '{n} nguồn',
  'count.sourcesOne': '1 nguồn',
  'count.conversations': '{n} hội thoại',
  'count.conversationsOne': '1 hội thoại',
  'count.messages': '{n} tin nhắn',
  'count.messagesOne': '1 tin nhắn',
  'count.pages': '{n} trang',
  'count.pagesOne': '1 trang',
  'pages.tasks.localOnly':
    'Việc theo giờ chỉ chạy khi app này đang mở. Khi triển khai lên server thì chúng chạy mà không cần app.',
  /* ── chuỗi việc ──────────────────────────────────────────────── */
  'wf.title': 'Chuỗi việc',
  'wf.new': 'Chuỗi việc mới',
  'wf.order.recent': 'Thêm gần đây',
  'wf.describe': 'Mô tả cho trợ lý',
  'wf.describeHint':
    'Nói các bước theo thứ tự — "mỗi thứ hai: lấy số liệu, vẽ biểu đồ, gửi email cho nhóm".',
  'wf.manual': 'Tự thiết lập',
  'wf.none': 'Chưa có chuỗi việc nào.',
  'wf.noneHint':
    'Dùng khi một công việc có nhiều chặng bắt buộc theo thứ tự — và khi lỡ lặp lại một chặng thì sẽ thành chuyện. Nếu chỉ có một chỉ dẫn thì đó là việc chạy theo giờ, không phải chuỗi việc.',
  'wf.pause': 'Tạm dừng',
  'wf.resume': 'Chạy lại',
  'wf.remove': 'Xoá',
  'wf.removeConfirm': 'Xoá nhé?',
  'wf.runNow': 'Chạy ngay',
  'wf.running': 'Đang chạy…',
  'wf.finished': 'Xong.',
  'wf.startedBackground': 'Đã bắt đầu — nó sẽ chạy tiếp ở nền.',
  'wf.openResult': 'Mở kết quả',
  'wf.edit': 'Sửa',
  'wf.paused': 'đang tạm dừng',
  'wf.lastRun': 'lần chạy trước {status}',
  'wf.neverRun': 'chưa chạy lần nào',
  'wf.formEdit': 'Sửa chuỗi việc',
  'wf.formCreate': 'Tạo chuỗi việc',
  'wf.needStep': 'Cần ít nhất một bước — mỗi dòng một chỉ dẫn.',
  'wf.saved': 'Đã lưu.',
  'wf.created': 'Đã tạo.',

  /* ── trình duyệt model ───────────────────────────────────────── */
  'models.allVendors': 'Tất cả nhà cung cấp',
  'models.empty': 'Thư viện đang trống — bấm Làm mới để tải về từ OpenRouter.',
  'models.noMatch': 'Không có gì khớp. Thử ít từ hơn, hoặc thêm model bằng id trong Cài đặt → Models.',
  'models.builtIn': 'Có sẵn — dùng key nhà cung cấp của bạn',
  'models.onYourKey': '{provider} — trên key của bạn',
  'models.refreshing': 'Đang làm mới…',
  'models.refreshNow': 'Làm mới ngay',
  'models.automatic': 'Tự động',
  'models.autoName': 'Auto — model miễn phí tốt nhất',
  'models.autoMeta':
    'Chọn model miễn phí mạnh nhất mà bạn chạy được ngay lúc này. Hỗ trợ ảnh là một công tắc trong Cài đặt → Hành vi.',

  /* ── danh sách tệp và trình sửa trong thư mục làm việc ───────── */
  'ws.deleteConfirm': 'Xoá nhé?',
  'ws.renamePrompt': 'Đổi tên hoặc di chuyển — sửa đường dẫn:',
  'ws.moved': 'Đã chuyển.',
  'ws.deleted': 'Đã xoá.',
  'ws.leaveUnsaved': 'Thoát mà không lưu?',
  'ws.saving': 'Đang lưu…',
  'ws.saved': 'Đã lưu.',
  'ws.newFilePrompt': 'Tệp mới — đặt tên, kèm đường dẫn nếu muốn để trong thư mục:',
  /* ── trang dự án ─────────────────────────────────────────────── */
  'proj.pin': 'Ghim',
  'proj.unpin': 'Bỏ ghim',
  'proj.pinned': 'Đã ghim lên đầu.',
  'proj.unpinned': 'Đã bỏ ghim.',
  'proj.pinAria': 'Ghim dự án',
  'proj.unpinAria': 'Bỏ ghim dự án',
  'proj.editDetails': 'Sửa thông tin',
  'proj.archive': 'Lưu trữ',
  'proj.restore': 'Khôi phục',
  'proj.archived': 'Đã lưu trữ. Nó nằm ở kệ lưu trữ, mọi thứ bên trong vẫn còn nguyên.',
  'proj.restored': 'Đã đưa trở lại kệ.',
  'proj.delete': 'Xoá',
  'proj.deleted': 'Đã xoá.',
  'proj.answersFrom': 'Trả lời từ {sources}',
  'proj.answersFirstFrom': 'Ưu tiên trả lời từ {sources}',
  'proj.noSources': 'Chưa có nguồn nào — trả lời như một hội thoại bình thường',
  'proj.untitled': 'Chưa đặt tên',
  'proj.editInstructions': 'Sửa hướng dẫn',
  'proj.instructionsSaved': 'Đã lưu hướng dẫn.',
  'proj.uploadFromDevice': 'Tải lên từ máy',
  'proj.addTextContent': 'Thêm nội dung văn bản',
  'proj.nothingToAdd': 'Không có gì để thêm.',
  'proj.pastedText': 'Văn bản đã dán',
  'proj.added': 'Đã thêm.',
  'proj.addedSources': 'Đã thêm {sources}.',
  'proj.fallbackName': 'Dự án',

  /* ── trình xem tệp đã tạo ────────────────────────────────────── */
  'viewer.noStorage': 'Khung này không có nơi lưu.',
  'viewer.markdownNote': 'Markdown cho văn bản, còn mã nguồn thì hiện đúng tệp gốc.',
  'viewer.versionNote': 'Một phiên bản cũ, hiện đúng như lúc đó. Khôi phục lại thì mới sửa được.',
  'viewer.unreadable': 'Không đọc được tệp này.',
  'viewer.tab.preview': 'Xem trước',
  'viewer.tab.code': 'Mã nguồn',
  'viewer.tab.source': 'Nguồn',
  'viewer.kind.sheets': 'Trang tính',
  'viewer.kind.slides': 'Slide',
  'viewer.kind.pages': 'Trang',
  'viewer.kind.document': 'Tài liệu',
  'viewer.open': 'Mở',
  'viewer.openIn': 'Mở bằng {app}',
  'viewer.openInDefault': 'Mở bằng ứng dụng mặc định',
  'viewer.copy': 'Sao chép',
  'viewer.download': 'Tải về',
  'viewer.showInFolder': 'Mở thư mục chứa',
  'viewer.copyPicture': 'Sao chép ảnh',
  'viewer.copyFormatted': 'Sao chép kèm định dạng',
  'viewer.print': 'In — hoặc lưu thành PDF',
  'viewer.noComputer': 'Chưa kết nối máy tính nào',
  'viewer.noComputerHint':
    'Kết nối một máy tính để mở tệp bằng Word, Excel hoặc mở thư mục. Bấm vào chip ở thanh trên.',
  'viewer.nothingToCopy': 'Tệp này không có gì để sao chép.',
  'viewer.copiedRich': 'Đã sao chép — dán vào Word là giữ nguyên định dạng.',
  'viewer.copied': 'Đã sao chép.',
  'viewer.copyRefused': 'Trình duyệt không cho sao chép. Hãy nhấn Ctrl/⌘+C.',
  'viewer.pictureCopied': 'Đã sao chép ảnh.',
  'viewer.pictureCopyRefused': 'Trình duyệt không cho sao chép ảnh. Hãy tải nó về.',
  'viewer.saving': 'Đang lưu…',
  'viewer.backToPanel': 'Về lại bảng bên',
  'viewer.fullSize': 'Toàn màn hình',
  'viewer.opening': 'Đang mở…',
  'viewer.couldNotOpen': 'Không mở được tệp đó.',

  /* ── bảng màn hình trực tiếp ─────────────────────────────────── */
  'screen.title': 'Màn hình',
  'screen.wholeMachine': 'Toàn bộ màn hình của máy đang chạy worker.',
  'screen.sandboxClosed': 'Đã đóng trình duyệt sandbox.',
  'screen.driveOn': 'Ngừng điều khiển trang (hoặc bấm Escape)',
  'screen.driveOff': 'Tự điều khiển — bấm và gõ thẳng vào trang',
  'screen.close': 'Đóng trình duyệt hộp cát',
  'screen.expand': 'Toàn màn hình',
  'screen.hide': 'Ẩn',
  'ws.renameAria': 'Đổi tên {name}',
  'ws.deleteAria': 'Xoá {name}',
  'ws.renameTitle': 'Đổi tên hoặc di chuyển',
  'proj.memoryScope': 'Ghi nhớ được lưu theo tài khoản, không theo từng dự án.',
  'proj.accountWide': 'toàn tài khoản',
  'proj.addContext': 'Thêm ngữ cảnh',
  'proj.removeAria': 'Xoá {name}',
  'proj.needName': 'Dự án cần có tên.',
  'proj.deleteConfirm':
    'Xoá “{name}”?\n\nCác nguồn của nó sẽ mất theo. Những hội thoại đã mở trong dự án thì vẫn giữ — chúng quay về danh sách thường.',
  'count.chars': '{n} ký tự',
  'count.charsK': '{n}K ký tự',
  'count.charsM': '{n}M ký tự',
  'screen.sandboxNote': 'Cửa sổ trình duyệt riêng của trợ lý — tách biệt với trình duyệt bạn đang dùng.',





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
  'gate.name': 'Tên của bạn',
  'gate.email': 'Địa chỉ email',
  'gate.password': 'Mật khẩu',
  'gate.totp': 'Mã từ ứng dụng xác thực',
  'gate.resetcode': 'Mã 6 số trong email',
  'gate.newpassword': 'Mật khẩu mới',
  'pages.searchInput': 'Tìm dự án',
  'project.askInput': 'Hỏi về dự án này',
  'composer.attachInput': 'Đính kèm tệp',
  'pair.codeInput': 'Mã ghép nối từ máy tính',
  'models.searchInput': 'Tìm mô hình',
  'models.sortInput': 'Thứ tự sắp xếp',
  'workspace.findInput': 'Tìm trong các tệp này',
  'search.inputLabel': 'Tìm tiêu đề và mọi nội dung',
  'task.whenInput': 'Chạy vào lúc nào',
};
