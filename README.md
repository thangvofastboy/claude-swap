# claude-swap

Chuyển đổi nóng giữa nhiều tài khoản **Claude Code CLI** (cá nhân, công ty, khách hàng…) mà không phải
thoát session đang chạy, không mất ngữ cảnh hội thoại.

Một file Python duy nhất: `claude_swap.py` — gồm GUI (pywebview), icon trên thanh trên cùng (tray) và CLI.

## Tính năng

- **Lưu / chuyển / xoá profile** — mỗi profile là một tài khoản Claude đã đăng nhập.
- **Usage theo từng profile** — quota 5 giờ, 7 ngày và theo model (Opus, Sonnet, Fable…), biểu đồ thanh
  tô màu theo mức (xanh < 50%, vàng < 80%, cam < 95%, đỏ ≥ 95%, kèm ⚠ từ 80%).
- **Nhập profile** từ thư mục khác: file profile `*.json` của app, hoặc thư mục cấu hình Claude của tài khoản
  khác (ví dụ `~/.claude-work`). App tự gợi ý các thư mục `~/.claude*` tìm thấy, kể cả thư mục ẩn.
- **Icon trên thanh trên cùng + bảng nhanh** — đổi profile và xem usage chỉ với một cú bấm.
- **Khởi động cùng máy** — chạy nền ở thanh trên cùng khi đăng nhập (Linux `.desktop`, macOS LaunchAgent,
  Windows registry).
- **Giao diện Material, dark navy.** Thiếu thư viện nào, app hiện lệnh cài kèm nút **Copy**.

## Cài đặt

Cần Python 3.10+.

| Thành phần | Ubuntu/Debian (Python hệ thống) | pip (Python khác, macOS, Windows) |
| --- | --- | --- |
| Giao diện (bắt buộc cho GUI) | `sudo apt install python3-webview` | `pip install pywebview` |
| Icon thanh trên cùng (tuỳ chọn) | `sudo apt install python3-pystray python3-pil` | `pip install pystray pillow` |

CLI chỉ dùng thư viện chuẩn, không cần cài gì thêm. Không chắc thiếu gì thì cứ chạy app: nó hiện đúng lệnh
cần chạy cho Python bạn đang dùng.

> Trên Ubuntu, dùng `/usr/bin/python3`. Python của Homebrew/Linuxbrew không có sẵn tkinter/WebKitGTK.

## Sử dụng

### GUI

```bash
python3 claude_swap.py                # cửa sổ chính, tự tách khỏi terminal (đóng terminal app vẫn chạy)
python3 claude_swap.py --tray         # chạy nền ở thanh trên cùng (dùng cho khởi động cùng máy)
python3 claude_swap.py --foreground   # giữ app gắn với terminal (để xem log khi debug)
```

- Chạy từ terminal, app tự chạy lại ở session riêng (`setsid`; Windows: detached process) rồi trả terminal
  về ngay, nên đóng terminal không làm tắt app. Lỗi của lần chạy nền gần nhất ghi ở
  `~/.config/claude-cli-profiles/.gui.log`.
- **Chỉ một bản chạy cùng lúc:** mở app lần nữa sẽ đưa cửa sổ đang chạy lên trước thay vì mở bản mới
  (khởi động cùng máy khi app đã chạy thì không làm gì).

1. Đăng nhập Claude CLI bằng tài khoản thứ nhất (`claude` → `/login`), bấm **Lưu**, đặt tên (ví dụ `work`).
2. `/login` sang tài khoản khác, bấm **Lưu** lần nữa (ví dụ `personal`).
3. Từ giờ chọn profile rồi bấm **Chuyển profile** (hoặc bấm đúp vào thẻ).

### CLI

```bash
python3 claude_swap.py list                    # danh sách, đánh dấu (Active)
python3 claude_swap.py current
python3 claude_swap.py save <tên> [--force]    # lưu tài khoản đang đăng nhập
python3 claude_swap.py swap <tên>
python3 claude_swap.py delete <tên>
python3 claude_swap.py usage [--refresh]       # quota mọi profile
python3 claude_swap.py import <thư mục> [--force]
python3 claude_swap.py folder                  # mở thư mục lưu profile
```

### Lệnh `/profile` trong Claude Code

Bản plugin Claude Code (`/profile`, `/profile <tên>`, `/profile usage`, `/profile import <thư mục>`…) gọi thẳng
`claude_swap.py`, không tốn lượt hỏi model và hiện profile đang dùng trên thanh trạng thái. Mã plugin hiện
chưa có trong repo này.

## Cách hoạt động

- Profile lưu tại `~/.config/claude-cli-profiles/<tên>.json` (quyền `0600`, thư mục `0700`), gồm:
  - các khoá đăng nhập trong `~/.claude.json` (`oauthAccount`, `primaryApiKey`, `customApiKeyResponses`);
  - token OAuth trong `~/.claude/.credentials.json` (macOS: Keychain).
- **Swap chỉ thay các khoá đăng nhập**, không ghi đè cả `~/.claude.json` — file đó còn chứa lịch sử project
  mà session đang chạy ghi liên tục. Mọi file bị thay đều có bản `.bak` và được ghi nguyên tử.
- Trước khi rời một profile, app lưu lại token mới nhất của nó (Claude CLI tự làm mới token theo thời gian),
  để lần quay lại không gặp token đã bị thu hồi.

### Session đang chạy có nhận tài khoản mới ngay không?

**Không cần khởi động lại session**, nhưng có thể **chưa ngay ở prompt kế tiếp**: Claude Code giữ token trong
RAM và chỉ đọc lại file khi kiểm tra đăng nhập (theo đợt, hoặc khi token cũ bị từ chối). Gõ `/status` trong
Claude để xem tài khoản đang dùng.

### Usage và HTTP 429

Số liệu lấy từ endpoint usage của Anthropic. Endpoint này giới hạn tần suất theo từng tài khoản, và chính
Claude Code cũng gọi nó. Vì vậy app:

- lưu số liệu 5 phút trong `~/.config/claude-cli-profiles/.usage-cache.json` (dùng chung cho GUI, CLI, plugin);
- khi gặp **HTTP 429** thì chờ theo `Retry-After` của server (mặc định 10 phút); trong lúc đó vẫn hiện số liệu
  lần gần nhất kèm giờ thử lại;
- không tự làm mới token của profile không active: token đã hết hạn sẽ báo "hết hạn", swap sang profile đó
  một lần để Claude CLI làm mới.

## Đóng gói thành 1 file chạy

```bash
pip install pyinstaller pywebview pystray pillow
pyinstaller --onefile --noconsole claude_swap.py
```

## Phát triển

```bash
python3 -m pytest -q test_claude_swap.py   # unit test
python3 smoke_test.py                      # CLI thật + cửa sổ thiếu thư viện + cửa sổ pywebview thật
```

## Giới hạn đã biết

- macOS chưa hỗ trợ icon tray (pystray và pywebview đều đòi luồng chính).
- Trên GNOME Wayland, khi có tray app chạy GTK qua XWayland để đặt được vị trí bảng nhanh.
