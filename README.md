<div align="center">

# 🔀 claude-swap

**Chuyển đổi nóng giữa nhiều tài khoản Claude Code — không thoát session, không mất ngữ cảnh.**

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-1f2937)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin%20%2Fprofile-d97757)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-success)

[Tính năng](#-tính-năng) ·
[Cài đặt](#-cài-đặt) ·
[Sử dụng](#-sử-dụng) ·
[Cách hoạt động](#-cách-hoạt-động) ·
[Phát triển](#️-phát-triển)

</div>

---

Tài khoản cá nhân, công ty, dự án khách hàng… mỗi cái một profile, đổi qua lại ngay trong Claude Code mà không cần thoát session hay làm gián đoạn luồng làm việc.

Plugin chạy trực tiếp trên môi trường **Node.js** sẵn có của Claude Code: **không cần Python, không cần cài thêm thư viện ngoài (zero-dependencies)**.

## ✨ Tính năng

| | |
| --- | --- |
| 💾 **Tạo / chuyển / xoá** | Mỗi profile là một tài khoản Claude đã đăng nhập. Hỗ trợ `/profile new <tên>` và `/profile save <tên>`. |
| 📋 **Danh sách trực quan** | Icon 🟢 Active / ⚪ Inactive, email 👤, hiển thị nhanh quota và màu sắc nổi bật trên terminal. |
| 📊 **Usage từng profile** | Quota 5 giờ, 7 ngày và theo model (Opus, Sonnet…). Thanh màu theo mức: 🟢 < 50% · 🟡 < 80% · 🟠 < 95% · 🔴 ≥ 95%, kèm ⚠ từ 80%. |
| 📥 **Nhập profile** | Từ file `*.json` lưu trước đó hoặc thư mục cấu hình Claude khác (vd `~/.claude-work`). |
| ⚡ **Không tốn token** | Lệnh `/profile` là plugin hook xử lý tức thì ở máy local, **không tốn lượt hỏi model**. |
| 🌐 **Đa nền tảng** | Chạy tốt trên Linux, macOS (hỗ trợ Keychain) và Windows. |

## 📦 Cài đặt

Cài đặt trực tiếp bên trong session Claude Code:

```bash
/plugin install profile-swap --marketplace thangvofastboy/claude-swap
```

*(Nhấn `y` khi Claude hỏi xác nhận thêm marketplace, sau đó chọn phạm vi cài đặt).*

Chạy thử trực tiếp từ source mà không cần cài đặt:

```bash
claude --plugin-dir /path/to/claude-swap
```

## 🚀 Sử dụng

### Bắt đầu nhanh

1. Đăng nhập Claude Code bằng tài khoản đầu tiên (`claude` → `/login`), lưu thành profile:
   ```text
   /profile new work
   ```
2. Đăng xuất hoặc `/login` sang tài khoản thứ hai (vd: tài khoản cá nhân):
   ```text
   /profile new personal
   ```
3. Chuyển đổi giữa các profile bất kỳ lúc nào:
   ```text
   /profile work
   ```

### Bảng lệnh `/profile`

| Lệnh | Mô tả |
| --- | --- |
| `/profile` | Liệt kê các profile kèm icon 🟢/⚪, email 👤 và thanh usage tóm tắt |
| `/profile <tên>` | Chuyển sang profile `<tên>` |
| `/profile usage` | Xem chi tiết quota 5 giờ / 7 ngày / theo model của từng profile |
| `/profile auto` | Xem trạng thái tự động chuyển profile khi vượt ngưỡng token |
| `/profile auto on` / `off` | Bật / tắt tính năng tự động chuyển profile |
| `/profile auto threshold <%>` | Thiết lập ngưỡng % mức dùng để tự động switch (mặc định: `95%`) |
| `/profile auto order <ds>` | Cài đặt thứ tự ưu tiên các account sẽ switch (vd: `work,personal`) |
| `/profile auto order default` | Chuyển về quy tắc tự động (nhiều token hơn + reset sớm hơn) |
| `/profile auto check` | Kiểm tra quota và switch ngay nếu vượt ngưỡng |
| `/profile new <tên> [--force]` | Tạo profile mới từ tài khoản hiện tại |
| `/profile save <tên> [--force]` | Lưu thông tin đăng nhập hiện tại vào profile |
| `/profile delete <tên>` | Xoá profile |
| `/profile import <thư mục> [--force]` | Nhập các profile từ thư mục khác |
| `/profile folder` | Mở thư mục chứa file cấu hình profile |

Ví dụ hiển thị khi gõ `/profile`:

```text
🟢 work (Active)  👤 work@company.com  5h [███░░░░░] 32%   7d [█████░░░] 64%
⚪ personal       👤 user@gmail.com    5h [███████░] 85% ⚠   7d [███░░░░░] 40%
⚪ dev
```

Bạn cũng có thể chạy CLI trực tiếp ngoài terminal nếu muốn:

```bash
node swap.js list
node swap.js swap work
node swap.js usage
```

## 🧠 Cách hoạt động

Profile được lưu tại `~/.config/claude-cli-profiles/<tên>.json` (quyền riêng tư `0600`, thư mục `0700`):

- Các khóa xác thực trong `~/.claude.json` (`oauthAccount`, `primaryApiKey`, `customApiKeyResponses`).
- Token OAuth trong `~/.claude/.credentials.json` (hoặc Keychain trên macOS).

**Khi đổi profile:**
- Plugin chỉ trích xuất và cập nhật các khóa đăng nhập, **giữ nguyên toàn bộ cấu hình dự án và lịch sử session** trong `~/.claude.json`.
- Tự động sao lưu token mới nhất của profile hiện tại trước khi chuyển đổi (nếu token vừa được Claude Code tự động refresh).
- Ghi nguyên tử (atomic write) và tự tạo bản backup `.bak` để đảm bảo an toàn dữ liệu.

<details>
<summary><b>Session đang chạy có nhận tài khoản mới ngay không?</b></summary>

<br>

**Không cần khởi động lại session**, nhưng có thể **chưa ngay ở prompt kế tiếp**: Claude Code giữ token trong bộ nhớ và chỉ đọc lại file khi kiểm tra đăng nhập (theo đợt, hoặc khi token cũ hết hạn). Gõ `/status` trong Claude Code để kiểm tra tài khoản đang áp dụng.

</details>

<details>
<summary><b>Usage và giới hạn tần suất (HTTP 429)</b></summary>

<br>

Số liệu được lấy từ endpoint usage của Anthropic:
- Tự động cache kết quả trong 5 phút tại `~/.config/claude-cli-profiles/.usage-cache.json`.
- Khi gặp **HTTP 429**, plugin tự động tuân thủ thời gian chờ `Retry-After` từ server Anthropic và hiển thị số liệu gần nhất.

</details>

## 🛠️ Phát triển & Kiểm thử

Chạy kiểm thử:

```bash
npm test                   # chạy unit tests của swap.js (node --test)
claude plugin validate .   # kiểm tra manifest và hooks
claude plugin test .       # chạy kiểm thử plugin hook của Claude Code
```

Cấu trúc dự án:

```text
claude-swap/
├── swap.js               # Core engine xử lý profile, credentials & usage (Node.js)
├── package.json          # Cấu hình project & test script
├── hooks/
│   ├── hooks.json        # Đăng ký hook với Claude Code
│   ├── register.ts       # Hook session.start & command.run cho /profile
│   └── register.test.ts  # Test suite cho plugin hook
├── test/
│   └── swap.test.js      # Unit tests cho swap.js
└── .claude-plugin/       # Plugin manifest & marketplace config
```
