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
[Có gì mới](#-có-gì-mới-ở-dòng-04) ·
[Xử lý sự cố](#-xử-lý-sự-cố) ·
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
| ✏️ **Đổi tên & hoàn tác** | `/profile rename cũ mới` đổi tên mà alias, liên kết, lịch sử đi theo. `/profile undo` quay về profile trước khi lỡ tay đổi nhầm. |
| 🔌 **Giữ nguyên MCP** | Đăng nhập của các MCP server thuộc về máy, không thuộc tài khoản: đổi profile xong không phải đăng nhập lại Linear, Notion, Vercel... |
| 📟 **Status line chi tiết** | Trên khung nhập luôn có một dải màu với profile, thanh 5h/7d, giờ reset và cảnh báo sắp cạn (`/profile statusline` để tắt/bật). |
| 🎨 **Output có màu** | Lỗi đỏ, thành công xanh, bảng `list` thẳng cột kèm giờ reset 5h và 7d. Đọc một cái là biết. |
| 🔤 **Alias** | Lười gõ `work-company-production-2`? Đặt `w` rồi `/profile w`. |
| 🎛️ **Picker tương tác** | `/profile pick` cho chọn bằng phím `↑` `↓`, dành cho người không nhớ nổi tên profile của mình. |
| ⚖️ **Cân bằng tải** | Chia đều công việc cho các tài khoản theo `least-used` (ai còn nhiều quota thì làm) hoặc `round-robin` (lần lượt từng người). Không tài khoản nào phải gánh team. |
| 🔔 **Webhook** | Báo qua Telegram, Discord, Slack hoặc webhook bất kỳ khi chạm ngưỡng hay đổi tài khoản. Điện thoại rung là biết quota sắp hết. |
| 💰 **Ngân sách** | Đặt trần chi tiêu hàng tháng cho từng profile (`/profile budget`). Ví tiền sẽ cảm ơn bạn. |
| 🛡️ **Che email & chia sẻ an toàn** | Email hiện thành `us***@domain.com` khi bạn share màn hình, và xuất cấu hình không kèm token (`/profile mask`, `/profile share`). |
| ⌨️ **Tab completion** | Sinh script gợi ý lệnh cho Bash, Zsh, Fish (`/profile completion`). Gõ nửa chữ rồi bấm Tab. |
| 🚀 **Session song song** | `/profile run <tên>` chạy thêm một Claude Code tách biệt với tài khoản khác. Hai Claude, hai tài khoản, không ai giẫm chân ai. Vẫn dùng chung skill, agent, plugin, settings và memory của bạn. |
| 🔑 **Setup-token & API key** | Tạo profile thẳng từ token, không cần trình duyệt (`/profile add-token`), đọc được cả từ `stdin` để token không nằm trong lịch sử shell. |
| 🚫 **Cho nghỉ phép** | `/profile disable <tên>` tạm loại một profile khỏi auto-switch mà không cần xóa. |
| 🌿 **Theo nhánh Git** | Nhánh `work-*` dùng tài khoản công ty, `feat/*` dùng tài khoản dev, tự động. Chẳng còn cảnh lỡ tay dùng tài khoản công ty cho side project. |
| 📁 **Theo thư mục** | Mở dự án nào thì tự bật đúng profile của dự án đó (file `.claude-profile`). |
| 📈 **Dự báo** | Đo tốc độ tiêu thụ %/giờ và đoán khi nào cạn (`/profile forecast`). Cái gì cũng tính được, trừ deadline. |
| ⏱️ **Cooldown & tự quay về** | Đếm ngược tới lúc quota 5 giờ reset, rồi tự đưa bạn về profile chính khi tài khoản đó hồi sức. |
| 🤖 **Tự đổi tài khoản** | Chạm ngưỡng % hoặc dính rate limit thì tự nhảy sang tài khoản còn nhiều quota nhất hoặc reset sớm nhất. Bạn chỉ việc code tiếp. |
| 🚨 **Bảo vệ hạn mức 7 ngày** | Không nhảy vào tài khoản đã dùng gần hết quota tuần (mặc định 85%). |
| 🧠 **Model affinity** | Opus chạy tài khoản này, Sonnet chạy tài khoản kia (`/profile affinity`). |
| 🩺 **Doctor & Cleanup** | Khám token hết hạn, đăng nhập MCP hết hạn, profile trùng tài khoản, file hỏng (`/profile doctor`, `/profile cleanup`). Thầy thuốc cho credentials. |
| ☁️ **Sync mã hóa** | Đẩy và kéo bản sao lưu mã hóa AES-256 giữa các máy (`/profile sync push` / `pull`). |
| 💻 **Shell prompt & Tmux** | Hiện profile đang dùng kèm % usage trên Starship, Zsh, Bash, Tmux, chạy dưới 5ms. |
| ⏳ **Mượn tạm** | Mượn một profile trong `30m` hay `1h` rồi tự trả. Như mượn sạc của đồng nghiệp, nhưng lần này có người nhắc trả. |
| 📊 **JSON** | `--json` cho `list`, `current`, `disabled`, để script và CI đọc được. |
| 🌐 **Song ngữ** | Tiếng Việt hoặc tiếng Anh, `/profile lang [vi\|en]`. |
| ⚡ **Không tốn token** | Mọi lệnh `/profile` chạy local qua plugin hook, **không gửi gì cho model và không tốn lượt nào**. Chạy ngay cả khi Claude đang bận trả lời, khỏi chờ. |

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

Đã cài rồi và muốn bản mới nhất: `/profile upgrade`. Plugin tự nạp lại (`/reload-plugins`), không cần thoát session.

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
| `/profile` | Hiện bảng hướng dẫn đầy đủ. Lạc đường thì gõ cái này |
| `/profile list [--json]` | Điểm danh cả đội: bảng thẳng cột gồm 🟢/⚪, email, thanh quota 5h/7d, giờ reset và nhãn 🏷️ |
| `/profile current [--json]` | Câu hỏi triết học "mình là ai?", trả lời bằng tên profile đang dùng |
| `/profile <tên\|alias>` | Đổi sang profile hoặc alias `<tên>`. Claude còn không biết mình vừa đổi chủ |
| `/profile pick` | Chọn bằng phím `↑` `↓`, cho ai không nhớ nổi tên profile của chính mình |
| `/profile alias <tên> <p>` | Đặt biệt danh (vd: `/profile alias w work`). Gõ một chữ thay vì cả câu |
| `/profile unalias <tên>` | Xóa biệt danh. Profile gốc vẫn bình an vô sự |
| `/profile aliases` | Danh bạ biệt danh |
| `/profile new <tên> [--force]` | Chụp ảnh tài khoản đang đăng nhập rồi cất thành profile mới |
| `/profile save <tên> [--force]`| Ghi tài khoản đang đăng nhập vào profile, rất hợp sau khi vừa `/login` lại |
| `/profile rename <cũ> <mới>` | Đổi tên profile. Alias, liên kết dự án/nhánh, lịch sử, ngân sách đều đi theo, không bỏ rơi ai |
| `/profile delete <tên>` | Chia tay dứt khoát: xóa profile và dọn đồ đạc liên quan. Không có thùng rác |
| `/profile folder` | Mở thư mục chứa profile. Ngó thì được, đừng sửa tay |
| `/profile lang [vi\|en]` | Xem hoặc đổi ngôn ngữ. Song ngữ, khỏi cần phiên dịch |
| `/profile version` | Đang chạy bản nào |

### 🚀 Web, cân bằng tải & tiện ích

| Lệnh | Mô tả |
| --- | --- |
| `/profile web [--port <p>]` | Mở Web Dashboard, cho những ngày lười gõ lệnh |
| `/profile web stop` | Cho dashboard đi ngủ |
| `/profile balance [on\|off]` | Bật / tắt cân bằng tải. Khi bật, auto-switch chọn profile kế tiếp theo `mode` (thay cho `auto order`) |
| `/profile balance mode <least-used\|round-robin>` | Chọn kiểu chia việc: ai còn nhiều quota nhất làm trước, hay lần lượt từng người |
| `/profile balance pool <tag\|all>` | Chỉ chia việc trong nhóm có tag |
| `/profile balance next` | Chuyền bóng ngay cho profile kế tiếp theo thuật toán |
| `/profile webhook [status]` | Kênh báo nào đang bật |
| `/profile webhook set <telegram\|discord\|slack\|generic> <url>` | Nối dây báo tin về Telegram, Discord, Slack hoặc một URL bất kỳ |
| `/profile webhook unset <type>` | Tắt tiếng một kênh báo |
| `/profile webhook test` | Bắn một tin thử cho chắc đường dây thông suốt |
| `/profile budget [status]` | Xem trần chi tiêu hàng tháng |
| `/profile budget set <tên> <số_tiền>` | Đặt trần chi tiêu cho profile. Ví tiền sẽ cảm ơn bạn |
| `/profile budget unset <tên>` | Gỡ trần chi tiêu. Sống thoáng nhưng tự chịu trách nhiệm |
| `/profile mask [on\|off]` | Che email khi share màn hình (`us***@domain.com`) |
| `/profile share [file.json]` | Xuất cấu hình cho đồng đội, không kèm chìa khóa nhà (token) |
| `/profile completion [bash\|zsh\|fish]` | Gõ nửa chữ, bấm Tab, phần còn lại để shell lo |

### ⚡ Session song song & token

| Lệnh | Mô tả |
| --- | --- |
| `/profile run <tên> [-- cmd]` | Mở thêm một Claude Code chạy tài khoản khác, song song mà không giẫm chân nhau. Dùng chung skill, agent, plugin, settings, memory |
| `/profile add-token <tok> [tên]` | Tạo profile thẳng từ setup-token hoặc API key, không cần trình duyệt |
| `echo $TOK \| node swap.js add-token - [tên]` | Đưa token qua `stdin` để nó không nằm lại trong lịch sử shell |
| `/profile upgrade` | Kéo bản mới nhất về và tự nạp lại, khỏi khởi động lại Claude Code |
| `/profile disable <tên>` | Cho profile nghỉ phép: auto-switch sẽ không gọi nó dậy |
| `/profile enable <tên>` | Hết phép, quay lại vòng xoay auto-switch |
| `/profile disabled [--json]` | Ai đang nghỉ phép |

### 🤖 Tự đổi tài khoản & quota

| Lệnh | Mô tả |
| --- | --- |
| `/profile usage` | Quota 5h, 7d và từng model (Opus, Sonnet, Haiku…), soi tới từng phần trăm |
| `/profile auto` | Auto-switch đang cấu hình ra sao |
| `/profile auto on` / `off` | Bật / tắt tự đổi tài khoản khi vượt ngưỡng. Bật lên rồi cứ code tiếp |
| `/profile auto threshold <%>` | Bao nhiêu % thì đổi (mặc định `95%`) |
| `/profile auto order <ds>` | Xếp hàng xem ai lên thay trước (vd: `work,personal,backup`) |
| `/profile auto pool <tag\|all>`| Chỉ đổi qua lại trong nhóm có tag |
| `/profile auto safeguard [on\|off\|<%>]` | Không nhảy vào tài khoản đã gần cạn quota tuần (mặc định `85%`) |
| `/profile auto return [on\|off]` | Tự quay về profile chính khi nó hồi sức |
| `/profile auto primary <tên>` | Chọn "nhà" để auto-return quay về |
| `/profile auto check` | Khỏi chờ prompt kế tiếp: kiểm tra ngay, chạm ngưỡng là đổi. Mỗi prompt chỉ hỏi quota của profile đang dùng, chỉ hỏi cả đội khi cần chọn người thay |
| `/profile forecast` | Bói xem bao giờ cạn quota, dựa trên tốc độ tiêu thụ thật. Tính từ lúc đo gần nhất; số liệu cũ quá 20 phút sẽ được đánh dấu "chỉ tham khảo" |
| `/profile cooldown` | Đếm ngược tới lúc quota 5h hồi sức |
| `/profile doctor` | Khám tổng quát: token OAuth, đăng nhập MCP, file cấu hình, kết nối |
| `/profile cleanup [--force]` | Tìm profile trùng email/UUID hoặc token hỏng. Thêm `--force` là dọn thật |

### 📁 Dự án, nhánh Git, tag & model

| Lệnh | Mô tả |
| --- | --- |
| `/profile bind [tên]` | Gắn profile cho thư mục (file `.claude-profile`). Mở dự án là tự đúng tài khoản |
| `/profile unbind` | Gỡ gắn: thư mục này được tự do |
| `/profile bind-branch <pat> [tên]` | Gắn profile theo mẫu nhánh Git (vd: `feat/*`, `hotfix-*`). Checkout là đổi luôn |
| `/profile unbind-branch [pat]`| Cởi trói cho nhánh |
| `/profile branch-bindings` | Nhánh nào đi với tài khoản nào |
| `/profile tag <tên> <tag>` | Dán nhãn phân nhóm (vd: `/profile tag work corp`) |
| `/profile untag <tên> <tag>` | Bóc nhãn ra. Profile không giận đâu |
| `/profile tags` | Ai thuộc nhóm nào |
| `/profile affinity <model> <tên>` | Cho model một tài khoản riêng (vd: `opus` ăn quota như tằm ăn dâu) |
| `/profile affinity apply <model>` | Nhảy sang tài khoản đã gán cho model đó |
| `/profile unaffinity <model>` | Model này về làm việc chung với mọi người |
| `/profile affinities` | Model nào đi với tài khoản nào |

### ⏳ Mượn tạm, lịch sử & sao lưu

| Lệnh | Mô tả |
| --- | --- |
| `/profile temp <tên> [tg]` | Mượn tạm profile có hẹn giờ trả (vd: `30m`, `1h`). Hết giờ tự trả |
| `/profile untemp` | Trả sớm cho giữ uy tín, về profile gốc ngay |
| `/profile statusline [on\|off\|band\|line]` | Status line chi tiết: profile, thanh 5h/7d, giờ reset, cảnh báo sắp cạn. Không kèm tham số thì bật/tắt. `band` (mặc định) là dải màu trên khung nhập, `line` là dòng chữ thường ghim dưới. `statusline ansi` in dòng có màu để nhúng vào status line riêng |
| `/profile prompt [shell]` | Snippet để `starship`, `zsh`, `bash`, `tmux`, `powershell` biết bạn đang là ai |
| `/profile notify [on\|off]` | Bật / tắt thông báo desktop khi đổi profile (mặc định tắt cho đỡ phiền) |
| `/profile undo` | Lỡ tay đổi nhầm? Quay về profile trước đó trong một nốt nhạc (gọi lần nữa thì đi lại) |
| `/profile history [n]` | Nhật ký đổi tài khoản: ai, khi nào, vì sao (mặc định 10 dòng) |
| `/profile stats` | Đổi tay bao nhiêu lần, tự động bao nhiêu lần, theo dự án bao nhiêu lần |
| `/profile sync setup <path>` | Chọn chỗ đặt két đồng bộ (thư mục Dropbox, ổ mạng…) |
| `/profile sync push` | Gửi két mã hóa lên chỗ đồng bộ |
| `/profile sync pull` | Mang két về máy này rồi mở ra |
| `/profile export <file>` | Nhét hết profile vào két AES-256-GCM. Quên mật khẩu là chịu |
| `/profile import-enc <file>` | Mở két, mang profile về. Đúng mật khẩu mới mở được |
| `/profile import <thư_mục> [--force]` | Dọn nhà cho profile thô từ thư mục khác về đây |

> 🔑 **Mật khẩu sao lưu không bao giờ được ghi xuống đĩa.** Đưa nó vào bằng `--password-stdin` (an toàn nhất: `echo "$PW" | node swap.js export f.enc --password-stdin`), biến môi trường `CLAUDE_SWAP_PASSWORD`, hoặc `--password <pw>` (cách này để lại mật khẩu trong lịch sử shell, nên chỉ dùng khi bạn tin cái lịch sử đó).

---

## 🖥️ Trông nó thế nào

### `/profile list`:

```text
   PROFILE   EMAIL                5H                 7D                 RESET 5H  RESET 7D
───────────────────────────────────────────────────────────────────────────────────────────
🟢 work      work@company.com     [███░░░░░]  32%    [█████░░░]  64%    2h10m     3d4h
⚪ personal  user@gmail.com       [███████░]  85%🔥  [███░░░░░]  40%    48m       1d9h  🏷️ side
⚪ dev       dev@example.com      —                  —                  —         —     (disabled)
```

Cột reset cho biết còn bao lâu nữa thì cửa sổ quota đó hồi sức, để biết nên chờ hay nên đổi.

*Màu thanh usage, như đèn giao thông:*
- 🟢 xanh lá `< 50%`: thoải mái
- 🟡 vàng `< 80%`: bắt đầu để ý
- 🟠 cam `< 95%`: liệu mà tiết kiệm, từ `80%` có thêm 🔥
- 🔴 đỏ `≥ 95%`: auto-switch đang xỏ giày

### Status line chi tiết (`/profile statusline`):

Bật mặc định, cập nhật mỗi khi bạn gửi prompt, thanh và phần trăm đổi màu theo mức tải (cùng bảng màu với `/profile list`). Có hai kiểu hiển thị:

- `/profile statusline band` (mặc định): một dải nhiều màu vẽ ngay trên khung nhập.
- `/profile statusline line`: một dòng chữ thường ghim dưới khung nhập, không có màu. Claude Code bỏ ký tự điều khiển màu của dòng ghim nên chỗ đó không thể tô màu.

`/profile statusline` không kèm tham số thì bật/tắt, `on`/`off` cũng được.

```text
● work │ 5h [███░░░░░] 32% ⏳2h10m │ 7d [█████░░░] 64% ⏳3d4h │ ⚠ 5h ~12p
```

Muốn nhúng vào status line riêng của bạn (cấu hình `statusLine` trong `settings.json`): `node <plugin>/swap.js statusline ansi` in đúng dòng có màu đó.

`⏳` là thời gian còn lại tới lúc reset. `⚠ 5h ~12p` chỉ hiện khi tốc độ tiêu thụ cho thấy profile này sẽ chạm ngưỡng auto-switch trong khoảng 30 phút. Gõ `/profile statusline` để tắt/bật.

### Màu sắc trong output

Các lệnh dành cho người đọc (`swap`, `undo`, `history`, `stats`, `forecast`, `tag`, `alias`...) được tô màu theo ý nghĩa: lỗi đỏ, thành công xanh, tên profile vàng, tiêu đề cyan. Lệnh mà hook hay shell phải đọc (`current`, `statusline`, `auto check`, `--json`) luôn là chữ thường. Muốn tắt màu: `--no-color` hoặc biến môi trường `NO_COLOR=1`.

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

Mỗi session sống ở `~/.config/claude-cli-profiles/.sessions/<tên>` và dùng `CLAUDE_CONFIG_DIR` riêng. Skill, agent, plugin, settings, `CLAUDE.md` và memory được nối (symlink) từ `~/.claude` sang, nên session phụ vẫn "đủ đồ nghề"; chỉ có đăng nhập là riêng theo profile. Khi session kết thúc, token đã được refresh sẽ được đồng bộ ngược về profile. Nếu bên trong session có ai đó đăng nhập sang tài khoản khác, plugin sẽ không chép nhầm tài khoản đó vào profile.

---

## 🧠 Bên trong có gì

Mỗi profile là một file `~/.config/claude-cli-profiles/<tên>.json` (quyền `0600`, thư mục `0700`, người ngoài không đọc được), gồm:

- Các khóa đăng nhập trong `~/.claude.json`: `oauthAccount`, `primaryApiKey`, `customApiKeyResponses`.
- Token OAuth trong `~/.claude/.credentials.json`, hoặc Keychain trên macOS.

Skill, agent, plugin, settings và memory nằm trong `~/.claude/` nên **không thuộc về profile nào**: đổi tài khoản không làm mất cái gì trong số đó.

**Khi bạn đổi profile:**
- Plugin chỉ thay đúng mấy khóa đăng nhập. **Cấu hình dự án, cài đặt và lịch sử trong `~/.claude.json` giữ nguyên.** Như thay chìa khóa xe, không ai tháo luôn cả cái xe.
- Trước khi đổi, plugin lưu lại token mới nhất của profile hiện tại, phòng khi Claude Code vừa âm thầm refresh nó.
- Mọi file được ghi qua file tạm rồi mới đổi tên (atomic write), kèm bản `.bak`. Mất điện giữa chừng cũng không mất profile.
- File credentials còn chứa `mcpOAuth`, tức đăng nhập của các MCP server. Phần này thuộc về máy chứ không thuộc tài khoản, nên khi đổi profile plugin giữ nguyên bản đang dùng thay vì trả về bản chụp cũ của profile. Nhờ vậy MCP không bị đăng nhập lại.
- Nếu bạn đặt `CLAUDE_CONFIG_DIR`, plugin làm việc với thư mục đó thay cho `~/.claude`.
- Trên macOS, token được đưa vào Keychain qua `stdin` chứ không nằm trên dòng lệnh, nên `ps` không nhìn thấy.

**Giữ bí mật cho đồ bí mật:**
- Token, credentials và mật khẩu sao lưu không bao giờ nằm trên dòng lệnh của tiến trình con, không bị in ra màn hình, và không bị gửi lên dashboard.
- URL webhook (thứ chứa bot token Telegram hay secret của Discord/Slack) được lưu đầy đủ, nhưng dashboard chỉ hiện phần domain. Muốn đổi thì gõ URL mới, để trống là giữ nguyên.
- File profile bị hỏng sẽ báo "JSON không hợp lệ" chứ không trích nội dung file vào thông báo lỗi, nên không có mẩu token nào lọt ra terminal.
- Bản `.bak` được tạo với quyền `0600` ngay từ đầu, không có khoảnh khắc nào để người khác đọc trộm.

---

## 🆕 Có gì mới ở dòng 0.4

| Bản | Điểm chính |
| --- | --- |
| **0.4.7** | Sửa dự báo cạn quota: tính từ lúc đo gần nhất và im lặng khi số liệu đã cũ, thay vì báo `⚠ 5h ~12p` dựa trên số đo từ lâu |
| **0.4.6** | Status line mặc định là dải màu trên khung nhập (`band`); dòng ghim `line` chỉ còn chữ thường vì host bỏ mã màu ở đó |
| **0.4.5** | Thêm hai kiểu hiển thị status line và `statusline ansi` cho status line riêng của bạn |
| **0.4.4** | Sửa bản 0.4.3 phát hành thiếu nội dung; status line có màu đồng bộ với `/profile list`; sửa lỗi `temp` kéo về profile cũ sau khi bạn đã tự đổi |
| **0.4.2** | Bỏ mã màu 256 sắc làm host in ra chữ lạ trước email |
| **0.4.1** | Thêm `/profile rename`; sửa cột reset hiện số khổng lồ khi thiếu dữ liệu |
| **0.4.0** | Giữ nguyên đăng nhập MCP khi đổi profile; `run` dùng chung skill/agent/plugin/settings/memory; `/profile upgrade` tự nạp lại; `/profile` chạy ngay cả khi Claude đang bận; `undo`, `statusline`, bảng `list` thẳng cột có cột reset, output có màu, `auto check` chỉ hỏi quota profile đang dùng |

---

## 🩹 Xử lý sự cố

| Triệu chứng | Nguyên nhân và cách xử lý |
| --- | --- |
| Chạy `/profile upgrade` xong vẫn thấy giao diện cũ | Claude Code chỉ nạp lại bản đã cài. Từ v0.4.1 plugin tự gọi `/reload-plugins` sau khi cập nhật. Nếu bản bạn đang chạy cũ hơn, tự gõ `/reload-plugins` một lần (hoặc khởi động lại), các lần sau sẽ tự động. |
| `/profile foo bar` báo "Dùng: ..." | Lệnh `foo` chưa có trong bản đang chạy. Kiểm tra `/profile version`, rồi `/profile upgrade`. |
| Trước email có chữ lạ kiểu `[38;5;248m` | Khung chat của Claude Code không hiểu một số mã màu. Từ v0.4.2 plugin chỉ dùng các mã đã kiểm chứng. Lên bản mới là hết. |
| Đổi profile xong MCP đòi đăng nhập lại | Từ v0.4.0 đăng nhập MCP được giữ nguyên khi đổi profile. Riêng các connector `claude.ai ...` gắn với tài khoản nên đổi tài khoản là đổi theo, không giữ được. Chạy `/profile doctor` để xem MCP nào hết hạn mà không có refresh token. |
| Bảng `list` hiện `—` ở cột quota | Chưa có số liệu cho profile đó (chưa lấy được quota, token hết hạn, hoặc là API key). `/profile list --refresh` để hỏi lại. |
| Status line hiện chữ lạ `[1;32m` hoặc chỉ một màu | Bạn đang ở kiểu `line` (dòng ghim). Chạy `/profile statusline band` để có dải nhiều màu trên khung nhập. Nếu không hiện gì: có thể bạn đã tắt: gõ `/profile statusline` để bật lại. Nó cập nhật khi bạn gửi prompt. |
| Muốn thấy dashboard bản mới | `/profile web stop` rồi `/profile web`, và mở đúng link có `#token`. |

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
npm test                   # 69 unit test cho swap.js & web.js (node --test)
claude plugin validate .   # kiểm tra manifest và hooks
claude plugin test .       # 17 test cho plugin hook
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
│   ├── register.tsx      # session.start, prompt.submit và lệnh /profile
│   └── register.test.ts  # Test cho plugin hook (17 test)
├── test/
│   └── swap.test.js      # Unit test cho swap.js & web.js (69 test)
├── LICENSE               # MIT
└── .claude-plugin/       # Manifest plugin & marketplace
```

---

## 📄 License

[MIT](LICENSE). Cứ lấy mà dùng, chỉ xin đừng dùng nó để lách điều khoản sử dụng của Anthropic.
