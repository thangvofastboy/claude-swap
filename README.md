<div align="center">

# 🔀 claude-swap

**Chuyển đổi nóng giữa nhiều tài khoản Claude Code — không thoát session, không mất ngữ cảnh.**

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-1f2937)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin%20%2Fprofile-d97757)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-success)
![License MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![i18n](https://img.shields.io/badge/i18n-Tiếng%20Việt%20%7C%20English-orange)

[Tính năng](#-tính-năng) ·
[Cài đặt](#-cài-đặt) ·
[Bắt đầu nhanh](#-bắt-đầu-nhanh) ·
[Web Dashboard](#-web-dashboard--cấu-hình-trực-quan) ·
[Bảng lệnh đầy đủ](#-bảng-lệnh-profile) ·
[Session song song](#-chạy-session-song-song-cách-ly) ·
[Cách hoạt động](#-cách-hoạt-động) ·
[Đa ngôn ngữ](#-đa-ngôn-ngữ-vi--en) ·
[Phát triển & Test](#️-phát-triển--kiểm-thử)

</div>

---

Tài khoản cá nhân, công ty, tài khoản dự phòng, dự án khách hàng… mỗi tài khoản một profile, đổi qua lại ngay trong Claude Code mà không cần thoát session hay làm gián đoạn luồng suy nghĩ.

Plugin chạy trực tiếp trên môi trường **Node.js** sẵn có của Claude Code: **không cần Python, không cần cài thêm bất kỳ thư viện ngoài nào (100% zero-dependencies)**.

---

## ✨ Tính năng

| Nhóm | Chi tiết tính năng |
| --- | --- |
| 🌐 **Web Dashboard UI** | Bảng điều khiển web hiện đại (`/profile web`), 1-click switch, cấu hình trực tiếp plugin trên trình duyệt và trang tài liệu hướng dẫn chuyên sâu. |
| 💾 **Quản lý Profile** | Tạo, lưu, chuyển đổi, xóa profile. Hỗ trợ `/profile new <tên>`, `/profile save <tên>`, `/profile delete <tên>`. |
| 🔤 **Profile Aliases** | Đặt tên viết tắt ngắn gọn (vd: `w` ➔ `work-company`) để chuyển cực nhanh bằng `/profile w`. |
| 🎛️ **Interactive Picker** | Gõ `/profile pick` để chọn profile bằng phím mũi tên `↑` `↓` trực quan ngay trong terminal. |
| ⚖️ **Smart Load Balancing** | Chủ động phân bổ lưu lượng quota qua thuật toán `least-used` (ưu tiên còn nhiều token nhất) hoặc `round-robin` với `/profile balance`. |
| 🔔 **Notification Webhooks**| Gửi thông báo tức thì đến Telegram, Discord, Slack hoặc Generic Webhook khi chạm ngưỡng hoặc đổi account (`/profile webhook`). |
| 💰 **Budget & Cost Tracker** | Thiết lập trần ngân sách chi tiêu tối đa hàng tháng theo từng tài khoản (`/profile budget`). |
| 🛡️ **Masking & Safe Share** | Tự động che mờ email cá nhân (`us***@domain.com`) và xuất file cấu hình an toàn không chứa token (`/profile mask`, `/profile share`). |
| ⌨️ **Shell Auto-Completion** | Tự động sinh mã gợi ý lệnh qua phím `Tab` cho Bash, Zsh, Fish (`/profile completion`). |
| 🚀 **Parallel Sessions** | Chạy session Claude Code độc lập song song (`/profile run <tên>`) với môi trường cách ly hoàn toàn. |
| 🔑 **Setup-Token & API Key** | Đăng ký trực tiếp profile từ token không cần browser với `/profile add-token <tok\|->` (hỗ trợ đọc bảo mật từ `stdin`). |
| 🚫 **Disable / Enable Auto** | Tạm loại trừ profile khỏi auto-switch (`/profile disable <tên>`) mà không cần xóa tài khoản. |
| 🌿 **Git Branch Binding** | Tự động chuyển profile theo mẫu nhánh Git (vd: `work-*` ➔ công ty, `feat/*` ➔ dev). |
| 📁 **Gắn profile thư mục** | Tự động kích hoạt đúng profile khi mở thư mục dự án tương ứng qua file `.claude-profile`. |
| 📈 **Quota & Forecast** | Dự báo tốc độ tiêu thụ % token/giờ và thời điểm ước tính cạn hạn mức (`/profile forecast`). |
| ⏱️ **Cooldown & Auto-Return** | Đồng hồ đếm ngược reset quota 5h và tự động quay về profile chính khi hồi phục token. |
| 🤖 **Tự động chuyển profile** | Tự động switch khi chạm ngưỡng % token hoặc rate limit (ưu tiên quota dồi dào, reset sớm nhất). |
| 🚨 **Safeguard 7 ngày** | Tự động bảo vệ hạn mức dài hạn, ngăn chặn switch vào các tài khoản sắp cạn quota 7 ngày (mặc định: 85%). |
| 🧠 **Model-Affinity** | Gán profile chuyên dụng theo từng dòng model AI (Opus, Sonnet, Haiku) với `/profile affinity`. |
| 🩺 **Profile Doctor & Cleanup**| Quét chẩn đoán sức khỏe, token hết hạn, profile trùng lặp tài khoản (`/profile doctor`, `/profile cleanup`). |
| ☁️ **Đồng bộ mã hóa (Sync)** | Đẩy/kéo bản sao lưu mã hóa AES-256 an toàn đa thiết bị (`/profile sync push` / `pull`). |
| 💻 **Shell Prompt & Tmux** | Hiển thị active profile & usage % cực nhanh (<5ms) trên prompt Starship, Zsh, Bash hoặc thanh Tmux. |
| ⏳ **Mượn profile tạm (Temp)** | Mượn tạm profile thứ hai trong thời gian định trước (vd: `30m`, `1h`) và tự động hoàn trả khi hết giờ. |
| 📊 **JSON Output Mode** | Hỗ trợ cờ `--json` trên `/profile list`, `/profile current`, `/profile disabled` phục vụ viết script/CI. |
| 🌐 **Bilingual (vi / en)** | Đổi ngôn ngữ mượt mà giữa Tiếng Việt và Tiếng Anh chỉ với một lệnh `/profile lang [vi\|en]`. |
| ⚡ **Zero Token Cost** | Mọi lệnh `/profile` là plugin hook xử lý tức thì ở local, **không tốn lượt hỏi hay token model**. |

---

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

---

## 🚀 Bắt đầu nhanh

1. Đăng nhập Claude Code bằng tài khoản đầu tiên (`claude` → `/login`), lưu thành profile:
   ```text
   /profile new work
   ```
2. Đăng xuất hoặc `/login` sang tài khoản thứ hai (vd: tài khoản cá nhân):
   ```text
   /profile new personal
   ```
3. Xem danh sách profile hoặc mở Web Dashboard:
   ```text
   /profile list    # Hiển thị danh sách profile kèm thanh usage %
   /profile web     # Mở giao diện Web Dashboard trực quan
   ```
4. Chuyển đổi giữa các profile bất kỳ lúc nào:
   ```text
   /profile work
   ```

---

## 🌐 Web Dashboard & Cấu hình Trực quan

Khởi chạy giao diện Web Dashboard trực quan và hiện đại ngay trên trình duyệt máy tính:

```bash
/profile web              # Mở Dashboard tại http://localhost:3737
/profile web --port 8080  # Tùy chỉnh cổng port
/profile web stop         # Dừng web dashboard chạy ngầm
```

- **Giao diện hiện đại & Dark Mode:** Xem tình trạng tất cả các profile, thẻ đo % quota 5h & 7d theo thời gian thực và đồng hồ đếm ngược reset cooldown trực quan.
- **1-Click Profile Switch:** Chuyển đổi sang bất kỳ profile nào chỉ bằng 1 cú nhấp chuột.
- **Cấu hình Plugin trực tiếp:** Tùy chỉnh thanh trượt Auto-Switch Threshold %, Safeguard 7 ngày, Load Balancer, Webhooks, Ngân sách (Budget), và Chế độ che mờ bảo mật (Masking).
- **Trang hướng dẫn chi tiết (Documentation Tab):** Tích hợp sẵn trang tra cứu và giải thích sâu toàn bộ tính năng, bảng lệnh, và mẹo sử dụng.

---

## 📋 Bảng lệnh `/profile`

### 📌 Quản lý & Chuyển đổi Profile

| Lệnh | Mô tả |
| --- | --- |
| `/profile` | Hiển thị bảng hướng dẫn sử dụng đầy đủ các lệnh |
| `/profile list [--json]` | Liệt kê các profile kèm icon 🟢/⚪, email 👤, nhãn 🏷️ và thanh usage |
| `/profile current [--json]` | Hiển thị tên profile đang kích hoạt (active) |
| `/profile <tên\|alias>` | Chuyển sang profile hoặc bí danh (alias) `<tên>` |
| `/profile pick` | Chọn profile tương tác bằng phím mũi tên `↑` `↓` ngay trong terminal |
| `/profile alias <tên> <p>` | Đặt bí danh viết tắt cho profile (vd: `/profile alias w work`) |
| `/profile unalias <tên>` | Xóa bí danh đã đặt |
| `/profile aliases` | Xem danh sách các bí danh đang có |
| `/profile new <tên> [--force]` | Tạo profile mới từ tài khoản hiện tại |
| `/profile save <tên> [--force]`| Lưu thông tin đăng nhập hiện tại vào profile |
| `/profile delete <tên>` | Xóa profile và dọn dẹp các tài nguyên liên quan |
| `/profile folder` | Mở thư mục chứa file cấu hình profile trên máy |
| `/profile lang [vi\|en]` | Xem hoặc đổi ngôn ngữ hiển thị (Tiếng Việt / English) |
| `/profile version` | Xem phiên bản hiện tại của plugin |

### 🚀 Giao diện Web, Cân bằng tải & Tiện ích Nâng cao

| Lệnh | Mô tả |
| --- | --- |
| `/profile web [--port <p>]` | Mở Web Dashboard trực quan và cấu hình plugin trên trình duyệt |
| `/profile web stop` | Dừng Web Dashboard đang chạy ngầm |
| `/profile balance [on\|off]` | Bật / tắt tính năng cân bằng tải Quota chủ động |
| `/profile balance mode <least-used\|round-robin>` | Chọn thuật toán cân bằng tải (ưu tiên token nhiều nhất hoặc luân phiên) |
| `/profile balance pool <tag\|all>` | Giới hạn cân bằng tải trong nhóm có tag |
| `/profile balance next` | Chuyển ngay sang profile tiếp theo theo thuật toán cân bằng |
| `/profile webhook [status]` | Xem trạng thái các Webhook cảnh báo từ xa |
| `/profile webhook set <telegram\|discord\|slack\|generic> <url>` | Thiết lập đường dẫn Webhook |
| `/profile webhook unset <type>` | Gỡ bỏ Webhook |
| `/profile webhook test` | Gửi thử thông báo kiểm tra kết nối Webhook |
| `/profile budget [status]` | Xem danh sách hạn mức ngân sách hàng tháng |
| `/profile budget set <tên> <số_tiền>` | Đặt hạn mức chi tiêu hàng tháng cho profile |
| `/profile budget unset <tên>` | Xóa hạn mức ngân sách |
| `/profile mask [on\|off]` | Bật / tắt che mờ thông tin email & token cá nhân |
| `/profile share [file.json]` | Xuất gói cấu hình an toàn (không chứa token/credentials) |
| `/profile completion [bash\|zsh\|fish]` | Sinh mã tự động gợi ý phím Tab cho shell |

### ⚡ Session Song Song & Token Trực Tiếp

| Lệnh | Mô tả |
| --- | --- |
| `/profile run <tên> [-- cmd]` | Chạy session Claude Code độc lập song song cho profile chỉ định |
| `/profile add-token <tok> [tên]` | Tạo profile trực tiếp từ setup-token hoặc API key |
| `echo $TOK \| node swap.js add-token - [tên]` | Nhập token an toàn từ `stdin` không lưu vào history shell |
| `/profile upgrade` | Cập nhật plugin lên bản mới nhất từ marketplace |
| `/profile disable <tên>` | Tạm dừng đưa profile vào vòng xoay auto-switch |
| `/profile enable <tên>` | Bật lại profile vào vòng xoay auto-switch |
| `/profile disabled [--json]` | Xem danh sách các profile đang bị tạm dừng auto |

### 🤖 Tự động chuyển đổi (Auto-Switch) & Quota

| Lệnh | Mô tả |
| --- | --- |
| `/profile usage` | Xem chi tiết quota 5h, 7d và từng model (Opus, Sonnet, Haiku...) |
| `/profile auto` | Xem trạng thái tính năng tự động chuyển profile |
| `/profile auto on` / `off` | Bật / tắt tự động chuyển khi vượt ngưỡng token |
| `/profile auto threshold <%>` | Đặt ngưỡng % mức dùng để kích hoạt chuyển (mặc định: `95%`) |
| `/profile auto order <ds>` | Cài đặt danh sách ưu tiên switch (vd: `work,personal,backup`) |
| `/profile auto pool <tag\|all>`| Giới hạn auto-switch chỉ chọn trong nhóm profile có tag |
| `/profile auto safeguard [on\|off\|<%>]` | Bật/tắt bảo vệ hạn mức 7 ngày (mặc định: `85%`) |
| `/profile auto return [on\|off]` | Tự động quay về profile chính khi token đã hồi phục |
| `/profile auto primary <tên>` | Đặt profile chính để auto-return quay về |
| `/profile auto check` | Kiểm tra quota tức thì và chuyển ngay nếu chạm ngưỡng |
| `/profile forecast` | Dự báo tốc độ tiêu thụ %/h và thời điểm cạn hạn mức quota |
| `/profile cooldown` | Đồng hồ đếm ngược thời gian reset quota 5h của các tài khoản |
| `/profile doctor` | Quét kiểm tra sức khỏe token OAuth, cú pháp và kết nối |
| `/profile cleanup [--force]` | Quét phát hiện profile trùng lặp email/UUID, token hỏng |

### 📁 Dự án, Nhánh Git, Tag & Model Affinity

| Lệnh | Mô tả |
| --- | --- |
| `/profile bind [tên]` | Liên kết thư mục dự án hiện tại với profile (file `.claude-profile`) |
| `/profile unbind` | Gỡ liên kết profile khỏi thư mục hiện tại |
| `/profile bind-branch <pat> [tên]` | Liên kết profile theo mẫu nhánh Git (vd: `feat/*`, `hotfix-*`) |
| `/profile unbind-branch [pat]`| Gỡ liên kết nhánh Git |
| `/profile branch-bindings` | Xem danh sách liên kết nhánh Git |
| `/profile tag <tên> <tag>` | Gắn thẻ nhãn phân loại cho profile (vd: `/profile tag work corp`) |
| `/profile untag <tên> <tag>` | Gỡ thẻ nhãn khỏi profile |
| `/profile tags` | Xem danh sách các thẻ nhãn và profiles thuộc về |
| `/profile affinity <model> <tên>` | Gán profile chuyên dụng cho model (vd: `opus`, `sonnet`) |
| `/profile affinity apply <model>` | Áp dụng chuyển sang profile đã gán cho model |
| `/profile unaffinity <model>` | Gỡ gán model affinity |
| `/profile affinities` | Xem danh sách gán model affinity |

### ⏳ Mượn tạm & Đồng bộ (Sync)

| Lệnh | Mô tả |
| --- | --- |
| `/profile temp <tên> [tg]` | Mượn tạm profile trong thời gian định trước (vd: `30m`, `1h`) |
| `/profile untemp` | Hủy mượn tạm và quay về profile gốc ngay lập tức |
| `/profile statusline` | Chuỗi trạng thái rút gọn cho shell prompt (vd: `[Claude: 🟢 work (32%)]`) |
| `/profile prompt [shell]` | Hướng dẫn cấu hình prompt (`starship`, `zsh`, `bash`, `tmux`) |
| `/profile notify [on\|off]` | Bật / tắt thông báo desktop banner khi đổi profile |
| `/profile history [n]` | Xem lịch sử các lần chuyển đổi gần nhất (mặc định 10 lần) |
| `/profile stats` | Thống kê số lần chuyển đổi thủ công, tự động và theo dự án |
| `/profile sync setup <path>` | Cài đặt đường dẫn kho lưu trữ đồng bộ mã hóa |
| `/profile sync push [--password <pw>]` | Đẩy bản sao lưu mã hóa lên kho đồng bộ |
| `/profile sync pull [--password <pw>]` | Kéo và giải mã bản sao lưu từ kho đồng bộ |
| `/profile export <file> --password <pw>` | Xuất file sao lưu mã hóa AES-256-GCM |
| `/profile import-enc <file> --password <pw>` | Khôi phục profiles từ file mã hóa |
| `/profile import <thư_mục> [--force]` | Nhập các profile thô từ thư mục khác |

---

## 🖥️ Minh họa giao diện

### Khi chạy `/profile list`:

```text
🟢 work (Active)  👤 work@company.com  5h [███░░░░░] 32%   7d [█████░░░] 64%
⚪ personal       👤 user@gmail.com    5h [███████░] 85% ⚠   7d [███░░░░░] 40%
⚪ dev-account
```

*Thanh màu trực quan theo mức sử dụng:*
- 🟢 `< 50%`: Quota an toàn
- 🟡 `< 80%`: Mức dùng trung bình
- 🟠 `< 95%`: Sắp đầy
- 🔴 `≥ 95%`: Chạm ngưỡng nguy hiểm
- Cảnh báo ⚠️ tự động bật từ mức `80%`.

### Chạy CLI ngoài terminal thông thường:

```bash
node swap.js list
node swap.js swap work
node swap.js usage
node swap.js balance on
node swap.js web
```

---

## 🔀 Chạy session song song cách ly

Bạn có thể chạy nhiều session Claude Code song song cùng lúc với các tài khoản khác nhau mà không sợ đè token hay xung đột phiên làm việc:

```bash
# Khởi chạy một session Claude Code riêng biệt cho profile work
node swap.js run work

# Hoặc truyền lệnh tùy ý chạy trong môi trường của profile work
node swap.js run work -- claude --model claude-3-7-sonnet
```

Session sẽ được lưu tách biệt tại `~/.claude-swap/.sessions/<tên>` với biến môi trường `CLAUDE_CONFIG_DIR`, bảo đảm an toàn dữ liệu và vệ sinh credential tuyệt đối.

---

## 🧠 Cách hoạt động

Profile được lưu tại `~/.config/claude-cli-profiles/<tên>.json` (phân quyền riêng tư `0600`, thư mục `0700`):

- Các khóa xác thực trong `~/.claude.json` (`oauthAccount`, `primaryApiKey`, `customApiKeyResponses`).
- Token OAuth trong `~/.claude/.credentials.json` (hoặc Keychain trên macOS).

**Khi đổi profile:**
- Plugin chỉ trích xuất và hoán đổi các khóa xác thực đăng nhập, **giữ nguyên toàn bộ cấu hình dự án, cài đặt cá nhân và lịch sử session** trong `~/.claude.json`.
- Tự động sao lưu token mới nhất của profile hiện tại trước khi chuyển đổi (nếu token vừa được Claude Code tự động refresh).
- Ghi nguyên tử (atomic write qua file tạm) và tự tạo bản backup `.bak` chống mất mát dữ liệu khi mất điện hoặc crash đột ngột.

---

## 🌐 Đa ngôn ngữ (vi / en)

`claude-swap` hỗ trợ đầy đủ song ngữ: **Tiếng Việt** (mặc định) và **Tiếng Anh**.

```bash
/profile lang           # Xem ngôn ngữ hiện tại
/profile lang en        # Chuyển sang Tiếng Anh
/profile lang vi        # Chuyển sang Tiếng Việt
```

Bạn cũng có thể ép ngôn ngữ qua biến môi trường:
```bash
export CLAUDE_SWAP_LANG=en
```

---

## 🛠️ Phát triển & Kiểm thử

Dự án có bộ test suite toàn diện kiểm tra mọi tính năng:

```bash
npm test                   # Chạy 46 unit tests của swap.js (node --test)
claude plugin validate .   # Kiểm tra tính hợp lệ của manifest và hooks
claude plugin test .       # Chạy 11 tests kiểm thử plugin hook của Claude Code
```

### Cấu trúc dự án:

```text
claude-swap/
├── swap.js               # Core engine xử lý profile, credentials, sync & usage (Node.js)
├── web.js                # Web Dashboard Mini UI, REST API & Documentation
├── package.json          # Cấu hình project, test script & metadata
├── hooks/
│   ├── hooks.json        # Đăng ký hook với Claude Code
│   ├── register.ts       # Hook session.start, prompt.submit & command.run cho /profile
│   └── register.test.ts  # Test suite cho plugin hooks (11 tests)
├── test/
│   └── swap.test.js      # Unit tests cho swap.js (46 tests)
├── LICENSE               # Giấy phép mã nguồn mở MIT
└── .claude-plugin/       # Plugin manifest & marketplace config
```

---

## 📄 License

Dự án được phân phối dưới giấy phép mã nguồn mở [MIT](LICENSE).
