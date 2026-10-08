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
| 🔤 **Profile Aliases** | Đặt tên viết tắt ngắn gọn (vd: `w` ➔ `work-company`) để chuyển cực nhanh bằng `/profile w`. |
| 🎛️ **Interactive Picker** | Gõ `/profile pick` để chọn profile bằng phím mũi tên `↑` `↓` và `Enter` trực quan ngay trong terminal. |
| 🌿 **Git Branch Binding** | Tự động chuyển profile theo mẫu nhánh Git (vd `work-*` ➔ công ty, `feat/*` ➔ dev). |
| 📈 **Quota Forecast & Burn-Rate** | Dự báo tốc độ tiêu thụ % token/giờ và thời điểm ước tính cạn hạn mức token (`/profile forecast`). |
| 🧠 **Model-Affinity Switcher** | Gán profile chuyên dụng theo từng dòng model AI (Opus, Sonnet, Haiku) với `/profile affinity`. |
| 🧹 **Dọn dẹp & Phát hiện trùng** | Quét và cảnh báo các profile trùng tài khoản email/UUID, token hỏng hoặc hết hạn (`/profile cleanup`). |
| ☁️ **Đồng bộ mã hóa từ xa (Sync)** | Đẩy/kéo bản sao lưu mã hóa AES-256 an toàn đa thiết bị (`/profile sync push` / `pull`). |
| 📋 **Danh sách trực quan** | Icon 🟢 Active / ⚪ Inactive, email 👤, nhãn 🏷️, hiển thị nhanh quota và màu sắc nổi bật trên terminal. |
| 📊 **Usage từng profile** | Quota 5 giờ, 7 ngày và theo model (Opus, Sonnet…). Thanh màu theo mức: 🟢 < 50% · 🟡 < 80% · 🟠 < 95% · 🔴 ≥ 95%, kèm ⚠ từ 80%. |
| 🤖 **Tự động chuyển profile** | Tự động switch khi vượt ngưỡng token hoặc bị rate limit (ưu tiên account còn nhiều token, reset sớm hơn hoặc theo danh sách cài đặt). |
| ⏱️ **Đếm ngược Cooldown & Auto-Return** | Theo dõi đồng hồ đếm ngược reset quota 5h và tự động quay về tài khoản chính khi đã hồi phục. |
| 🩺 **Khám sức khỏe Profile Doctor** | Chẩn đoán toàn diện OAuth token, thời hạn `expiresAt`, lỗi cú pháp JSON và tình trạng rate limit. |
| 🚨 **Bảo vệ hạn mức 7 ngày** | Tự động ngăn chặn switch vào các tài khoản có quota 7 ngày chạm ngưỡng nguy hiểm (mặc định 85%). |
| 💻 **Tích hợp Shell Prompt & Tmux** | Hiển thị active profile & usage % cực nhanh (<5ms) trên prompt Starship, Zsh, Bash hoặc thanh Tmux. |
| ⏳ **Mượn profile tạm thời (Temp Swap)** | Mượn tạm profile thứ hai trong thời gian định trước (vd `30m`, `1h`) và tự động hoàn trả khi hết giờ. |
| 📁 **Gắn profile theo dự án** | Tự động kích hoạt đúng profile khi mở thư mục dự án tương ứng thông qua file `.claude-profile`. |
| 🔔 **Thông báo hệ thống** | Nhận thông báo desktop banner (macOS / Linux / Windows) ngay khi hệ thống tự động đổi profile. |
| 🏷️ **Tag & Pool chuyển đổi** | Gắn nhãn phân loại (vd: `work`, `hobby`) và giới hạn phạm vi tự động switch theo nhóm cụ thể. |
| 🔐 **Sao lưu mã hóa AES-256** | Xuất/nhập toàn bộ profile được mã hóa an toàn với mật khẩu cá nhân (PBKDF2 + AES-256-GCM). |
| 📜 **Lịch sử & Thống kê** | Ghi nhận nhật ký chuyển đổi và thống kê tổng số lần swap (thủ công, tự động, theo dự án). |
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
| `/profile` | Hiển thị hướng dẫn sử dụng tất cả các lệnh của claude-swap |
| `/profile list` | Liệt kê các profile kèm icon 🟢/⚪, email 👤, nhãn 🏷️ và thanh usage tóm tắt |
| `/profile <tên\|alias>` | Chuyển sang profile hoặc bí danh (alias) `<tên>` |
| `/profile pick` | Chọn profile tương tác bằng phím mũi tên `↑` `↓` ngay trong terminal |
| `/profile alias <tên> <profile>` | Đặt bí danh viết tắt cho profile (vd: `/profile alias w work`) |
| `/profile unalias <tên>` | Xóa bí danh |
| `/profile aliases` | Xem danh sách tất cả các bí danh |
| `/profile forecast` | Dự báo tốc độ tiêu thụ token (%/giờ) và thời gian cạn hạn mức |
| `/profile bind-branch <pat> [tên]` | Liên kết profile theo mẫu nhánh Git (vd: `feat/*`, `work-*`) |
| `/profile unbind-branch [pat]` | Gỡ liên kết nhánh Git |
| `/profile branch-bindings` | Xem danh sách các liên kết nhánh Git đã cài đặt |
| `/profile affinity <model> <tên>` | Gán profile chuyên dụng cho model (Opus, Sonnet...) |
| `/profile affinity apply <model>` | Tự chuyển sang profile đã gán cho model |
| `/profile unaffinity <model>` | Gỡ gán model affinity |
| `/profile affinities` | Xem danh sách các gán model affinity |
| `/profile cleanup [--force]` | Quét phát hiện profile trùng lặp, token cũ hỏng (dùng `--force` để dọn) |
| `/profile sync setup <path>` | Thiết lập đường dẫn file đồng bộ đa thiết bị |
| `/profile sync push [--password <pw>]` | Đẩy bản sao lưu mã hóa lên file/kho lưu trữ đồng bộ |
| `/profile sync pull [--password <pw>]` | Kéo và giải mã bản sao lưu từ kho lưu trữ đồng bộ |
| `/profile sync status` | Xem trạng thái đồng bộ |
| `/profile usage` | Xem chi tiết quota 5 giờ / 7 ngày / theo model của từng profile |
| `/profile auto` | Xem trạng thái tự động chuyển profile khi vượt ngưỡng token |
| `/profile auto on` / `off` | Bật / tắt tính năng tự động chuyển profile |
| `/profile auto threshold <%>` | Thiết lập ngưỡng % mức dùng để tự động switch (mặc định: `95%`) |
| `/profile auto order <ds>` | Cài đặt thứ tự ưu tiên các account sẽ switch (vd: `work,personal`) |
| `/profile auto order default` | Chuyển về quy tắc tự động (nhiều token hơn + reset sớm hơn) |
| `/profile auto pool <tag\|all>` | Giới hạn auto-switch chỉ chọn các profile có tag chỉ định |
| `/profile auto safeguard [on\|off\|<%>]` | Bật/tắt bảo vệ hạn mức 7 ngày (mặc định: `85%`) |
| `/profile auto return [on\|off]` | Bật/tắt tự động quay về profile chính khi hồi phục token |
| `/profile auto primary <tên>` | Chỉ định profile chính để auto-return quay về |
| `/profile auto check` | Kiểm tra quota và switch ngay nếu vượt ngưỡng |
| `/profile cooldown` | Xem đồng hồ đếm ngược reset quota 5 giờ của tất cả profiles |
| `/profile doctor` | Quét chẩn đoán sức khỏe, hạn token OAuth và kết nối các profile |
| `/profile temp <tên> [thời_gian]` | Mượn tạm profile trong một khoảng thời gian (vd: `30m`, `1h`, `2h30m`) |
| `/profile untemp` | Hủy chế độ mượn tạm và quay lại profile ban đầu ngay lập tức |
| `/profile statusline` | Xuất chuỗi trạng thái rút gọn cho shell prompt (vd: `[Claude: 🟢 work (32%)]`) |
| `/profile prompt [starship\|zsh\|bash\|tmux]` | Hướng dẫn và snippet cấu hình shell prompt |
| `/profile bind [tên]` | Liên kết thư mục hiện tại với profile (lưu vào `.claude-profile`) |
| `/profile unbind` | Gỡ liên kết profile khỏi thư mục hiện tại |
| `/profile notify [on\|off]` | Bật / tắt thông báo desktop banner khi tự động switch |
| `/profile tag <tên> <tag>` | Gắn tag cho profile (vd: `/profile tag work company`) |
| `/profile untag <tên> <tag>` | Gỡ tag khỏi profile |
| `/profile tags` | Xem danh sách tất cả các tag và profile thuộc về |
| `/profile history [n]` | Xem nhật ký các lần chuyển profile gần nhất (mặc định 10 lần) |
| `/profile stats` | Thống kê số lần đổi profile thủ công, tự động và theo dự án |
| `/profile export <file> --password <pw>` | Xuất bản sao lưu profiles mã hóa AES-256-GCM |
| `/profile import-enc <file> --password <pw> [--force]` | Khôi phục profiles từ file mã hóa |
| `/profile new <tên> [--force]` | Tạo profile mới từ tài khoản hiện tại |
| `/profile save <tên> [--force]` | Lưu thông tin đăng nhập hiện tại vào profile |
| `/profile delete <tên>` | Xoá profile |
| `/profile import <thư mục> [--force]` | Nhập các profile thô từ thư mục khác |
| `/profile folder` | Mở thư mục chứa file cấu hình profile |
| `/profile lang [vi\|en]` | Xem hoặc chuyển đổi ngôn ngữ hiển thị (Tiếng Việt / English) |

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
node swap.js history
node swap.js stats
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
├── LICENSE               # Giấy phép mã nguồn mở MIT
└── .claude-plugin/       # Plugin manifest & marketplace config
```

## 🌐 Đa ngôn ngữ (Bilingual: vi / en)

`claude-swap` hỗ trợ đầy đủ hai ngôn ngữ: **Tiếng Việt** và **Tiếng Anh**.

```bash
/profile lang           # Xem ngôn ngữ hiện tại
/profile lang en        # Chuyển sang Tiếng Anh
/profile lang vi        # Chuyển sang Tiếng Việt
```

Cấu hình ngôn ngữ được lưu tại `~/.config/claude-cli-profiles/.language.json` hoặc điều khiển qua biến môi trường `CLAUDE_SWAP_LANG=en|vi`.

## 📄 License

Dự án được phân phối dưới giấy phép [MIT](LICENSE).

