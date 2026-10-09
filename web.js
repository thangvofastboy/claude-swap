import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
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
  loadAliases,
  loadBranchBindings,
  listModelAffinities,
  loadLanguage,
  setLanguage,
  loadAutoSwitchConfig,
  saveAutoSwitchConfig,
  loadUsageCache,
  profilesDir,
  atomicWrite,
  loadBalanceConfig,
  saveBalanceConfig,
  loadWebhookConfig,
  saveWebhookConfig,
  testWebhook,
  loadBudgetConfig,
  isMaskingEnabled,
  setMasking,
  maskEmail,
  maskUrl,
  quotaSnapshot,
  spawnDetached,
  loadSwapHistory,
  loadUsageHistory,
  calculateForecast,
} from './swap.js'

const HOST = '127.0.0.1'
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_BODY = 1024 * 1024
const WEBHOOK_TYPES = ['telegram', 'discord', 'slack', 'generic']
const SWAP_JS = fileURLToPath(new URL('./swap.js', import.meta.url))
// subcommands the "All features" tab may run; interactive ones (run, pick, web) stay CLI-only
const WEB_CLI = new Set([
  'list', 'current', 'usage', 'swap', 'new', 'save', 'rename', 'delete', 'import', 'folder', 'version', 'upgrade',
  'alias', 'unalias', 'aliases', 'tag', 'untag', 'tags', 'disable', 'enable', 'disabled',
  'auto', 'balance', 'forecast', 'cooldown', 'doctor', 'cleanup', 'temp', 'untemp',
  'bind', 'unbind', 'bind-branch', 'unbind-branch', 'branch-bindings',
  'affinity', 'unaffinity', 'affinities', 'notify', 'budget', 'webhook', 'mask', 'share',
  'export', 'import-enc', 'sync', 'history', 'undo', 'stats', 'statusline', 'prompt', 'completion', 'lang',
])

// Runs `node swap.js <args>` like the /profile hook does; a password goes on stdin, never argv
export function runSwapCli(home, args, password = '') {
  if (!Array.isArray(args) || args.length === 0 || args.length > 12 || !WEB_CLI.has(args[0])) {
    return Promise.resolve({ code: 1, output: `Lệnh không được phép: ${String(args?.[0])}` })
  }
  if (args.some(a => typeof a !== 'string' || a.length > 2048 || a.startsWith('--password'))) {
    return Promise.resolve({ code: 1, output: 'Tham số không hợp lệ.' })
  }
  const argv = [SWAP_JS, ...args, '--no-color']
  if (password) argv.push('--password-stdin')
  const env = { ...process.env }
  if (home !== os.homedir()) {
    // a caller-supplied home (tests) must never reach the real config
    env.HOME = home
    env.USERPROFILE = home
    delete env.CLAUDE_CONFIG_DIR
  }
  return new Promise(resolve => {
    const child = execFile(process.execPath, argv, { env, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}`.trim() })
    })
    child.stdin.on('error', () => {}) // EPIPE when the child exits before reading stdin
    child.stdin.end(password ? `${password}\n` : '')
  })
}

export function webPidFile(home = os.homedir()) {
  return path.join(profilesDir(home), '.web.pid')
}

// The token rides in the #fragment: browsers never send it to the server, so another local user
// who can reach 127.0.0.1 cannot read it from GET / (the API demands it in a header)
export function dashboardUrl(state) {
  return `http://${HOST}:${state.port}${state.token ? `/#${state.token}` : ''}`
}

function hasToken(req, token) {
  const got = Buffer.from(String(req.headers['x-dashboard-token'] || ''))
  const want = Buffer.from(token)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

export function openBrowser(url) {
  if (process.platform === 'darwin') spawnDetached('open', [url])
  else if (process.platform === 'win32') spawnDetached('cmd', ['/c', 'start', '', url])
  else spawnDetached('xdg-open', [url])
}

// { pid, port } of a dashboard that is still alive, else null (a stale pid file is removed)
export function runningDashboard(home = os.homedir()) {
  const pf = webPidFile(home)
  try {
    const raw = fs.readFileSync(pf, 'utf-8').trim()
    const state = raw.startsWith('{') ? JSON.parse(raw) : { pid: Number(raw), port: null }
    process.kill(state.pid, 0) // throws if no such process
    return state
  } catch {
    fs.rmSync(pf, { force: true })
    return null
  }
}

export function stopWebDashboard(home = os.homedir()) {
  const state = runningDashboard(home)
  if (!state) return false
  try {
    process.kill(state.pid, 'SIGTERM')
  } catch {}
  fs.rmSync(webPidFile(home), { force: true })
  return true
}

export function getDashboardData(home = os.homedir()) {
  const cur = currentProfile(home)
  const profiles = listProfiles(home)
  const disabled = loadDisabledProfiles(home)
  const cache = loadUsageCache(home)
  const masking = isMaskingEnabled(home)
  const aliases = loadAliases(home)
  const now = Date.now()

  const profileCards = profiles.map(name => {
    const rawEmail = profileEmail(home, name)
    const email = masking ? maskEmail(rawEmail, true) : rawEmail
    const tags = getProfileTags(home, name)
    const quota = quotaSnapshot(home, cache, name)
    const cooldownSec = quota.resetAt ? Math.max(0, Math.round((quota.resetAt - now) / 1000)) : 0

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
      quota5h: quota.util5h,
      quota7d: quota.util7d,
      cooldownSec,
      rateLimited: quota.rateLimited,
    }
  })

  const auto = loadAutoSwitchConfig(home)
  const usageHistory = loadUsageHistory(home)
  return {
    current: cur,
    profiles: profileCards,
    auto,
    balance: loadBalanceConfig(home),
    // webhook URLs carry their own secret (bot token, signing path): the browser only sees the origin
    webhook: Object.fromEntries(Object.entries(loadWebhookConfig(home)).map(([k, v]) => [k, v ? maskUrl(v) : null])),
    budget: loadBudgetConfig(home),
    masking,
    language: loadLanguage(home),
    branchBindings: loadBranchBindings(home),
    affinities: listModelAffinities(home),
    aliases,
    swapHistory: loadSwapHistory(home),
    usageHistory,
    forecast: Object.fromEntries(profiles.map(n => [n, calculateForecast(home, n, auto.threshold || 95, usageHistory)])),
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
    .tab-btn { background: transparent; border: none; color: var(--text-muted); padding: 8px 14px; white-space: nowrap; border-radius: 6px; cursor: pointer; font-size: 0.95rem; font-weight: 500; transition: all 0.2s; display: flex; align-items: center; gap: 6px; }
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


    /* Stats & charts (categorical slots validated against #111827) */
    :root { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767; --grid: #1f2937; }
    .chart-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .chart-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .chart-title { font-size: 1.05rem; font-weight: 700; color: #fff; }
    .chart-sub { font-size: 0.8rem; color: var(--text-muted); }
    .chart-wrap { position: relative; width: 100%; }
    .chart-wrap svg { width: 100%; height: auto; display: block; }
    .chart-wrap text { fill: var(--text-muted); font-size: 11px; }
    .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 0.82rem; color: #d1d5db; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .viz-tip { position: absolute; pointer-events: none; background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 0.8rem; color: #fff; display: none; white-space: nowrap; z-index: 5; box-shadow: 0 6px 18px rgba(0,0,0,0.5); }
    .viz-tip i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 6px; }
    .empty-state { color: #64748b; font-size: 0.9rem; padding: 28px 0; text-align: center; }
    .chart-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 20px; }
    .chart-grid2 .chart-card { margin-bottom: 0; }
    .tbl-wrap { overflow-x: auto; }

    /* All features */
    .feat-intro { font-size: 0.88rem; color: var(--text-muted); margin-bottom: 16px; }
    .feat-out { background: #020617; border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 20px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.82rem; color: #e5e7eb; white-space: pre-wrap; max-height: 320px; overflow: auto; position: sticky; top: 70px; z-index: 4; }
    .feat-out.err { border-color: var(--danger); }
    .quick-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 22px; }
    .feat-group { margin-bottom: 26px; }
    .feat-group h3 { font-size: 1.05rem; color: #fff; margin-bottom: 12px; }
    .feat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
    .feat-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
    .feat-card .ft { font-weight: 600; color: #fff; font-size: 0.92rem; }
    .feat-card .fd { font-size: 0.78rem; color: var(--text-muted); }
    .feat-card .fc { font-family: monospace; font-size: 0.75rem; color: #38bdf8; }
    .feat-card .form-control { padding: 7px 10px; font-size: 0.85rem; }
    .feat-card label.flag { font-size: 0.82rem; color: #d1d5db; display: flex; gap: 6px; align-items: center; }
    @media (max-width: 720px) { .chart-grid2 { grid-template-columns: 1fr; } header { flex-wrap: wrap; gap: 10px; } nav { flex-wrap: wrap; } }

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
      <button class="tab-btn" onclick="switchTab('stats')">📈 Thống kê</button>
      <button class="tab-btn" onclick="switchTab('features')">🧰 Tính năng</button>
      <button class="tab-btn" onclick="switchTab('settings')">⚙️ Cấu hình</button>
      <button class="tab-btn" onclick="switchTab('docs')">📖 Hướng dẫn</button>
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


    <!-- TAB: STATS -->
    <section id="tab-stats" class="tab-content">
      <div class="stats-row" id="stats-tiles"></div>

      <div class="chart-card">
        <div class="chart-head">
          <div>
            <div class="chart-title" id="usage-title">Mức dùng quota theo thời gian</div>
            <div class="chart-sub">Mỗi điểm là một lần đo quota (tối đa 50 lần gần nhất mỗi profile)</div>
          </div>
          <select id="usage-window" class="form-control" style="width:auto;" onchange="statsKey=''; renderStats()">
            <option value="util5h">Hạn mức 5 giờ</option>
            <option value="util7d">Hạn mức 7 ngày</option>
          </select>
        </div>
        <div class="legend" id="usage-legend"></div>
        <div class="chart-wrap" id="usage-chart"></div>
      </div>

      <div class="chart-grid2">
        <div class="chart-card">
          <div class="chart-head">
            <div>
              <div class="chart-title">Số lần chuyển profile mỗi ngày</div>
              <div class="chart-sub">14 ngày gần nhất, theo kiểu chuyển</div>
            </div>
          </div>
          <div class="legend" id="daily-legend"></div>
          <div class="chart-wrap" id="daily-chart"></div>
        </div>
        <div class="chart-card">
          <div class="chart-head">
            <div>
              <div class="chart-title">Profile được chuyển đến nhiều nhất</div>
              <div class="chart-sub">Trong lịch sử đã lưu (tối đa 100 lần gần nhất)</div>
            </div>
          </div>
          <div class="chart-wrap" id="dest-chart"></div>
        </div>
      </div>

      <div class="chart-card" style="margin-top:20px;">
        <div class="chart-head"><div class="chart-title">📈 Dự báo cạn quota 5 giờ</div></div>
        <div class="tbl-wrap"><table class="cmd-table" id="forecast-table"></table></div>
      </div>

      <div class="chart-card">
        <div class="chart-head"><div class="chart-title">📜 Lịch sử chuyển profile gần nhất</div></div>
        <div class="tbl-wrap"><table class="cmd-table" id="history-table"></table></div>
      </div>
    </section>

    <!-- TAB: ALL FEATURES -->
    <section id="tab-features" class="tab-content">
      <p class="feat-intro">Mọi lệnh <span class="cmd-code">/profile</span> đều có ở đây. Điền vào ô rồi bấm chạy, kết quả hiện ở khung bên dưới. Auto-switch, cân bằng tải, che email và đặt URL webhook chỉnh ở tab ⚙️ Cấu hình (URL webhook là bí mật nên không đi qua dòng lệnh). Mật khẩu sao lưu được chuyển qua stdin và không lưu ở đâu cả.</p>
      <pre class="feat-out" id="cli-output">Kết quả lệnh sẽ hiện ở đây.</pre>
      <div class="feat-group">
        <h3>👀 Xem nhanh</h3>
        <div class="quick-row" id="quick-row"></div>
      </div>
      <div id="features-container"></div>
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
          <div class="section-desc">Gửi thông báo tức thì đến điện thoại khi chạm ngưỡng hạn ngạch hoặc đổi tài khoản. URL webhook chứa khóa bí mật nên dashboard không bao giờ hiện lại nó: ô trống nghĩa là giữ nguyên, muốn gỡ thì dùng "Gỡ webhook" ở tab 🧰 Tính năng.</div>
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
            <div class="form-group">
              <label class="form-label">Generic Webhook URL</label>
              <input type="text" id="cfg-webhook-generic" class="form-control" placeholder="https://example.com/hook">
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
            <p>• Khi chạy song song bằng <span class="cmd-code">/profile run &lt;tên&gt;</span>, một thư mục cô lập độc lập được tạo tại <span class="cmd-code">~/.config/claude-cli-profiles/.sessions/&lt;tên&gt;</span>, giúp hai cửa sổ terminal chạy hai tài khoản Claude Code cùng lúc mà không bị lẫn lộn token.</p>
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
    let TOKEN = '';
    try {
      if (location.hash.length > 1) {
        sessionStorage.setItem('cs-token', location.hash.slice(1));
        history.replaceState(null, '', location.pathname);
      }
      TOKEN = sessionStorage.getItem('cs-token') || '';
    } catch (e) {
      TOKEN = location.hash.slice(1);
    }
    async function api(url, opts) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { 'X-Dashboard-Token': TOKEN });
      const res = await fetch(url, opts);
      if (res.status === 401) throw new Error('phiên đã hết hạn, hãy mở lại bằng /profile web');
      return res;
    }

    function esc(v) {
      return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

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
        const res = await api('/api/data');
        appData = await res.json();
        renderDashboard();
        renderSettings();
        renderStats();
        renderFeatures();
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

        const tagsHtml = p.tags.map(t => \`<span class="tag-pill">🏷️ \${esc(t)}</span>\`).join(' ');
        const aliasHtml = p.aliases.length ? \`<span style="color:#94a3b8; font-size:0.8rem;">(alias: \${esc(p.aliases.join(', '))})</span>\` : '';

        card.innerHTML = \`
          <div class="profile-header">
            <div class="profile-title">
              <span style="font-size: 1.3rem;">\${p.active ? '🟢' : '⚪'}</span>
              <div>
                <div class="profile-name">\${esc(p.name)} \${aliasHtml}</div>
                <div class="profile-email">👤 \${esc(p.email || 'Chưa liên kết email')}</div>
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


    // ------------------------------------------------------------ stats & charts
    const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
    const TYPE_META = [['manual', 'Thủ công', SERIES[0]], ['auto', 'Tự động', SERIES[1]], ['project', 'Theo dự án', SERIES[2]]];
    let statsKey = '';

    function pad2(n) { return String(n).padStart(2, '0'); }
    function fmtTime(t) { const d = new Date(t); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
    function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    // color follows the profile (its position in the full list), never its rank in a chart
    function profileColor(name) { const i = (appData.profiles || []).findIndex(p => p.name === name); return i >= 0 && i < SERIES.length ? SERIES[i] : '#64748b'; }
    function tile(label, value, sub) {
      return '<div class="stat-card"><span class="stat-label">' + esc(label) + '</span><div class="stat-value">' + esc(value) + '</div>' + (sub ? '<span class="chart-sub">' + esc(sub) + '</span>' : '') + '</div>';
    }
    function legendHtml(items) { return items.map(it => '<span><i style="background:' + it[1] + '"></i>' + esc(it[0]) + '</span>').join(''); }

    function attachTip(wrap, svg, onMove) {
      const tip = document.createElement('div');
      tip.className = 'viz-tip';
      wrap.appendChild(tip);
      svg.addEventListener('mousemove', ev => {
        const r = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const x = (ev.clientX - r.left) * vb.width / r.width;
        const html = onMove(x);
        if (!html) { tip.style.display = 'none'; return; }
        tip.innerHTML = html;
        tip.style.display = 'block';
        const left = ev.clientX - r.left + 14;
        tip.style.left = Math.min(left, wrap.clientWidth - tip.offsetWidth - 4) + 'px';
        tip.style.top = Math.max(0, ev.clientY - r.top - tip.offsetHeight - 10) + 'px';
      });
      svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; onMove(null); });
    }

    function renderUsageChart() {
      const field = document.getElementById('usage-window').value;
      const hist = appData.usageHistory || {};
      const series = (appData.profiles || []).map(p => ({
        name: p.name,
        color: profileColor(p.name),
        pts: (hist[p.name] || []).filter(e => typeof e[field] === 'number' && !isNaN(e[field])).map(e => ({ t: e.timestamp, v: e[field] }))
      })).filter(s => s.pts.length);
      const wrap = document.getElementById('usage-chart');
      const legend = document.getElementById('usage-legend');
      if (!series.length) {
        legend.innerHTML = '';
        wrap.innerHTML = '<div class="empty-state">Chưa có lần đo quota nào. Dữ liệu sẽ dồn dần mỗi khi plugin kiểm tra quota (khoảng 5 phút một lần khi bạn dùng Claude Code).</div>';
        return;
      }
      legend.innerHTML = series.length > 1 ? legendHtml(series.map(s => [s.name, s.color])) : '';
      const W = 860, H = 280, L = 40, R = 110, T = 14, B = 30;
      let t0 = Infinity, t1 = -Infinity;
      series.forEach(s => s.pts.forEach(p => { t0 = Math.min(t0, p.t); t1 = Math.max(t1, p.t); }));
      if (t1 - t0 < 60000) { t0 -= 1800000; t1 += 1800000; }
      const X = t => L + (t - t0) / (t1 - t0) * (W - L - R);
      const Y = v => T + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - T - B);
      let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Mức dùng quota theo thời gian">';
      [0, 25, 50, 75, 100].forEach(v => {
        svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--grid)" stroke-width="1"/>';
        svg += '<text x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '%</text>';
      });
      for (let i = 0; i < 4; i++) {
        const t = t0 + (t1 - t0) * i / 3;
        svg += '<text x="' + X(t) + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 ? 'start' : i === 3 ? 'end' : 'middle') + '">' + fmtTime(t) + '</text>';
      }
      const limit = field === 'util5h' ? (appData.auto.threshold || 95) : (appData.auto.safeguardThreshold || 85);
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(limit) + '" y2="' + Y(limit) + '" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4"/>';
      svg += '<text x="' + (W - R + 6) + '" y="' + (Y(limit) + 4) + '">' + (field === 'util5h' ? 'ngưỡng ' : 'safeguard ') + limit + '%</text>';
      series.forEach(s => {
        const d = s.pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
        svg += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
        if (s.pts.length < 12) s.pts.forEach(p => { svg += '<circle cx="' + X(p.t) + '" cy="' + Y(p.v) + '" r="4" fill="' + s.color + '" stroke="var(--card-bg)" stroke-width="2"/>'; });
      });
      if (series.length <= 4) {
        const ends = series.map(s => { const p = s.pts[s.pts.length - 1]; return { s, x: X(p.t), y: Y(p.v), v: p.v }; }).sort((a, b) => a.y - b.y);
        for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
        ends.forEach(e => { svg += '<text x="' + (W - R + 6) + '" y="' + (e.y + 4) + '" style="fill:#e5e7eb">' + esc(e.s.name) + ' ' + Math.round(e.v) + '%</text>'; });
      }
      svg += '<line id="usage-cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="#94a3b8" stroke-width="1" visibility="hidden"/>';
      svg += '<rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>';
      svg += '</svg>';
      wrap.innerHTML = svg;
      const el = wrap.querySelector('svg');
      const cross = wrap.querySelector('#usage-cross');
      attachTip(wrap, el, x => {
        if (x === null || x < L || x > W - R) { cross.setAttribute('visibility', 'hidden'); return ''; }
        const t = t0 + (x - L) / (W - L - R) * (t1 - t0);
        let best = null;
        series.forEach(s => s.pts.forEach(p => { if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; }));
        cross.setAttribute('x1', X(best.t)); cross.setAttribute('x2', X(best.t)); cross.setAttribute('visibility', 'visible');
        const rows = series.map(s => {
          const near = s.pts.reduce((a, p) => Math.abs(p.t - best.t) < Math.abs(a.t - best.t) ? p : a);
          return Math.abs(near.t - best.t) <= 600000 ? '<div><i style="background:' + s.color + '"></i>' + esc(s.name) + ': <b>' + Math.round(near.v) + '%</b></div>' : '';
        }).join('');
        return '<div style="color:#94a3b8;margin-bottom:4px;">' + fmtTime(best.t) + '</div>' + rows;
      });
    }

    function renderDailyChart(hist) {
      const days = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let i = 13; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); days.push({ key: dayKey(d), label: pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1), manual: 0, auto: 0, project: 0 }); }
      const byKey = Object.fromEntries(days.map(d => [d.key, d]));
      hist.forEach(h => { const d = byKey[dayKey(h.timestamp)]; if (d) d[h.type === 'auto' || h.type === 'project' ? h.type : 'manual']++; });
      const wrap = document.getElementById('daily-chart');
      document.getElementById('daily-legend').innerHTML = legendHtml(TYPE_META.map(m => [m[1], m[2]]));
      const max = Math.max(0, ...days.map(d => d.manual + d.auto + d.project));
      if (!max) { wrap.innerHTML = '<div class="empty-state">Chưa có lần chuyển profile nào trong 14 ngày qua.</div>'; return; }
      const W = 480, H = 240, L = 30, R = 8, T = 10, B = 26;
      const step = Math.max(1, Math.ceil(max / 4));
      const top = step * 4;
      const bw = (W - L - R) / days.length;
      const Y = v => T + (1 - v / top) * (H - T - B);
      let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Số lần chuyển profile mỗi ngày">';
      for (let v = 0; v <= top; v += step) {
        svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--grid)"/>';
        svg += '<text x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '</text>';
      }
      days.forEach((d, i) => {
        const x = L + i * bw + bw * 0.2, w = bw * 0.6;
        let acc = 0;
        TYPE_META.forEach(m => {
          const v = d[m[0]];
          if (!v) return;
          const y0 = Y(acc), y1 = Y(acc + v);
          svg += '<rect x="' + x + '" y="' + y1 + '" width="' + w + '" height="' + Math.max(1, y0 - y1 - (acc ? 2 : 0)) + '" rx="2" fill="' + m[2] + '"/>';
          acc += v;
        });
        if (i % 2 === 1 || days.length <= 7) svg += '<text x="' + (x + w / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + d.label + '</text>';
      });
      svg += '<rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/></svg>';
      wrap.innerHTML = svg;
      attachTip(wrap, wrap.querySelector('svg'), x => {
        if (x === null) return '';
        const i = Math.floor((x - L) / bw);
        const d = days[i];
        if (!d) return '';
        return '<div style="color:#94a3b8;margin-bottom:4px;">' + d.label + '</div>' + TYPE_META.map(m => '<div><i style="background:' + m[2] + '"></i>' + m[1] + ': <b>' + d[m[0]] + '</b></div>').join('');
      });
    }

    function renderDestChart(hist) {
      const counts = {};
      hist.forEach(h => { if (h.to) counts[h.to] = (counts[h.to] || 0) + 1; });
      const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const wrap = document.getElementById('dest-chart');
      if (!rows.length) { wrap.innerHTML = '<div class="empty-state">Chưa có dữ liệu.</div>'; return; }
      const max = rows[0][1];
      wrap.innerHTML = rows.map(r =>
        '<div style="display:grid;grid-template-columns:120px 1fr 40px;gap:10px;align-items:center;margin:8px 0;font-size:0.85rem;" title="' + esc(r[0]) + ': ' + r[1] + ' lần">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;">' + esc(r[0]) + '</span>' +
        '<div style="background:var(--grid);height:12px;border-radius:4px;"><div style="width:' + (r[1] / max * 100) + '%;height:100%;border-radius:4px;background:' + SERIES[0] + ';"></div></div>' +
        '<span style="color:#e5e7eb;text-align:right;">' + r[1] + '</span></div>'
      ).join('');
    }

    function renderStats() {
      const hist = appData.swapHistory || [];
      const key = JSON.stringify([hist, appData.usageHistory, appData.forecast, appData.auto, (appData.profiles || []).map(p => p.name)]);
      if (key === statsKey) return; // unchanged: keep hover state and avoid redraw flicker on the 5s poll
      statsKey = key;

      const counts = { manual: 0, auto: 0, project: 0 };
      const dest = {};
      const weekAgo = Date.now() - 7 * 86400000;
      let week = 0;
      hist.forEach(h => {
        counts[h.type === 'auto' || h.type === 'project' ? h.type : 'manual']++;
        if (h.to) dest[h.to] = (dest[h.to] || 0) + 1;
        if (new Date(h.timestamp).getTime() >= weekAgo) week++;
      });
      const top = Object.entries(dest).sort((a, b) => b[1] - a[1])[0];
      document.getElementById('stats-tiles').innerHTML =
        tile('Tổng lượt chuyển', hist.length, hist.length >= 100 ? '100 lần gần nhất' : '') +
        tile('7 ngày qua', week) +
        tile('Thủ công / Tự động / Dự án', counts.manual + ' / ' + counts.auto + ' / ' + counts.project) +
        tile('Hay dùng nhất', top ? top[0] : '-', top ? top[1] + ' lần' : '');

      renderUsageChart();
      renderDailyChart(hist);
      renderDestChart(hist);

      const fc = appData.forecast || {};
      const names = Object.keys(fc);
      document.getElementById('forecast-table').innerHTML = names.length
        ? '<thead><tr><th>Profile</th><th>Đang dùng</th><th>Tốc độ</th><th>Chạm ngưỡng</th></tr></thead><tbody>' + names.map(n => {
            const f = fc[n];
            if (!f.hasData) return '<tr><td>' + esc(n) + '</td><td colspan="3" style="color:#64748b;">' + esc(f.message) + '</td></tr>';
            const eta = f.trend === 'increasing'
              ? (f.minutesUntilThreshold <= 30 ? '🔴 ' : f.minutesUntilThreshold <= 60 ? '🟠 ' : '🟡 ') + '~' + f.minutesUntilThreshold + ' phút (' + fmtTime(f.estimatedTimestamp) + ')'
              : '🟢 Ổn định';
            return '<tr><td>' + esc(n) + '</td><td>' + Math.round(f.currentUtil) + '%</td><td>' + (f.burnRatePerHour > 0 ? '+' + f.burnRatePerHour + '%/giờ' : '0') + '</td><td>' + eta + '</td></tr>';
          }).join('') + '</tbody>'
        : '<tbody><tr><td class="empty-state">Chưa có profile nào.</td></tr></tbody>';

      const typeLabel = { auto: '🤖 Tự động', project: '📁 Dự án' };
      document.getElementById('history-table').innerHTML = hist.length
        ? '<thead><tr><th>Thời gian</th><th>Kiểu</th><th>Từ</th><th>Sang</th><th>Lý do</th></tr></thead><tbody>' + hist.slice(0, 20).map(h =>
            '<tr><td>' + fmtTime(h.timestamp) + '</td><td>' + (typeLabel[h.type] || '👤 Thủ công') + '</td><td>' + esc(h.from) + '</td><td>' + esc(h.to) + '</td><td style="color:#94a3b8;">' + esc(h.reason) + '</td></tr>'
          ).join('') + '</tbody>'
        : '<tbody><tr><td class="empty-state">Chưa có lịch sử chuyển profile.</td></tr></tbody>';
    }

    // ------------------------------------------------------------ all features (runs whitelisted swap.js subcommands)
    // field: [kind, label, extra]; kind = profile | text | number | password | flag | choice
    const FEATURES = [
      ['👤 Profile & tài khoản', [
        ['Chuyển profile', ['swap'], [['profile', 'Profile']]],
        ['Tạo profile từ tài khoản đang đăng nhập', ['new'], [['text', 'Tên profile mới'], ['flag', 'Ghi đè nếu đã có', '--force']]],
        ['Lưu tài khoản hiện tại vào profile', ['save'], [['profile', 'Profile'], ['flag', 'Ghi đè', '--force']]],
        ['Xóa profile', ['delete'], [['profile', 'Profile']], true],
        ['Đặt alias', ['alias'], [['text', 'Alias (vd: w)'], ['profile', 'Profile']]],
        ['Xóa alias', ['unalias'], [['text', 'Alias']]],
        ['Gắn tag', ['tag'], [['profile', 'Profile'], ['text', 'Tag (vd: corp)']]],
        ['Gỡ tag', ['untag'], [['profile', 'Profile'], ['text', 'Tag']]],
        ['Cho nghỉ auto-switch', ['disable'], [['profile', 'Profile']]],
        ['Cho đi làm lại', ['enable'], [['profile', 'Profile']]],
        ['Nhập profile từ thư mục khác', ['import'], [['text', 'Đường dẫn thư mục'], ['flag', 'Ghi đè profile trùng tên', '--force']]],
      ]],
      ['🤖 Tự động & quota', [
        ['Thứ tự ưu tiên auto-switch', ['auto', 'order'], [['text', 'Danh sách, vd: work,personal']]],
        ['Kiểm tra quota và đổi nếu cần', ['auto', 'check'], []],
        ['Cân bằng tải: sang profile kế tiếp', ['balance', 'next'], []],
        ['Mượn tạm profile', ['temp'], [['profile', 'Profile'], ['text', 'Thời gian (vd: 30m, 1h)', '1h']]],
        ['Trả profile đang mượn', ['untemp'], []],
        ['Trạng thái mượn tạm', ['temp'], []],
        ['Dọn profile hỏng', ['cleanup', '--force'], [], true],
      ]],
      ['📁 Dự án, nhánh Git & model', [
        ['Gắn profile cho thư mục', ['bind'], [['profile', 'Profile'], ['text', 'Đường dẫn thư mục dự án']]],
        ['Gỡ gắn thư mục', ['unbind'], [['text', 'Đường dẫn thư mục dự án']]],
        ['Thư mục đang gắn profile nào?', ['bind', 'get'], [['text', 'Đường dẫn thư mục dự án']]],
        ['Gắn profile theo nhánh Git', ['bind-branch'], [['text', 'Mẫu nhánh (vd: feat/*)'], ['profile', 'Profile'], ['text', 'Đường dẫn repo']]],
        ['Gỡ gắn nhánh Git', ['unbind-branch'], [['text', 'Mẫu nhánh (bỏ trống = tất cả)', '', true]]],
        ['Gán profile cho model', ['affinity'], [['choice', 'Model', ['opus', 'sonnet', 'haiku']], ['profile', 'Profile']]],
        ['Chuyển theo model', ['affinity', 'apply'], [['choice', 'Model', ['opus', 'sonnet', 'haiku']]]],
        ['Gỡ gán model', ['unaffinity'], [['choice', 'Model', ['opus', 'sonnet', 'haiku']]]],
      ]],
      ['🔔 Thông báo & ngân sách', [
        ['Thông báo desktop khi đổi profile', ['notify'], [['choice', 'Trạng thái', ['on', 'off']]]],
        ['Gỡ webhook', ['webhook', 'unset'], [['choice', 'Loại', ['telegram', 'discord', 'slack', 'generic']]]],
        ['Gửi thử webhook', ['webhook', 'test'], []],
        ['Đặt ngân sách tháng', ['budget', 'set'], [['profile', 'Profile'], ['number', 'Số tiền']]],
        ['Xóa ngân sách', ['budget', 'unset'], [['profile', 'Profile']]],
      ]],
      ['🔐 Sao lưu & đồng bộ', [
        ['Xuất bản sao lưu mã hóa', ['export'], [['text', 'Đường dẫn đầy đủ, vd: /home/ban/backup.enc'], ['password', 'Mật khẩu']]],
        ['Khôi phục từ file mã hóa', ['import-enc'], [['text', 'Đường dẫn đầy đủ tới file .enc'], ['password', 'Mật khẩu'], ['flag', 'Ghi đè profile trùng tên', '--force']]],
        ['Chọn nơi đồng bộ', ['sync', 'setup'], [['text', 'Đường dẫn đầy đủ, vd: /mnt/drive/claude-sync.enc']]],
        ['Trạng thái đồng bộ', ['sync'], []],
        ['Đẩy bản đồng bộ', ['sync', 'push'], [['password', 'Mật khẩu']]],
        ['Kéo bản đồng bộ', ['sync', 'pull'], [['password', 'Mật khẩu'], ['flag', 'Ghi đè profile trùng tên', '--force']]],
        ['Xuất cấu hình không chứa token', ['share'], [['text', 'Đường dẫn đầy đủ (bỏ trống = in ra)', '', true]]],
      ]],
      ['💻 Shell & công cụ', [
        ['Snippet cho shell prompt', ['prompt'], [['choice', 'Shell', ['starship', 'zsh', 'bash', 'tmux', 'powershell']]]],
        ['Script Tab completion', ['completion'], [['choice', 'Shell', ['bash', 'zsh', 'fish']]]],
        ['Lịch sử chuyển profile', ['history'], [['number', 'Số dòng', '20']]],
        ['Cập nhật plugin', ['upgrade'], []],
        ['Mở thư mục profile', ['folder'], []],
      ]],
    ];
    // one plain-language (and slightly cheeky) line per card, keyed by its title
    const QUIPS = {
      'Chuyển profile': 'Đổi tài khoản trong một nốt nhạc. Claude còn không biết mình vừa đổi chủ.',
      'Tạo profile từ tài khoản đang đăng nhập': 'Chụp ảnh tài khoản đang dùng rồi cất vào ngăn kéo. Lần sau lôi ra là xài.',
      'Lưu tài khoản hiện tại vào profile': 'Cập nhật profile bằng tài khoản đang đăng nhập, rất hợp sau khi vừa /login lại.',
      'Xóa profile': 'Chia tay dứt khoát: không thùng rác, không tái hợp.',
      'Đặt alias': 'Đặt biệt danh cho profile. Gõ "w" nhanh hơn "work-company-production-2" nhiều.',
      'Xóa alias': 'Biệt danh hết thời thì xóa. Profile gốc vẫn bình an vô sự.',
      'Gắn tag': 'Dán nhãn để phân nhóm, rồi cho auto-switch hay cân bằng tải chỉ chạy trong nhóm đó.',
      'Gỡ tag': 'Bóc nhãn ra. Profile không giận đâu.',
      'Cho nghỉ auto-switch': 'Cho profile nghỉ phép: auto-switch sẽ không gọi nó dậy, nhưng bạn vẫn đổi tay được.',
      'Cho đi làm lại': 'Hết phép rồi, quay lại vòng xoay auto-switch thôi.',
      'Nhập profile từ thư mục khác': 'Dọn nhà cho profile từ thư mục khác (hoặc máy cũ) về đây.',
      'Thứ tự ưu tiên auto-switch': 'Xếp hàng xem ai lên thay khi profile hiện tại hết quota. Có trước có sau.',
      'Kiểm tra quota và đổi nếu cần': 'Khỏi chờ tới prompt kế tiếp: bấm là kiểm tra, chạm ngưỡng là đổi ngay.',
      'Cân bằng tải: sang profile kế tiếp': 'Chuyền bóng cho đồng đội theo thuật toán cân bằng. Không ai phải gánh team.',
      'Mượn tạm profile': 'Mượn có hẹn giờ trả. Hết giờ tự trả, khỏi sợ mang tiếng quên.',
      'Trả profile đang mượn': 'Trả sớm cho giữ uy tín, quay về profile gốc ngay.',
      'Trạng thái mượn tạm': 'Đang mượn của ai, còn bao nhiêu phút nữa phải trả?',
      'Dọn profile hỏng': 'Đổ rác: xóa thật những profile hỏng. Không hoàn tác được, nên chạy "Cleanup (chỉ quét)" trước.',
      'Gắn profile cho thư mục': 'Mở dự án này là tự dùng đúng tài khoản. Hết cảnh side project ăn quota công ty.',
      'Gỡ gắn thư mục': 'Thư mục này được tự do, dùng tài khoản nào cũng được.',
      'Thư mục đang gắn profile nào?': 'Hỏi nhanh: thư mục này đang theo phe nào?',
      'Gắn profile theo nhánh Git': 'feat/* dùng tài khoản dev, work-* dùng tài khoản công ty. Checkout nhánh là đổi luôn.',
      'Gỡ gắn nhánh Git': 'Cởi trói cho nhánh. Bỏ trống ô mẫu là gỡ hết.',
      'Gán profile cho model': 'Opus ăn quota như tằm ăn dâu? Cho nó một tài khoản riêng.',
      'Chuyển theo model': 'Sắp dùng model nào thì nhảy sang tài khoản đã gán cho model đó.',
      'Gỡ gán model': 'Model này về lại làm việc chung với mọi người.',
      'Thông báo desktop khi đổi profile': 'Bật để màn hình báo mỗi lần đổi tài khoản. Mặc định tắt cho đỡ phiền.',
      'Gỡ webhook': 'Tắt tiếng một kênh báo, yên tĩnh trở lại.',
      'Gửi thử webhook': 'Bắn một tin thử cho chắc đường dây thông suốt.',
      'Đặt ngân sách tháng': 'Đặt trần chi tiêu cho từng profile. Ví tiền sẽ cảm ơn bạn.',
      'Xóa ngân sách': 'Gỡ trần chi tiêu. Sống thoáng nhưng tự chịu trách nhiệm.',
      'Xuất bản sao lưu mã hóa': 'Nhét hết profile vào két AES-256. Quên mật khẩu là chịu, không ai mở hộ được.',
      'Khôi phục từ file mã hóa': 'Mở két, mang profile về. Đúng mật khẩu mới mở được.',
      'Chọn nơi đồng bộ': 'Chọn chỗ đặt két (thư mục Dropbox, ổ mạng…) để máy khác cùng lấy được.',
      'Trạng thái đồng bộ': 'Lần đẩy, lần kéo gần nhất là khi nào.',
      'Đẩy bản đồng bộ': 'Gửi két lên chỗ đồng bộ. Mật khẩu đi qua stdin và không được lưu lại.',
      'Kéo bản đồng bộ': 'Mang két về máy này rồi mở ra.',
      'Xuất cấu hình không chứa token': 'Chia sẻ cấu hình cho đồng đội mà không kèm chìa khóa nhà.',
      'Snippet cho shell prompt': 'Cho prompt biết bạn đang ở tài khoản nào: Starship, zsh, bash, tmux, PowerShell đều có.',
      'Script Tab completion': 'Gõ nửa chữ, bấm Tab, phần còn lại để shell lo.',
      'Lịch sử chuyển profile': 'Nhật ký đổi tài khoản: ai, khi nào, vì sao.',
      'Cập nhật plugin': 'Kéo bản mới nhất về. Nhớ khởi động lại Claude Code để bản mới có hiệu lực.',
      'Mở thư mục profile': 'Mở thư mục chứa profile. Ngó thì được, đừng sửa tay.',
    };
    const QUICK = [['📋 Danh sách', ['list'], 'Điểm danh cả đội, kèm thanh quota.'], ['🟢 Đang dùng', ['current'], 'Mình đang là ai?'], ['📊 Usage', ['usage'], 'Quota 5h, 7d và từng model (lấy từ cache).'], ['🔄 Usage (làm mới)', ['usage', '--refresh'], 'Hỏi lại server số mới nhất. Đừng spam, server cũng biết mệt.'],
      ['📈 Dự báo', ['forecast'], 'Bói xem bao giờ cạn quota, dựa trên tốc độ tiêu thụ thật.'], ['⏱️ Cooldown', ['cooldown'], 'Đếm ngược tới lúc quota 5h hồi sức.'], ['🩺 Doctor', ['doctor'], 'Khám tổng quát: token, file cấu hình, kết nối.'], ['🧹 Cleanup (chỉ quét)', ['cleanup'], 'Tìm profile trùng hoặc hỏng. Chỉ nhìn, không xóa.'],
      ['📊 Thống kê', ['stats'], 'Đổi tay bao nhiêu lần, tự động bao nhiêu lần.'], ['🔤 Aliases', ['aliases'], 'Danh bạ biệt danh.'], ['🏷️ Tags', ['tags'], 'Ai thuộc nhóm nào.'], ['🚫 Đang nghỉ', ['disabled'], 'Danh sách profile đang nghỉ phép.'],
      ['🌿 Nhánh Git', ['branch-bindings'], 'Nhánh nào đi với tài khoản nào.'], ['🧠 Model', ['affinities'], 'Model nào đi với tài khoản nào.'], ['💰 Ngân sách', ['budget'], 'Trần chi tiêu hiện tại.'], ['🔔 Webhook', ['webhook'], 'Kênh báo nào đang bật.'],
      ['⚖️ Cân bằng tải', ['balance'], 'Đang chia việc theo kiểu nào.'], ['🤖 Auto', ['auto'], 'Auto-switch đang cấu hình ra sao.'], ['🛡️ Che email', ['mask'], 'Email đang được che hay đang lộ mặt.'], ['💻 Statusline', ['statusline'], 'Chuỗi trạng thái gọn để nhét vào prompt.'], ['ℹ️ Phiên bản', ['version'], 'Đang chạy bản nào.']];
    let featuresBuilt = false;
    let featureProfiles = '';

    function fieldHtml(id, f) {
      const kind = f[0], label = esc(f[1]);
      if (kind === 'flag') return '<label class="flag"><input type="checkbox" id="' + id + '"> ' + label + '</label>';
      if (kind === 'profile') return '<select id="' + id + '" class="form-control feat-profile" aria-label="' + label + '"></select>';
      if (kind === 'choice') return '<select id="' + id + '" class="form-control" aria-label="' + label + '">' + f[2].map(o => '<option>' + esc(o) + '</option>').join('') + '</select>';
      const type = kind === 'password' ? 'password' : kind === 'number' ? 'number' : 'text';
      return '<input id="' + id + '" type="' + type + '" class="form-control" placeholder="' + label + '" aria-label="' + label + '" value="' + esc(f[2] || '') + '"' + (type === 'password' ? ' autocomplete="off"' : '') + '>';
    }

    function renderFeatures() {
      if (!featuresBuilt) {
        featuresBuilt = true;
        document.getElementById('quick-row').innerHTML = QUICK.map((q, i) => '<button class="btn btn-secondary btn-sm" title="' + esc(q[2]) + '" onclick="runQuick(' + i + ')">' + esc(q[0]) + '</button>').join('');
        document.getElementById('features-container').innerHTML = FEATURES.map((g, gi) =>
          '<div class="feat-group"><h3>' + esc(g[0]) + '</h3><div class="feat-grid">' + g[1].map((c, ci) => {
            const id = 'f' + gi + '-' + ci;
            return '<div class="feat-card"><div class="ft">' + esc(c[0]) + '</div><div class="fd">' + esc(QUIPS[c[0]] || '') + '</div><div class="fc">/profile ' + esc(c[1].join(' ')) + '</div>' +
              c[2].map((f, fi) => fieldHtml(id + '-' + fi, f)).join('') +
              '<div><button class="btn btn-sm' + (c[3] ? ' btn-danger' : '') + '" onclick="runFeature(' + gi + ',' + ci + ')">▶ Chạy</button></div></div>';
          }).join('') + '</div></div>'
        ).join('');
      }
      // refill profile pickers only when the list changes, so a choice in progress survives the 5s poll
      const names = (appData.profiles || []).map(p => p.name);
      if (names.join('|') === featureProfiles) return;
      featureProfiles = names.join('|');
      document.querySelectorAll('.feat-profile').forEach(sel => {
        const keep = sel.value;
        sel.innerHTML = names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
        if (names.includes(keep)) sel.value = keep;
        else if (appData.current && names.includes(appData.current)) sel.value = appData.current;
      });
    }

    async function runCli(args, password) {
      const out = document.getElementById('cli-output');
      out.classList.remove('err');
      out.textContent = '⏳ /profile ' + args.join(' ') + ' ...';
      out.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      try {
        const res = await api('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cli', args, password: password || '' })
        });
        const data = await res.json();
        out.textContent = '$ /profile ' + args.join(' ') + String.fromCharCode(10) + (data.output || data.error || '(không có output)');
        if (!data.ok) out.classList.add('err');
        loadData();
      } catch (err) {
        out.textContent = 'Lỗi: ' + err.message;
        out.classList.add('err');
      }
    }

    function runQuick(i) { runCli(QUICK[i][1]); }

    function runFeature(gi, ci) {
      const c = FEATURES[gi][1][ci];
      const args = c[1].slice();
      let password = '';
      for (let fi = 0; fi < c[2].length; fi++) {
        const f = c[2][fi];
        const el = document.getElementById('f' + gi + '-' + ci + '-' + fi);
        if (f[0] === 'flag') { if (el.checked) args.push(f[2]); continue; }
        const v = el.value.trim();
        if (f[0] === 'password') { password = el.value; if (!password) return showToast('Cần nhập ' + f[1]); continue; }
        if (!v) { if (f[3]) continue; return showToast('Cần nhập: ' + f[1]); }
        args.push(v);
      }
      if (c[3] && !confirm('Chạy "/profile ' + args.join(' ') + '"? Thao tác này không hoàn tác được.')) return;
      runCli(args, password);
      c[2].forEach((f, fi) => { if (f[0] === 'password') document.getElementById('f' + gi + '-' + ci + '-' + fi).value = ''; });
    }

    let settingsKey = '';
    function renderSettings() {
      // the 5s poll must not wipe what the user is typing: redraw only when the stored settings change
      const key = JSON.stringify([appData.auto, appData.balance, appData.webhook, appData.masking, (appData.profiles || []).map(p => p.name)]);
      if (key === settingsKey) return;
      settingsKey = key;
      document.getElementById('cfg-auto-enabled').checked = Boolean(appData.auto.enabled);
      document.getElementById('cfg-auto-threshold').value = appData.auto.threshold || 95;
      document.getElementById('cfg-auto-safeguard').value = appData.auto.safeguardThreshold || 85;
      document.getElementById('cfg-auto-return').checked = Boolean(appData.auto.autoReturn);
      document.getElementById('cfg-auto-pool').value = appData.auto.pool || 'all';

      const primSel = document.getElementById('cfg-auto-primary');
      primSel.innerHTML = '<option value="">(Tự động)</option>';
      appData.profiles.forEach(p => {
        primSel.innerHTML += \`<option value="\${esc(p.name)}" \${appData.auto.primaryProfile === p.name ? 'selected' : ''}>\${esc(p.name)}</option>\`;
      });

      document.getElementById('cfg-balance-enabled').checked = Boolean(appData.balance.enabled);
      document.getElementById('cfg-balance-mode').value = appData.balance.mode || 'least-used';
      document.getElementById('cfg-balance-pool').value = appData.balance.pool || 'all';

      ['telegram', 'discord', 'slack', 'generic'].forEach(k => {
        const el = document.getElementById('cfg-webhook-' + k);
        el.value = '';
        el.placeholder = appData.webhook[k] ? '✅ Đã đặt (' + appData.webhook[k] + '), để trống = giữ nguyên' : 'Chưa đặt';
      });

      document.getElementById('cfg-masking').checked = Boolean(appData.masking);
    }

    async function doSwap(name) {
      try {
        const res = await api('/api/action', {
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
        await api('/api/action', {
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
        await api('/api/action', {
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
          telegram: document.getElementById('cfg-webhook-telegram').value.trim(),
          discord: document.getElementById('cfg-webhook-discord').value.trim(),
          slack: document.getElementById('cfg-webhook-slack').value.trim(),
          generic: document.getElementById('cfg-webhook-generic').value.trim()
        },
        masking: document.getElementById('cfg-masking').checked
      };

      try {
        const res = await api('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
          showToast('✓ Đã lưu toàn bộ cấu hình thành công!');
          settingsKey = ''; // redraw: typed webhook URLs leave the screen, the masked placeholder replaces them
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
        const res = await api('/api/action', {
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
        const res = await api('/api/action', {
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
      api('/api/action', {
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
  const token = crypto.randomBytes(24).toString('hex')
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${port}`)

    // DNS rebinding: a foreign site resolving its own name to 127.0.0.1 still sends its own Host
    const hostname = (req.headers.host || '').replace(/:\d+$/, '')
    if (!LOCAL_HOSTNAMES.has(hostname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderDashboardHtml())
      return
    }

    if (url.pathname.startsWith('/api/') && !hasToken(req, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing or invalid dashboard token' }))
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
      // CSRF: a cross-site form/fetch cannot send application/json without a preflight we never answer
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Content-Type must be application/json' }))
        return
      }
      let bodyStr = ''
      req.on('data', chunk => {
        bodyStr += chunk
        if (bodyStr.length > MAX_BODY) req.destroy()
      })
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
              if (body.auto) {
                // the form uses short field names; keep keys it does not edit (order, ...)
                const { safeguard, primary, pool, ...rest } = body.auto
                saveAutoSwitchConfig(home, {
                  ...loadAutoSwitchConfig(home),
                  ...rest,
                  safeguardThreshold: safeguard || null,
                  primaryProfile: primary || null,
                  pool: pool && pool !== 'all' ? pool : null,
                })
              }
              if (body.balance) saveBalanceConfig(home, body.balance)
              if (body.webhook) {
                // only typed-in URLs are sent; an empty field keeps the stored (never displayed) value
                const urls = Object.entries(body.webhook).filter(([k, v]) => WEBHOOK_TYPES.includes(k) && typeof v === 'string' && /^https?:\/\//.test(v))
                if (urls.length) saveWebhookConfig(home, Object.fromEntries(urls))
              }
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
            case 'cli': {
              const r = await runSwapCli(home, body.args, typeof body.password === 'string' ? body.password : '')
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: r.code === 0, output: r.output }))
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
        server.listen(port, HOST, () => {
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

  atomicWrite(pf, JSON.stringify({ pid: process.pid, port, token }))
  const targetUrl = `http://${HOST}:${port}`

  if (shouldOpen) {
    openBrowser(dashboardUrl({ port, token }))
  }

  return {
    server,
    port,
    token,
    url: targetUrl,
    close: () => {
      server.close()
      try {
        if (fs.existsSync(pf)) fs.unlinkSync(pf)
      } catch {}
    },
  }
}
