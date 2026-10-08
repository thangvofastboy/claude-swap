import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import child_process from 'node:child_process'
import {
  listProfiles,
  currentProfile,
  swapProfile,
  profileEmail,
  getProfileTags,
  loadDisabledProfiles,
  disableProfile,
  enableProfile,
  deleteProfile,
  saveProfile,
  addTokenProfile,
  tempSwap,
  loadAliases,
  setAlias,
  removeAlias,
  loadBranchBindings,
  bindBranch,
  unbindBranch,
  listModelAffinities,
  setModelAffinity,
  removeModelAffinity,
  loadLanguage,
  setLanguage,
  loadAutoSwitchConfig,
  saveAutoSwitchConfig,
  loadUsageCache,
  profilesDir,
  atomicWrite,
  SwapError,
  loadBalanceConfig,
  saveBalanceConfig,
  loadWebhookConfig,
  saveWebhookConfig,
  testWebhook,
  loadBudgetConfig,
  saveBudgetConfig,
  setBudgetLimit,
  removeBudgetLimit,
  isMaskingEnabled,
  setMasking,
  maskEmail,
  exportSafeShare,
} from './swap.js'

export function webPidFile(home = os.homedir()) {
  return path.join(profilesDir(home), '.web.pid')
}

export function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      child_process.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'win32') {
      child_process.spawn('start', [url], { detached: true, shell: true, stdio: 'ignore' }).unref()
    } else {
      child_process.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {}
}

export function stopWebDashboard(home = os.homedir()) {
  const pf = webPidFile(home)
  if (!fs.existsSync(pf)) return false
  try {
    const pid = parseInt(fs.readFileSync(pf, 'utf-8').trim(), 10)
    if (pid && !isNaN(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
    fs.unlinkSync(pf)
    return true
  } catch {
    return false
  }
}

export function getDashboardData(home = os.homedir()) {
  const cur = currentProfile(home)
  const profiles = listProfiles(home)
  const disabled = loadDisabledProfiles(home)
  const cache = loadUsageCache(home)
  const masking = isMaskingEnabled(home)
  const aliases = loadAliases(home)
  const now = Date.now() / 1000

  const profileCards = profiles.map(name => {
    const rawEmail = profileEmail(home, name)
    const email = masking ? maskEmail(rawEmail, true) : rawEmail
    const tags = getProfileTags(home, name)
    const key = `${name}|${rawEmail}`
    const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}
    const limits = Array.isArray(hit.limits) ? hit.limits : []

    let quota5h = null
    let quota7d = null
    for (const [lbl, val] of limits) {
      if (lbl.includes('5') || lbl.toLowerCase().includes('five')) quota5h = Number(val)
      if (lbl.includes('7') || lbl.toLowerCase().includes('seven')) quota7d = Number(val)
    }

    let cooldownSec = 0
    if (hit.resets_at && hit.resets_at > now) {
      cooldownSec = Math.round(hit.resets_at - now)
    } else if (hit.retry_at && hit.retry_at > now) {
      cooldownSec = Math.round(hit.retry_at - now)
    }

    const aliasList = Object.entries(aliases)
      .filter(([_, target]) => target === name)
      .map(([a]) => a)

    return {
      name,
      active: name === cur,
      email: email || null,
      tags,
      aliases: aliasList,
      disabled: disabled.includes(name),
      quota5h,
      quota7d,
      cooldownSec,
      rateLimited: Boolean(hit.retry_at && hit.retry_at > now),
    }
  })

  return {
    current: cur,
    profiles: profileCards,
    auto: loadAutoSwitchConfig(home),
    balance: loadBalanceConfig(home),
    webhook: loadWebhookConfig(home),
    budget: loadBudgetConfig(home),
    masking,
    language: loadLanguage(home),
    branchBindings: loadBranchBindings(home),
    affinities: listModelAffinities(home),
    aliases,
  }
}

export function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>claude-swap Dashboard — Quản lý Đa Tài Khoản Claude Code</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f293d;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --border: #374151;
      --code-bg: #1e293b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
    header { background: #0f172a; border-bottom: 1px solid var(--card-border); padding: 14px 28px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 1.25rem; color: #fff; }
    .brand-badge { background: #1e293b; color: #60a5fa; font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; border: 1px solid #3b82f644; }
    nav { display: flex; gap: 8px; }
    .tab-btn { background: transparent; border: none; color: var(--text-muted); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.95rem; font-weight: 500; transition: all 0.2s; display: flex; align-items: center; gap: 6px; }
    .tab-btn:hover { color: #fff; background: #1e293b; }
    .tab-btn.active { color: #fff; background: var(--accent); }
    .header-actions { display: flex; gap: 10px; align-items: center; }
    .btn { background: var(--accent); color: #fff; border: none; padding: 8px 14px; border-radius: 6px; font-size: 0.88rem; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: background 0.2s; }
    .btn:hover { background: var(--accent-hover); }
    .btn-secondary { background: #1e293b; color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: #334155; }
    .btn-sm { padding: 4px 10px; font-size: 0.8rem; }
    .btn-danger { background: #991b1b; }
    .btn-danger:hover { background: var(--danger); }
    .btn-success { background: #065f46; }
    .btn-success:hover { background: var(--success); }

    main { flex: 1; max-width: 1280px; width: 100%; margin: 0 auto; padding: 24px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.25s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* Overview stats */
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
    .stat-label { font-size: 0.82rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 1.4rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }
    .pulse-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--success); box-shadow: 0 0 10px var(--success); animation: pulse 2s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }

    /* Profile cards grid */
    .profiles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 18px; margin-bottom: 32px; }
    .profile-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 14px; position: relative; transition: border-color 0.2s, box-shadow 0.2s; }
    .profile-card:hover { border-color: #3b82f688; }
    .profile-card.is-active { border-color: var(--accent); background: linear-gradient(180deg, #1e293b88 0%, #111827 100%); box-shadow: 0 0 20px #3b82f622; }
    .profile-header { display: flex; justify-content: space-between; align-items: flex-start; }
    .profile-title { display: flex; align-items: center; gap: 10px; }
    .profile-name { font-size: 1.15rem; font-weight: 700; color: #fff; }
    .active-badge { background: #065f46; color: #34d399; font-size: 0.72rem; padding: 2px 8px; border-radius: 999px; font-weight: 600; display: flex; align-items: center; gap: 4px; }
    .profile-email { font-size: 0.84rem; color: var(--text-muted); display: flex; align-items: center; gap: 5px; }
    .tag-pill { background: #1f2937; color: #c084fc; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; border: 1px solid #7e22ce33; }

    /* Progress bars */
    .quota-box { background: #0f172a; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .quota-item { display: flex; flex-direction: column; gap: 4px; }
    .quota-meta { display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted); }
    .quota-val { font-weight: 600; color: #fff; }
    .progress-bar-bg { background: #1e293b; height: 8px; border-radius: 4px; overflow: hidden; width: 100%; }
    .progress-bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
    .fill-green { background: var(--success); }
    .fill-yellow { background: var(--warning); }
    .fill-orange { background: #f97316; }
    .fill-red { background: var(--danger); }

    .cooldown-text { font-size: 0.8rem; color: #60a5fa; display: flex; align-items: center; gap: 4px; }
    .profile-actions { display: flex; gap: 8px; align-items: center; margin-top: auto; padding-top: 10px; border-top: 1px solid #1f2937; }

    /* Settings section */
    .settings-container { display: flex; flex-direction: column; gap: 24px; }
    .settings-section { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 22px; }
    .section-title { font-size: 1.15rem; font-weight: 700; color: #fff; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
    .section-desc { font-size: 0.86rem; color: var(--text-muted); margin-bottom: 18px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-label { font-size: 0.88rem; font-weight: 600; color: #e5e7eb; display: flex; align-items: center; gap: 6px; }
    .form-hint { font-size: 0.78rem; color: #94a3b8; }
    .form-control { background: #0f172a; border: 1px solid var(--border); color: #fff; padding: 10px 12px; border-radius: 6px; font-size: 0.9rem; transition: border-color 0.2s; }
    .form-control:focus { outline: none; border-color: var(--accent); }
    .form-switch { display: flex; align-items: center; gap: 12px; cursor: pointer; }
    .form-switch input { display: none; }
    .switch-slider { width: 44px; height: 24px; background: #374151; border-radius: 12px; position: relative; transition: background 0.2s; }
    .switch-slider::after { content: ''; position: absolute; width: 18px; height: 18px; border-radius: 50%; background: #fff; top: 3px; left: 3px; transition: transform 0.2s; }
    input:checked + .switch-slider { background: var(--accent); }
    input:checked + .switch-slider::after { transform: translateX(20px); }

    /* Docs section */
    .docs-search { margin-bottom: 20px; }
    .docs-search input { width: 100%; max-width: 600px; padding: 12px 16px; border-radius: 8px; background: #111827; border: 1px solid var(--border); color: #fff; font-size: 0.95rem; }
    .docs-grid { display: grid; grid-template-columns: 240px 1fr; gap: 24px; }
    .docs-nav { position: sticky; top: 80px; height: fit-content; display: flex; flex-direction: column; gap: 4px; }
    .docs-nav-link { color: var(--text-muted); padding: 8px 12px; border-radius: 6px; text-decoration: none; font-size: 0.9rem; transition: all 0.2s; }
    .docs-nav-link:hover, .docs-nav-link.active { color: #fff; background: #1e293b; }
    .docs-body { display: flex; flex-direction: column; gap: 32px; }
    .docs-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 24px; }
    .docs-card h2 { color: #60a5fa; margin-bottom: 12px; font-size: 1.3rem; display: flex; align-items: center; gap: 8px; }
    .docs-card p { font-size: 0.92rem; line-height: 1.6; color: #d1d5db; margin-bottom: 14px; }
    .cmd-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.88rem; }
    .cmd-table th, .cmd-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #1f2937; }
    .cmd-table th { background: #0f172a; color: var(--text-muted); font-weight: 600; }
    .cmd-code { background: #1e293b; color: #38bdf8; padding: 3px 6px; border-radius: 4px; font-family: monospace; font-size: 0.85rem; }

    /* Modal */
    .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; justify-content: center; align-items: center; z-index: 200; }
    .modal-backdrop.show { display: flex; }
    .modal-box { background: #111827; border: 1px solid var(--border); border-radius: 12px; width: 90%; max-width: 480px; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; }
    .modal-title { font-size: 1.15rem; font-weight: 700; color: #fff; }
    .modal-close { background: none; border: none; color: var(--text-muted); font-size: 1.4rem; cursor: pointer; }

    /* Toast */
    #toast { position: fixed; bottom: 24px; right: 24px; background: #1e293b; color: #fff; border: 1px solid var(--accent); padding: 12px 20px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); display: none; z-index: 999; animation: slideUp 0.2s ease; }
    @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

    footer { background: #0f172a; border-top: 1px solid var(--card-border); padding: 16px; text-align: center; font-size: 0.82rem; color: var(--text-muted); }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <span>🔀 claude-swap</span>
      <span class="brand-badge">Web UI</span>
    </div>
    <nav>
      <button class="tab-btn active" onclick="switchTab('dashboard')">📊 Profiles</button>
      <button class="tab-btn" onclick="switchTab('settings')">⚙️ Cấu Hình Plugin</button>
      <button class="tab-btn" onclick="switchTab('docs')">📖 Hướng Dẫn & Chú Thích</button>
    </nav>
    <div class="header-actions">
      <button class="btn btn-secondary btn-sm" onclick="toggleLanguage()" id="langBtn">🌐 Tiếng Việt</button>
      <button class="btn btn-sm" onclick="showAddModal()">➕ Thêm Profile</button>
    </div>
  </header>

  <main>
    <!-- TAB 1: DASHBOARD -->
    <section id="tab-dashboard" class="tab-content active">
      <div class="stats-row">
        <div class="stat-card">
          <span class="stat-label">Profile Đang Kích Hoạt</span>
          <div class="stat-value">
            <span class="pulse-dot"></span>
            <span id="stat-current">-</span>
          </div>
        </div>
        <div class="stat-card">
          <span class="stat-label">Tổng Số Tài Khoản</span>
          <div class="stat-value" id="stat-total">0</div>
        </div>
        <div class="stat-card">
          <span class="stat-label">Tự Động Switch</span>
          <div class="stat-value" id="stat-auto">Tắt</div>
        </div>
        <div class="stat-card">
          <span class="stat-label">Cân Bằng Tải</span>
          <div class="stat-value" id="stat-balance">Tắt</div>
        </div>
      </div>

      <div class="profiles-grid" id="profiles-container">
        <!-- Rendered by JS -->
      </div>
    </section>

    <!-- TAB 2: SETTINGS -->
    <section id="tab-settings" class="tab-content">
      <div class="settings-container">
        <!-- Auto switch config -->
        <div class="settings-section">
          <div class="section-title">🤖 Tự Động Chuyển Đổi (Auto-Switching)</div>
          <div class="section-desc">Tự động chuyển tài khoản khi chạm ngưỡng hạn mức token hoặc bị HTTP 429 rate limit.</div>
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Trạng Thái Auto-Switch</label>
              <label class="form-switch">
                <input type="checkbox" id="cfg-auto-enabled">
                <span class="switch-slider"></span>
                <span id="cfg-auto-enabled-label">Bật</span>
              </label>
              <span class="form-hint">Kích hoạt kiểm tra quota trước mỗi prompt.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Ngưỡng Chuyển (% Token 5 Giờ)</label>
              <input type="number" id="cfg-auto-threshold" class="form-control" min="50" max="99" value="95">
              <span class="form-hint">Mặc định: 95%. Hệ thống sẽ tự chuyển profile khi vượt ngưỡng này.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Bảo Vệ Hạn Mức 7 Ngày (%)</label>
              <input type="number" id="cfg-auto-safeguard" class="form-control" min="50" max="95" value="85">
              <span class="form-hint">Mặc định: 85%. Không chuyển vào tài khoản có quota 7 ngày chạm ngưỡng này.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Tự Động Quay Về Profile Chính</label>
              <label class="form-switch">
                <input type="checkbox" id="cfg-auto-return">
                <span class="switch-slider"></span>
                <span>Auto-Return</span>
              </label>
              <span class="form-hint">Tự động switch lại profile chính khi token 5h đã hồi phục.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Profile Chính (Primary)</label>
              <select id="cfg-auto-primary" class="form-control">
                <option value="">(Tự động)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Giới Hạn Trong Nhóm (Pool Tag)</label>
              <input type="text" id="cfg-auto-pool" class="form-control" placeholder="all hoặc tên tag">
            </div>
          </div>
        </div>

        <!-- Load balancing -->
        <div class="settings-section">
          <div class="section-title">⚖️ Cân Bằng Tải Quota (Smart Load Balancing)</div>
          <div class="section-desc">Chủ động phân bổ đều lưu lượng sử dụng giữa các tài khoản, tránh để 1 tài khoản cạn sạch trước.</div>
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Trạng Thái Cân Bằng Tải</label>
              <label class="form-switch">
                <input type="checkbox" id="cfg-balance-enabled">
                <span class="switch-slider"></span>
                <span>Kích hoạt</span>
              </label>
            </div>
            <div class="form-group">
              <label class="form-label">Thuật Toán Phân Phối</label>
              <select id="cfg-balance-mode" class="form-control">
                <option value="least-used">Least-Used (Ưu tiên tài khoản còn nhiều token nhất)</option>
                <option value="round-robin">Round-Robin (Luân phiên xoay vòng từng tài khoản)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Nhóm Áp Dụng (Pool Tag)</label>
              <input type="text" id="cfg-balance-pool" class="form-control" placeholder="all hoặc tên tag">
            </div>
          </div>
        </div>

        <!-- Webhook -->
        <div class="settings-section">
          <div class="section-title">🔔 Webhook Cảnh Báo Từ Xa (Telegram / Discord / Slack)</div>
          <div class="section-desc">Gửi thông báo tức thì đến điện thoại khi chạm ngưỡng hạn ngạch hoặc đổi tài khoản.</div>
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Telegram Webhook URL</label>
              <input type="text" id="cfg-webhook-telegram" class="form-control" placeholder="https://api.telegram.org/bot.../sendMessage?chat_id=...">
            </div>
            <div class="form-group">
              <label class="form-label">Discord Webhook URL</label>
              <input type="text" id="cfg-webhook-discord" class="form-control" placeholder="https://discord.com/api/webhooks/...">
            </div>
            <div class="form-group">
              <label class="form-label">Slack Webhook URL</label>
              <input type="text" id="cfg-webhook-slack" class="form-control" placeholder="https://hooks.slack.com/services/...">
            </div>
          </div>
          <div style="margin-top: 14px;">
            <button class="btn btn-secondary btn-sm" onclick="sendTestWebhook()">🧪 Gửi Thử Thông Báo (Test Ping)</button>
          </div>
        </div>

        <!-- Budget & Masking -->
        <div class="settings-section">
          <div class="section-title">💰 Ngân Sách & Bảo Mật (Budget & Masking)</div>
          <div class="section-desc">Kiểm soát chi phí hàng tháng và bảo vệ thông tin email cá nhân.</div>
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Che Mờ Email & Token (Masking)</label>
              <label class="form-switch">
                <input type="checkbox" id="cfg-masking">
                <span class="switch-slider"></span>
                <span>Ẩn thông tin nhạy cảm</span>
              </label>
              <span class="form-hint">Ẩn email dạng us***@domain.com khi hiển thị trên màn hình.</span>
            </div>
          </div>
        </div>

        <div>
          <button class="btn" style="padding: 10px 24px; font-size: 1rem;" onclick="saveAllConfigs()">💾 Lưu Toàn Bộ Cấu Hình</button>
        </div>
      </div>
    </section>

    <!-- TAB 3: DOCS & GUIDE -->
    <section id="tab-docs" class="tab-content">
      <div class="docs-search">
        <input type="text" id="docsSearchInput" placeholder="🔍 Tìm kiếm câu lệnh hoặc tính năng..." onkeyup="filterDocs()">
      </div>

      <div class="docs-grid">
        <div class="docs-nav">
          <a href="#doc-intro" class="docs-nav-link active">1. Tổng Quan</a>
          <a href="#doc-commands" class="docs-nav-link">2. Bảng Tra Cứu Lệnh</a>
          <a href="#doc-auto" class="docs-nav-link">3. Auto-Switch & Cooldown</a>
          <a href="#doc-balance" class="docs-nav-link">4. Load Balancer</a>
          <a href="#doc-webhooks" class="docs-nav-link">5. Cảnh Báo Webhook</a>
          <a href="#doc-branches" class="docs-nav-link">6. Git Branch & Dự Án</a>
          <a href="#doc-security" class="docs-nav-link">7. Bảo Mật & Isolation</a>
        </div>

        <div class="docs-body">
          <div id="doc-intro" class="docs-card">
            <h2>🚀 1. Tổng Quan về claude-swap</h2>
            <p><strong>claude-swap</strong> là plugin cao cấp dành cho Claude Code cho phép chuyển đổi nóng giữa nhiều tài khoản (cá nhân, công ty, dự án khách hàng) mà không cần thoát session hay làm gián đoạn ngữ cảnh công việc.</p>
            <p>Toàn bộ kiến trúc được xây dựng thuần túy trên nền tảng <strong>Node.js built-ins (100% Zero-Dependencies)</strong>, xử lý local tức thì và không tốn bất kỳ token model nào.</p>
          </div>

          <div id="doc-commands" class="docs-card">
            <h2>📋 2. Bảng Tra Cứu Toàn Bộ Câu Lệnh</h2>
            <table class="cmd-table">
              <thead>
                <tr>
                  <th>Lệnh CLI / Plugin</th>
                  <th>Mô tả chi tiết</th>
                </tr>
              </thead>
              <tbody id="cmd-tbody">
                <tr><td><span class="cmd-code">/profile</span></td><td>Hiển thị hướng dẫn tra cứu tất cả các lệnh</td></tr>
                <tr><td><span class="cmd-code">/profile list</span></td><td>Liệt kê danh sách profiles kèm quota 5h, 7d và email</td></tr>
                <tr><td><span class="cmd-code">/profile &lt;tên|alias&gt;</span></td><td>Chuyển nhanh sang profile chỉ định</td></tr>
                <tr><td><span class="cmd-code">/profile pick</span></td><td>Chọn profile tương tác bằng phím mũi tên ↑ ↓</td></tr>
                <tr><td><span class="cmd-code">/profile web</span></td><td>Mở Web Dashboard trực quan và cấu hình plugin</td></tr>
                <tr><td><span class="cmd-code">/profile run &lt;tên&gt;</span></td><td>Chạy session Claude Code song song độc lập</td></tr>
                <tr><td><span class="cmd-code">/profile add-token &lt;tok&gt;</span></td><td>Đăng ký profile trực tiếp từ setup-token hoặc API key</td></tr>
                <tr><td><span class="cmd-code">/profile balance</span></td><td>Bật/tắt chế độ cân bằng tải Quota thông minh</td></tr>
                <tr><td><span class="cmd-code">/profile webhook</span></td><td>Cấu hình thông báo Telegram, Discord, Slack</td></tr>
                <tr><td><span class="cmd-code">/profile forecast</span></td><td>Dự báo tốc độ tiêu thụ % token/giờ và thời điểm cạn hạn mức</td></tr>
                <tr><td><span class="cmd-code">/profile cooldown</span></td><td>Đồng hồ đếm ngược thời gian reset quota 5h của các tài khoản</td></tr>
                <tr><td><span class="cmd-code">/profile doctor</span></td><td>Quét chẩn đoán token OAuth, thời hạn và sức khỏe tài khoản</td></tr>
                <tr><td><span class="cmd-code">/profile bind-branch &lt;pat&gt;</span></td><td>Gắn profile tự động theo nhánh Git (vd: feat/*, work-*)</td></tr>
                <tr><td><span class="cmd-code">/profile temp &lt;tên&gt; [tg]</span></td><td>Mượn tạm profile thứ hai (vd: 30m, 1h) rồi tự hoàn lại</td></tr>
                <tr><td><span class="cmd-code">/profile lang [vi|en]</span></td><td>Chuyển đổi ngôn ngữ hiển thị (Tiếng Việt / English)</td></tr>
              </tbody>
            </table>
          </div>

          <div id="doc-auto" class="docs-card">
            <h2>🤖 3. Cơ Chế Auto-Switch, Safeguard 7 Ngày & Cooldown</h2>
            <p>Hệ thống tự động kích hoạt kiểm tra hạn ngạch thông qua hook <span class="cmd-code">prompt.submit</span> trước khi gửi tin nhắn đến Claude Code:</p>
            <p>• <strong>Ngưỡng 5 Giờ:</strong> Khi token 5h chạm ngưỡng cài đặt (mặc định 95%), hệ thống tự động tìm tài khoản khác có hạn ngạch dồi dào nhất.</p>
            <p>• <strong>Bảo vệ 7 Ngày (Safeguard):</strong> Ngăn chặn việc chuyển vào tài khoản sắp hết hạn ngạch tuần (mặc định 85%) để tránh bị gián đoạn công việc dài hạn.</p>
            <p>• <strong>Tự động quay về (Auto-Return):</strong> Khi tài khoản chính (Primary) đã qua thời gian cooldown và reset token, hệ thống sẽ tự động switch lại mà không cần thao tác tay.</p>
          </div>

          <div id="doc-balance" class="docs-card">
            <h2>⚖️ 4. Cân Bằng Tải Quota (Smart Load Balancing)</h2>
            <p>Khác với cơ chế phản ứng khi chạm trần, chế độ Cân Bằng Tải chủ động phân phối công việc:</p>
            <p>• <strong>Least-Used:</strong> Luôn tự động chọn tài khoản có % sử dụng thấp nhất trong nhóm.</p>
            <p>• <strong>Round-Robin:</strong> Luân phiên xoay vòng giữa các tài khoản sau mỗi phiên làm việc để mức tiêu thụ dàn đều.</p>
          </div>

          <div id="doc-webhooks" class="docs-card">
            <h2>🔔 5. Cấu Hình Webhook Cảnh Báo Ra Bên Ngoài</h2>
            <p>Bạn có thể liên kết Webhook của Telegram, Discord hoặc Slack để nhận cảnh báo về điện thoại khi treo máy chạy tác vụ tự động:</p>
            <p>• <strong>Telegram:</strong> Dán link API dạng <span class="cmd-code">https://api.telegram.org/bot&lt;TOKEN&gt;/sendMessage?chat_id=&lt;CHAT_ID&gt;</span></p>
            <p>• <strong>Discord:</strong> Tạo Webhook trong Channel Settings và dán link vào ô Discord Webhook URL.</p>
          </div>

          <div id="doc-branches" class="docs-card">
            <h2>🌿 6. Tự Động Hóa Qua Git Branch & Thư Mục Dự Án</h2>
            <p>Hệ thống hỗ trợ gán profile tự động:</p>
            <p>• <strong>Theo thư mục:</strong> <span class="cmd-code">/profile bind work</span> (tạo file <span class="cmd-code">.claude-profile</span> trong repo).</p>
            <p>• <strong>Theo nhánh Git:</strong> <span class="cmd-code">/profile bind-branch "feat/*" work</span> hoặc <span class="cmd-code">/profile bind-branch "client-*" personal</span>.</p>
          </div>

          <div id="doc-security" class="docs-card">
            <h2>🔐 7. Bảo Mật & Cách Ly Session Song Song</h2>
            <p>Mỗi profile được lưu trữ tại <span class="cmd-code">~/.config/claude-cli-profiles/&lt;tên&gt;.json</span> với phân quyền <span class="cmd-code">0600</span> nghiêm ngặt:</p>
            <p>• Khi chạy song song bằng <span class="cmd-code">/profile run &lt;tên&gt;</span>, một thư mục cô lập độc lập được tạo tại <span class="cmd-code">~/.claude-swap/.sessions/&lt;tên&gt;</span>, giúp hai cửa sổ terminal chạy hai tài khoản Claude Code cùng lúc mà không bị lẫn lộn token.</p>
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- ADD PROFILE MODAL -->
  <div class="modal-backdrop" id="addModal">
    <div class="modal-box">
      <div class="modal-header">
        <div class="modal-title">➕ Thêm Profile Mới</div>
        <button class="modal-close" onclick="closeAddModal()">&times;</button>
      </div>
      <div class="form-group">
        <label class="form-label">Tên Profile</label>
        <input type="text" id="new-profile-name" class="form-control" placeholder="vd: work, personal, dev">
      </div>
      <div class="form-group">
        <label class="form-label">Setup-Token hoặc API Key (Tùy chọn)</label>
        <textarea id="new-profile-token" class="form-control" rows="3" placeholder="Dán token bắt đầu bằng sessionKey... hoặc sk-ant-... (nếu để trống sẽ lưu tài khoản hiện tại)"></textarea>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;">
        <button class="btn btn-secondary" onclick="closeAddModal()">Hủy</button>
        <button class="btn" onclick="submitAddProfile()">Tạo Profile</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <footer>
    claude-swap • Mã nguồn mở theo giấy phép MIT • 100% Node.js Zero-Dependencies
  </footer>

  <script>
    let appData = {};

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 3000);
    }

    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('tab-' + name).classList.add('active');
    }

    async function loadData() {
      try {
        const res = await fetch('/api/data');
        appData = await res.json();
        renderDashboard();
        renderSettings();
      } catch (err) {
        showToast('Lỗi tải dữ liệu: ' + err.message);
      }
    }

    function renderDashboard() {
      document.getElementById('stat-current').innerText = appData.current || '(chưa chọn)';
      document.getElementById('stat-total').innerText = appData.profiles.length;
      document.getElementById('stat-auto').innerText = appData.auto.enabled ? ('Bật (' + appData.auto.threshold + '%)') : 'Tắt';
      document.getElementById('stat-balance').innerText = appData.balance.enabled ? (appData.balance.mode) : 'Tắt';

      const container = document.getElementById('profiles-container');
      container.innerHTML = '';

      appData.profiles.forEach(p => {
        const card = document.createElement('div');
        card.className = 'profile-card' + (p.active ? ' is-active' : '');

        let q5Html = '<span style="color:#64748b;">(Chưa có dữ liệu)</span>';
        if (p.quota5h !== null) {
          const val = Math.round(p.quota5h);
          const colorClass = val >= 95 ? 'fill-red' : val >= 80 ? 'fill-orange' : val >= 50 ? 'fill-yellow' : 'fill-green';
          q5Html = \`
            <div class="quota-meta">
              <span>Hạn mức 5 giờ</span>
              <span class="quota-val">\${val}%</span>
            </div>
            <div class="progress-bar-bg">
              <div class="progress-bar-fill \${colorClass}" style="width: \${val}%;"></div>
            </div>
          \`;
        }

        let q7Html = '';
        if (p.quota7d !== null) {
          const val = Math.round(p.quota7d);
          const colorClass = val >= 85 ? 'fill-red' : 'fill-green';
          q7Html = \`
            <div class="quota-item" style="margin-top: 8px;">
              <div class="quota-meta">
                <span>Hạn mức 7 ngày</span>
                <span class="quota-val">\${val}%</span>
              </div>
              <div class="progress-bar-bg">
                <div class="progress-bar-fill \${colorClass}" style="width: \${val}%;"></div>
              </div>
            </div>
          \`;
        }

        let cooldownHtml = '';
        if (p.cooldownSec > 0) {
          const mins = Math.floor(p.cooldownSec / 60);
          const secs = p.cooldownSec % 60;
          cooldownHtml = \`<div class="cooldown-text">⏱️ Reset sau: \${mins}m \${secs}s</div>\`;
        }

        const tagsHtml = p.tags.map(t => \`<span class="tag-pill">🏷️ \${t}</span>\`).join(' ');
        const aliasHtml = p.aliases.length ? \`<span style="color:#94a3b8; font-size:0.8rem;">(alias: \${p.aliases.join(', ')})</span>\` : '';

        card.innerHTML = \`
          <div class="profile-header">
            <div class="profile-title">
              <span style="font-size: 1.3rem;">\${p.active ? '🟢' : '⚪'}</span>
              <div>
                <div class="profile-name">\${p.name} \${aliasHtml}</div>
                <div class="profile-email">👤 \${p.email || 'Chưa liên kết email'}</div>
              </div>
            </div>
            \${p.active ? '<span class="active-badge">Active</span>' : ''}
          </div>

          <div style="display: flex; gap: 6px; flex-wrap: wrap;">\${tagsHtml}</div>

          <div class="quota-box">
            <div class="quota-item">\${q5Html}</div>
            \${q7Html}
            \${cooldownHtml}
          </div>

          <div class="profile-actions">
            \${!p.active ? \`<button class="btn btn-sm" onclick="doSwap('\${p.name}')">🔀 Chuyển Ngay</button>\` : '<span style="font-size:0.84rem; color:#34d399; font-weight:600;">✓ Đang sử dụng</span>'}
            <button class="btn btn-secondary btn-sm" onclick="toggleDisable('\${p.name}', \${p.disabled})">
              \${p.disabled ? 'Bật Auto' : 'Tắt Auto'}
            </button>
            <button class="btn btn-secondary btn-sm btn-danger" style="margin-left: auto;" onclick="doDelete('\${p.name}')">Xóa</button>
          </div>
        \`;
        container.appendChild(card);
      });
    }

    function renderSettings() {
      document.getElementById('cfg-auto-enabled').checked = Boolean(appData.auto.enabled);
      document.getElementById('cfg-auto-threshold').value = appData.auto.threshold || 95;
      document.getElementById('cfg-auto-safeguard').value = appData.auto.safeguard || 85;
      document.getElementById('cfg-auto-return').checked = Boolean(appData.auto.autoReturn);
      document.getElementById('cfg-auto-pool').value = appData.auto.pool || 'all';

      const primSel = document.getElementById('cfg-auto-primary');
      primSel.innerHTML = '<option value="">(Tự động)</option>';
      appData.profiles.forEach(p => {
        primSel.innerHTML += \`<option value="\${p.name}" \${appData.auto.primary === p.name ? 'selected' : ''}>\${p.name}</option>\`;
      });

      document.getElementById('cfg-balance-enabled').checked = Boolean(appData.balance.enabled);
      document.getElementById('cfg-balance-mode').value = appData.balance.mode || 'least-used';
      document.getElementById('cfg-balance-pool').value = appData.balance.pool || 'all';

      document.getElementById('cfg-webhook-telegram').value = appData.webhook.telegram || '';
      document.getElementById('cfg-webhook-discord').value = appData.webhook.discord || '';
      document.getElementById('cfg-webhook-slack').value = appData.webhook.slack || '';

      document.getElementById('cfg-masking').checked = Boolean(appData.masking);
    }

    async function doSwap(name) {
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'swap', profile: name })
        });
        const data = await res.json();
        if (data.ok) {
          showToast('Đã chuyển sang: ' + name);
          loadData();
        } else {
          showToast('Lỗi: ' + data.error);
        }
      } catch (err) {
        showToast('Lỗi: ' + err.message);
      }
    }

    async function toggleDisable(name, isCurrentlyDisabled) {
      try {
        const action = isCurrentlyDisabled ? 'enable' : 'disable';
        await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, profile: name })
        });
        showToast((isCurrentlyDisabled ? 'Đã bật' : 'Đã tắt') + ' auto-switch cho ' + name);
        loadData();
      } catch (err) {
        showToast('Lỗi: ' + err.message);
      }
    }

    async function doDelete(name) {
      if (!confirm('Bạn có chắc chắn muốn xóa profile ' + name + '?')) return;
      try {
        await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', profile: name })
        });
        showToast('Đã xóa profile: ' + name);
        loadData();
      } catch (err) {
        showToast('Lỗi: ' + err.message);
      }
    }

    async function saveAllConfigs() {
      const payload = {
        action: 'save_config',
        auto: {
          enabled: document.getElementById('cfg-auto-enabled').checked,
          threshold: parseInt(document.getElementById('cfg-auto-threshold').value, 10),
          safeguard: parseInt(document.getElementById('cfg-auto-safeguard').value, 10),
          autoReturn: document.getElementById('cfg-auto-return').checked,
          primary: document.getElementById('cfg-auto-primary').value || null,
          pool: document.getElementById('cfg-auto-pool').value || 'all'
        },
        balance: {
          enabled: document.getElementById('cfg-balance-enabled').checked,
          mode: document.getElementById('cfg-balance-mode').value,
          pool: document.getElementById('cfg-balance-pool').value || 'all'
        },
        webhook: {
          telegram: document.getElementById('cfg-webhook-telegram').value.trim() || null,
          discord: document.getElementById('cfg-webhook-discord').value.trim() || null,
          slack: document.getElementById('cfg-webhook-slack').value.trim() || null
        },
        masking: document.getElementById('cfg-masking').checked
      };

      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
          showToast('✓ Đã lưu toàn bộ cấu hình thành công!');
          loadData();
        } else {
          showToast('Lỗi lưu cấu hình: ' + data.error);
        }
      } catch (err) {
        showToast('Lỗi: ' + err.message);
      }
    }

    async function sendTestWebhook() {
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'test_webhook' })
        });
        const data = await res.json();
        if (data.ok) {
          showToast('✓ Đã gửi tin nhắn thử nghiệm thành công!');
        } else {
          showToast('Lỗi: ' + data.error);
        }
      } catch (err) {
        showToast('Lỗi: ' + err.message);
      }
    }

    function showAddModal() {
      document.getElementById('addModal').classList.add('show');
    }
    function closeAddModal() {
      document.getElementById('addModal').classList.remove('show');
    }
    async function submitAddProfile() {
      const name = document.getElementById('new-profile-name').value.trim();
      const token = document.getElementById('new-profile-token').value.trim();
      if (!name) return alert('Vui lòng nhập tên profile');

      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add_profile', name, token })
        });
        const data = await res.json();
        if (data.ok) {
          closeAddModal();
          showToast('Đã thêm profile ' + name + ' thành công!');
          document.getElementById('new-profile-name').value = '';
          document.getElementById('new-profile-token').value = '';
          loadData();
        } else {
          alert('Lỗi: ' + data.error);
        }
      } catch (err) {
        alert('Lỗi: ' + err.message);
      }
    }

    function toggleLanguage() {
      const next = appData.language === 'vi' ? 'en' : 'vi';
      fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_lang', language: next })
      }).then(() => {
        showToast('Đã đổi ngôn ngữ sang: ' + next.toUpperCase());
        loadData();
      });
    }

    function filterDocs() {
      const q = document.getElementById('docsSearchInput').value.toLowerCase();
      const rows = document.querySelectorAll('#cmd-tbody tr');
      rows.forEach(r => {
        const text = r.innerText.toLowerCase();
        r.style.display = text.includes(q) ? '' : 'none';
      });
    }

    // Auto-refresh data every 5 seconds
    setInterval(loadData, 5000);
    loadData();
  </script>
</body>
</html>`;
}

export async function startWebDashboard(home = os.homedir(), options = {}) {
  const initialPort = options.port || 3737
  const shouldOpen = options.open !== false
  const pf = webPidFile(home)

  let port = initialPort
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderDashboardHtml())
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/data') {
      try {
        const data = getDashboardData(home)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      let bodyStr = ''
      req.on('data', chunk => { bodyStr += chunk })
      req.on('end', async () => {
        try {
          const body = JSON.parse(bodyStr || '{}')
          const action = body.action

          switch (action) {
            case 'swap': {
              swapProfile(home, body.profile, { type: 'manual', reason: 'Web Dashboard Switch' })
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            case 'disable': {
              disableProfile(home, body.profile)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            case 'enable': {
              enableProfile(home, body.profile)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            case 'delete': {
              deleteProfile(home, body.profile)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            case 'add_profile': {
              if (body.token) {
                addTokenProfile(home, body.token, body.name)
              } else {
                saveProfile(home, body.name, true)
              }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            case 'save_config': {
              if (body.auto) saveAutoSwitchConfig(home, body.auto)
              if (body.balance) saveBalanceConfig(home, body.balance)
              if (body.webhook) saveWebhookConfig(home, body.webhook)
              if (typeof body.masking === 'boolean') setMasking(home, body.masking)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            case 'save_lang': {
              if (body.language) setLanguage(home, body.language)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            case 'test_webhook': {
              await testWebhook(home)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            default:
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: `Unknown action: ${action}` }))
              return
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  // Listen with retry on next port
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      break
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        port++
      } else {
        throw err
      }
    }
  }

  atomicWrite(pf, String(process.pid))
  const targetUrl = `http://localhost:${port}`

  if (shouldOpen) {
    openBrowser(targetUrl)
  }

  return {
    server,
    port,
    url: targetUrl,
    close: () => {
      server.close()
      try {
        if (fs.existsSync(pf)) fs.unlinkSync(pf)
      } catch {}
    },
  }
}
