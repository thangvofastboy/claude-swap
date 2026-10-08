<div align="center">

**Tiếng Việt** · [English](README.en.md)

# 🔀 claude-swap

**Một Claude Code, nhiều tài khoản, không ai phải thoát session.**

*Vì cái cảnh "You've reached your usage limit" lúc 2 giờ sáng, khi code đang chạy dở, không nên xảy ra với ai.*

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-1f2937)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin%20%2Fprofile-d97757)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-success)
![License MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![i18n](https://img.shields.io/badge/i18n-Tiếng%20Việt%20%7C%20English-orange)

[Tính năng](#-tính-năng) ·
[Cài đặt](#-cài-đặt) ·
[Bắt đầu nhanh](#-bắt-đầu-nhanh) ·
[Web Dashboard](#-web-dashboard) ·
[Bảng lệnh](#-bảng-lệnh-profile) ·
[Session song song](#-chạy-session-song-song) ·
[Bên trong có gì](#-bên-trong-có-gì) ·
[Đa ngôn ngữ](#-đa-ngôn-ngữ) ·
[Phát triển & Test](#️-phát-triển--kiểm-thử)

</div>

---

Bạn có tài khoản công ty, tài khoản cá nhân, tài khoản "dự phòng", và một tài khoản nữa mà chính bạn cũng không nhớ lập ra để làm gì. Mỗi lần đổi là một lần `/logout`, `/login`, mở trình duyệt, chờ redirect, và quên mất mình đang nghĩ gì.

**claude-swap** biến mỗi tài khoản thành một *profile*. Đổi bằng một lệnh, ngay trong session đang chạy. Ngữ cảnh còn nguyên, cuộc hội thoại còn nguyên, chỉ có tài khoản là khác.

Plugin chạy bằng chính **Node.js** mà Claude Code đã mang theo: **không cần Python, không `npm install`, đúng 0 dependency.** `node_modules` của dự án này nặng đúng 0 byte, và chúng tôi tự hào về điều đó.

---

## ✨ Tính năng

| Nhóm | Nó làm gì cho bạn |
| --- | --- |
| 🌐 **Web Dashboard** | `/profile web` mở một trang điều khiển trên trình duyệt: bấm một cái là đổi tài khoản, kéo thanh trượt để chỉnh cấu hình, có cả trang hướng dẫn. Dành cho những ngày không muốn gõ lệnh. |
| 💾 **Quản lý Profile** | Tạo, lưu, đổi, xóa: `/profile new`, `save`, `delete`. Bộ tứ cơ bản. |
| 🔤 **Alias** | Lười gõ `work-company-production-2`? Đặt `w` rồi `/profile w`. |
| 🎛️ **Picker tương tác** | `/profile pick` cho chọn bằng phím `↑` `↓`, dành cho người không nhớ nổi tên profile của mình. |
| ⚖️ **Cân bằng tải** | Chia đều công việc cho các tài khoản theo `least-used` (ai còn nhiều quota thì làm) hoặc `round-robin` (lần lượt từng người). Không tài khoản nào phải gánh team. |
| 🔔 **Webhook** | Báo qua Telegram, Discord, Slack hoặc webhook bất kỳ khi chạm ngưỡng hay đổi tài khoản. Điện thoại rung là biết quota sắp hết. |
| 💰 **Ngân sách** | Đặt trần chi tiêu hàng tháng cho từng profile (`/profile budget`). Ví tiền sẽ cảm ơn bạn. |
| 🛡️ **Che email & chia sẻ an toàn** | Email hiện thành `us***@domain.com` khi bạn share màn hình, và xuất cấu hình không kèm token (`/profile mask`, `/profile share`). |
| ⌨️ **Tab completion** | Sinh script gợi ý lệnh cho Bash, Zsh, Fish (`/profile completion`). Gõ nửa chữ rồi bấm Tab. |
| 🚀 **Session song song** | `/profile run <tên>` chạy thêm một Claude Code tách biệt với tài khoản khác. Hai Claude, hai tài khoản, không ai giẫm chân ai. |
| 🔑 **Setup-token & API key** | Tạo profile thẳng từ token, không cần trình duyệt (`/profile add-token`), đọc được cả từ `stdin` để token không nằm trong lịch sử shell. |
| 🚫 **Cho nghỉ phép** | `/profile disable <tên>` tạm loại một profile khỏi auto-switch mà không cần xóa. |
| 🌿 **Theo nhánh Git** | Nhánh `work-*` dùng tài khoản công ty, `feat/*` dùng tài khoản dev, tự động. Chẳng còn cảnh lỡ tay dùng tài khoản công ty cho side project. |
| 📁 **Theo thư mục** | Mở dự án nào thì tự bật đúng profile của dự án đó (file `.claude-profile`). |
| 📈 **Dự báo** | Đo tốc độ tiêu thụ %/giờ và đoán khi nào cạn (`/profile forecast`). Cái gì cũng tính được, trừ deadline. |
| ⏱️ **Cooldown & tự quay về** | Đếm ngược tới lúc quota 5 giờ reset, rồi tự đưa bạn về profile chính khi tài khoản đó hồi sức. |
| 🤖 **Tự đổi tài khoản** | Chạm ngưỡng % hoặc dính rate limit thì tự nhảy sang tài khoản còn nhiều quota nhất hoặc reset sớm nhất. Bạn chỉ việc code tiếp. |
| 🚨 **Bảo vệ hạn mức 7 ngày** | Không nhảy vào tài khoản đã dùng gần hết quota tuần (mặc định 85%). |
| 🧠 **Model affinity** | Opus chạy tài khoản này, Sonnet chạy tài khoản kia (`/profile affinity`). |
| 🩺 **Doctor & Cleanup** | Khám token hết hạn, profile trùng tài khoản, file hỏng (`/profile doctor`, `/profile cleanup`). Thầy thuốc cho credentials. |
| ☁️ **Sync mã hóa** | Đẩy và kéo bản sao lưu mã hóa AES-256 giữa các máy (`/profile sync push` / `pull`). |
| 💻 **Shell prompt & Tmux** | Hiện profile đang dùng kèm % usage trên Starship, Zsh, Bash, Tmux, chạy dưới 5ms. |
| ⏳ **Mượn tạm** | Mượn một profile trong `30m` hay `1h` rồi tự trả. Như mượn sạc của đồng nghiệp, nhưng lần này có người nhắc trả. |
| 📊 **JSON** | `--json` cho `list`, `current`, `disabled`, để script và CI đọc được. |
| 🌐 **Song ngữ** | Tiếng Việt hoặc tiếng Anh, `/profile lang [vi\|en]`. |
| ⚡ **Không tốn token** | Mọi lệnh `/profile` chạy local qua plugin hook, **không gửi gì cho model và không tốn lượt nào**. |

---

## 📦 Cài đặt

Gõ ngay trong Claude Code:

```bash
/plugin install profile-swap --marketplace thangvofastboy/claude-swap
```

*(Claude hỏi có thêm marketplace không thì bấm `y`, rồi chọn phạm vi cài đặt.)*

Muốn thử thẳng từ source mà chưa cài:

```bash
claude --plugin-dir /path/to/claude-swap
```

Đã cài rồi và muốn bản mới nhất: `/profile upgrade`, rồi khởi động lại Claude Code.

---

## 🚀 Bắt đầu nhanh

Bốn bước, chưa kịp nguội ly cà phê:

1. Đăng nhập tài khoản thứ nhất (`claude` → `/login`), rồi lưu lại:
   ```text
   /profile new work
   ```
2. `/login` sang tài khoản thứ hai, lưu tiếp:
   ```text
   /profile new personal
   ```
3. Xem mình đang có gì:
   ```text
   /profile list    # danh sách kèm thanh usage %
   /profile web     # hoặc mở dashboard
   ```
4. Đổi qua lại thoải mái:
   ```text
   /profile work
   ```

Vậy là xong. Không còn phải nhớ mật khẩu nào là của tài khoản nào.

---

## 🌐 Web Dashboard

Cho những ngày mắt cần thứ gì đó đẹp hơn terminal:

```bash
/profile web              # mở dashboard tại http://127.0.0.1:3737
/profile web --port 8080  # đổi cổng
/profile web stop         # tắt dashboard đang chạy ngầm
```

- **Nhìn một cái là thấy hết:** quota 5h và 7d của từng tài khoản, đồng hồ đếm ngược tới lúc reset, có dark mode.
- **Đổi tài khoản bằng một cú nhấp.**
- **📈 Tab Thống kê:** biểu đồ mức dùng quota 5h/7d theo thời gian cho từng tài khoản, số lần đổi profile mỗi ngày (thủ công / tự động / theo dự án), tài khoản được dùng nhiều nhất, bảng dự báo lúc cạn quota và lịch sử đổi gần đây. Biểu đồ tự vẽ bằng SVG, vẫn 0 dependency.
- **🧰 Tab Tính năng:** mọi lệnh `/profile` đều có form riêng: alias, tag, gắn thư mục và nhánh Git, model affinity, mượn tạm, ngân sách, webhook, sao lưu / đồng bộ mã hóa, snippet cho shell… Điền rồi bấm ▶, kết quả hiện ngay bên dưới. Mật khẩu sao lưu đi qua stdin, không nằm trên dòng lệnh.
- **Chỉnh cấu hình bằng chuột:** ngưỡng auto-switch, safeguard 7 ngày, cân bằng tải, webhook, ngân sách, che email.
- **Có sẵn trang hướng dẫn** để bạn khỏi phải quay lại README này.

Dashboard chỉ lắng nghe trên `127.0.0.1`, từ chối request lạ, và mỗi lần khởi động lại tạo một token bí mật mới. Token nằm sau dấu `#` trong link mà `/profile web` in ra, nên chỉ trình duyệt của bạn biết. Hàng xóm cùng Wi-Fi hay user khác trên cùng máy đều không đổi tài khoản giùm bạn được. Lỡ đóng tab thì chạy lại `/profile web` để lấy link.

---

## 📋 Bảng lệnh `/profile`

Phần này nghiêm túc hơn một chút, vì gõ sai lệnh thì không vui.

### 📌 Quản lý & chuyển đổi

| Lệnh | Mô tả |
| --- | --- |
| `/profile` | Hiện bảng hướng dẫn đầy đủ |
| `/profile list [--json]` | Liệt kê profile kèm icon 🟢/⚪, email 👤, nhãn 🏷️ và thanh usage |
| `/profile current [--json]` | Profile đang dùng là profile nào |
| `/profile <tên\|alias>` | Chuyển sang profile hoặc alias `<tên>` |
| `/profile pick` | Chọn profile bằng phím `↑` `↓` |
| `/profile alias <tên> <p>` | Đặt alias (vd: `/profile alias w work`) |
| `/profile unalias <tên>` | Xóa alias |
| `/profile aliases` | Xem các alias đang có |
| `/profile new <tên> [--force]` | Tạo profile mới từ tài khoản đang đăng nhập |
| `/profile save <tên> [--force]`| Lưu thông tin đăng nhập hiện tại vào profile |
| `/profile delete <tên>` | Xóa profile và dọn những thứ liên quan |
| `/profile folder` | Mở thư mục chứa profile |
| `/profile lang [vi\|en]` | Xem hoặc đổi ngôn ngữ |
| `/profile version` | Xem phiên bản plugin |

### 🚀 Web, cân bằng tải & tiện ích

| Lệnh | Mô tả |
| --- | --- |
| `/profile web [--port <p>]` | Mở Web Dashboard |
| `/profile web stop` | Tắt Web Dashboard |
| `/profile balance [on\|off]` | Bật / tắt cân bằng tải. Khi bật, auto-switch chọn profile kế tiếp theo `mode` (thay cho `auto order`) |
| `/profile balance mode <least-used\|round-robin>` | Chọn kiểu chia việc: ai còn nhiều quota nhất, hay lần lượt từng người |
| `/profile balance pool <tag\|all>` | Chỉ cân bằng trong nhóm có tag |
| `/profile balance next` | Chuyển ngay sang profile kế tiếp theo thuật toán |
| `/profile webhook [status]` | Xem trạng thái webhook |
| `/profile webhook set <telegram\|discord\|slack\|generic> <url>` | Cài webhook |
| `/profile webhook unset <type>` | Gỡ webhook |
| `/profile webhook test` | Gửi thử một tin |
| `/profile budget [status]` | Xem ngân sách hàng tháng |
| `/profile budget set <tên> <số_tiền>` | Đặt ngân sách cho profile |
| `/profile budget unset <tên>` | Xóa ngân sách |
| `/profile mask [on\|off]` | Bật / tắt che email trong list và dashboard |
| `/profile share [file.json]` | Xuất cấu hình không chứa token |
| `/profile completion [bash\|zsh\|fish]` | Sinh script Tab completion |

### ⚡ Session song song & token

| Lệnh | Mô tả |
| --- | --- |
| `/profile run <tên> [-- cmd]` | Chạy một session Claude Code tách biệt cho profile |
| `/profile add-token <tok> [tên]` | Tạo profile từ setup-token hoặc API key |
| `echo $TOK \| node swap.js add-token - [tên]` | Đưa token qua `stdin` để nó không nằm trong lịch sử shell |
| `/profile upgrade` | Cập nhật plugin lên bản mới nhất |
| `/profile disable <tên>` | Cho profile nghỉ, không tham gia auto-switch |
| `/profile enable <tên>` | Gọi profile đi làm lại |
| `/profile disabled [--json]` | Xem ai đang nghỉ |

### 🤖 Tự đổi tài khoản & quota

| Lệnh | Mô tả |
| --- | --- |
| `/profile usage` | Chi tiết quota 5h, 7d và từng model (Opus, Sonnet, Haiku…) |
| `/profile auto` | Trạng thái auto-switch |
| `/profile auto on` / `off` | Bật / tắt tự đổi khi vượt ngưỡng |
| `/profile auto threshold <%>` | Ngưỡng % để đổi (mặc định `95%`) |
| `/profile auto order <ds>` | Thứ tự ưu tiên (vd: `work,personal,backup`) |
| `/profile auto pool <tag\|all>`| Chỉ đổi trong nhóm có tag |
| `/profile auto safeguard [on\|off\|<%>]` | Bảo vệ hạn mức 7 ngày (mặc định `85%`) |
| `/profile auto return [on\|off]` | Tự quay về profile chính khi nó hồi quota |
| `/profile auto primary <tên>` | Đặt profile chính |
| `/profile auto check` | Kiểm tra quota ngay và đổi nếu cần |
| `/profile forecast` | Dự báo tốc độ tiêu thụ và lúc cạn quota |
| `/profile cooldown` | Đếm ngược tới lúc quota 5h reset |
| `/profile doctor` | Khám token OAuth, file cấu hình và kết nối |
| `/profile cleanup [--force]` | Tìm profile trùng email/UUID và token hỏng |

### 📁 Dự án, nhánh Git, tag & model

| Lệnh | Mô tả |
| --- | --- |
| `/profile bind [tên]` | Gắn profile cho thư mục hiện tại (file `.claude-profile`) |
| `/profile unbind` | Gỡ gắn thư mục |
| `/profile bind-branch <pat> [tên]` | Gắn profile theo mẫu nhánh Git (vd: `feat/*`, `hotfix-*`) |
| `/profile unbind-branch [pat]`| Gỡ gắn nhánh |
| `/profile branch-bindings` | Xem các nhánh đã gắn |
| `/profile tag <tên> <tag>` | Gắn tag (vd: `/profile tag work corp`) |
| `/profile untag <tên> <tag>` | Gỡ tag |
| `/profile tags` | Xem tag nào có những profile nào |
| `/profile affinity <model> <tên>` | Gán profile riêng cho model (vd: `opus`, `sonnet`) |
| `/profile affinity apply <model>` | Chuyển sang profile đã gán cho model đó |
| `/profile unaffinity <model>` | Gỡ gán model |
| `/profile affinities` | Xem các gán model |

### ⏳ Mượn tạm, lịch sử & sao lưu

| Lệnh | Mô tả |
| --- | --- |
| `/profile temp <tên> [tg]` | Mượn tạm profile trong một khoảng thời gian (vd: `30m`, `1h`) |
| `/profile untemp` | Trả ngay, quay về profile gốc |
| `/profile statusline` | Chuỗi trạng thái cho shell prompt (vd: `[Claude: 🟢 work (32%)]`) |
| `/profile prompt [shell]` | Snippet cấu hình cho `starship`, `zsh`, `bash`, `tmux`, `powershell` |
| `/profile notify [on\|off]` | Bật / tắt thông báo desktop khi đổi profile (mặc định tắt) |
| `/profile history [n]` | Lịch sử đổi profile gần đây (mặc định 10 lần) |
| `/profile stats` | Thống kê số lần đổi tay, đổi tự động và theo dự án |
| `/profile sync setup <path>` | Chọn nơi chứa bản đồng bộ mã hóa |
| `/profile sync push` | Đẩy bản sao lưu mã hóa lên |
| `/profile sync pull` | Kéo về và giải mã |
| `/profile export <file>` | Xuất file sao lưu AES-256-GCM |
| `/profile import-enc <file>` | Khôi phục từ file mã hóa |
| `/profile import <thư_mục> [--force]` | Nhập profile thô từ thư mục khác |

> 🔑 **Mật khẩu sao lưu không bao giờ được ghi xuống đĩa.** Đưa nó vào bằng `--password-stdin` (an toàn nhất: `echo "$PW" | node swap.js export f.enc --password-stdin`), biến môi trường `CLAUDE_SWAP_PASSWORD`, hoặc `--password <pw>` (cách này để lại mật khẩu trong lịch sử shell, nên chỉ dùng khi bạn tin cái lịch sử đó).

---

## 🖥️ Trông nó thế nào

### `/profile list`:

```text
🟢 work (Active)  👤 work@company.com  5h [███░░░░░] 32%   7d [█████░░░] 64%
⚪ personal       👤 user@gmail.com    5h [███████░] 85% ⚠   7d [███░░░░░] 40%
⚪ dev-account
```

*Màu thanh usage, như đèn giao thông:*
- 🟢 `< 50%`: thoải mái
- 🟡 `< 80%`: bắt đầu để ý
- 🟠 `< 95%`: liệu mà tiết kiệm
- 🔴 `≥ 95%`: auto-switch đang xỏ giày
- Từ `80%` trở lên sẽ có thêm ⚠️ cho chắc.

### Gọi từ terminal thường, ngoài Claude Code:

```bash
node swap.js list
node swap.js swap work
node swap.js usage
node swap.js balance on
node swap.js web
```

---

## 🔀 Chạy session song song

Hai tài khoản, hai cửa sổ, cùng lúc. Không giành token của nhau:

```bash
# Mở một Claude Code riêng cho profile work
node swap.js run work

# Hoặc chạy lệnh tùy ý trong môi trường của profile work
node swap.js run work -- claude --model sonnet
```

Mỗi session sống ở `~/.config/claude-cli-profiles/.sessions/<tên>` và dùng `CLAUDE_CONFIG_DIR` riêng. Khi session kết thúc, token đã được refresh sẽ được đồng bộ ngược về profile. Nếu bên trong session có ai đó đăng nhập sang tài khoản khác, plugin sẽ không chép nhầm tài khoản đó vào profile.

---

## 🧠 Bên trong có gì

Mỗi profile là một file `~/.config/claude-cli-profiles/<tên>.json` (quyền `0600`, thư mục `0700`, người ngoài không đọc được), gồm:

- Các khóa đăng nhập trong `~/.claude.json`: `oauthAccount`, `primaryApiKey`, `customApiKeyResponses`.
- Token OAuth trong `~/.claude/.credentials.json`, hoặc Keychain trên macOS.

**Khi bạn đổi profile:**
- Plugin chỉ thay đúng mấy khóa đăng nhập. **Cấu hình dự án, cài đặt và lịch sử trong `~/.claude.json` giữ nguyên.** Như thay chìa khóa xe, không ai tháo luôn cả cái xe.
- Trước khi đổi, plugin lưu lại token mới nhất của profile hiện tại, phòng khi Claude Code vừa âm thầm refresh nó.
- Mọi file được ghi qua file tạm rồi mới đổi tên (atomic write), kèm bản `.bak`. Mất điện giữa chừng cũng không mất profile.
- Nếu bạn đặt `CLAUDE_CONFIG_DIR`, plugin làm việc với thư mục đó thay cho `~/.claude`.
- Trên macOS, token được đưa vào Keychain qua `stdin` chứ không nằm trên dòng lệnh, nên `ps` không nhìn thấy.

---

## 🌐 Đa ngôn ngữ

Mặc định nói **tiếng Việt**, và nói được cả **tiếng Anh**:

```bash
/profile lang           # đang dùng ngôn ngữ nào
/profile lang en        # switch to English
/profile lang vi        # về lại tiếng Việt
```

Hoặc ép bằng biến môi trường:
```bash
export CLAUDE_SWAP_LANG=en
```

(Một số thông báo hiếm gặp vẫn chỉ có tiếng Việt. Coi như học thêm ngoại ngữ.)

---

## 🛠️ Phát triển & kiểm thử

```bash
npm test                   # 50 unit test cho swap.js & web.js (node --test)
claude plugin validate .   # kiểm tra manifest và hooks
claude plugin test .       # 11 test cho plugin hook
```

Test dùng thư mục tạm và token giả, nên chạy bao nhiêu lần cũng không đụng tới tài khoản thật của bạn.

### Cấu trúc dự án:

```text
claude-swap/
├── swap.js               # Toàn bộ logic: profile, credentials, sync, usage, CLI
├── web.js                # Web Dashboard, REST API và trang hướng dẫn
├── package.json          # Metadata và script test
├── hooks/
│   ├── hooks.json        # Đăng ký hook với Claude Code
│   ├── register.ts       # session.start, prompt.submit và lệnh /profile
│   └── register.test.ts  # Test cho plugin hook (11 test)
├── test/
│   └── swap.test.js      # Unit test cho swap.js & web.js (50 test)
├── LICENSE               # MIT
└── .claude-plugin/       # Manifest plugin & marketplace
```

---

## 📄 License

[MIT](LICENSE). Cứ lấy mà dùng, chỉ xin đừng dùng nó để lách điều khoản sử dụng của Anthropic.
