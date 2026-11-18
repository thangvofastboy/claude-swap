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
  profileEmail,
  profileNote,
  getProfileTags,
  loadDisabledProfiles,
  disableProfile,
  enableProfile,
  addTokenProfile,
  loadAliases,
  loadBranchBindings,
  listModelAffinities,
  loadLanguage,
  setLanguage,
  loadAutoSwitchConfig,
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
  weeklyPace,
  recoveredProfiles,
  settingsList,
  setSetting,
  featureItems,
  projectUsageTotals,
} from './swap.js'

const HOST = '127.0.0.1'
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_BODY = 1024 * 1024
const WEBHOOK_TYPES = ['telegram', 'discord', 'slack', 'generic']
const SWAP_JS = fileURLToPath(new URL('./swap.js', import.meta.url))
// subcommands the "All features" tab may run; interactive ones (run, pick, web, login) stay CLI-only
const WEB_CLI = new Set([
  'list', 'current', 'usage', 'swap', 'new', 'save', 'rename', 'delete', 'import', 'folder', 'version', 'upgrade',
  'dedupe', 'note', 'restore', 'export-config', 'verify',
  'alias', 'unalias', 'aliases', 'tag', 'untag', 'tags', 'disable', 'enable', 'disabled',
  'auto', 'balance', 'forecast', 'cooldown', 'doctor', 'cleanup', 'temp', 'untemp',
  'bind', 'unbind', 'bind-branch', 'unbind-branch', 'branch-bindings',
  'affinity', 'unaffinity', 'affinities', 'notify', 'budget', 'webhook', 'mask', 'share',
  'export', 'import-enc', 'sync', 'history', 'undo', 'stats', 'statusline', 'prompt', 'completion', 'lang', 'repair', 'schedule', 'unschedule', 'settings',
  'codex', 'agy', 'opencode',
])

// Runs `node swap.js <args>` like the /profile hook does; a password goes on stdin, never argv
export function runSwapCli(home, args, password = '') {
  if (!Array.isArray(args) || args.length === 0 || args.length > 12 || !WEB_CLI.has(args[0])) {
    return Promise.resolve({ code: 1, output: `Lệnh không được phép: ${String(args?.[0])}` })
  }
  if (args.some(a => typeof a !== 'string' || a.length > 2048 || a.startsWith('--password'))) {
    return Promise.resolve({ code: 1, output: 'Tham số không hợp lệ.' })
  }
  // a webhook URL is a secret: it would sit on the child's argv, where `ps` shows it
  if (args[0] === 'webhook' && args.filter(a => a !== '--no-color')[1] === 'set') return Promise.resolve({ code: 1, output: 'Lệnh không được phép: webhook set' })
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
    // `repair` runs `claude -p` per profile (up to 2 min each): killing it mid-way could strand a renewed token
    const timeout = args[0] === 'repair' ? 30 * 60000 : 180000
    const child = execFile(process.execPath, argv, { env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout}${stderr}`.trim() })
    })
    child.stdin.on('error', () => {}) // EPIPE when the child exits before reading stdin
    child.stdin.end(password ? `${password}\n` : '')
  })
}

// The OS file/folder dialog on the machine the dashboard runs on (the browser cannot hand back a real path).
// Fixed argv only: nothing from the request reaches the command. Resolves '' on cancel.
const PICKERS = {
  linux: {
    dir: [['zenity', ['--file-selection', '--directory']], ['kdialog', ['--getexistingdirectory', os.homedir()]]],
    file: [['zenity', ['--file-selection']], ['kdialog', ['--getopenfilename', os.homedir()]]],
    save: [['zenity', ['--file-selection', '--save', '--confirm-overwrite']], ['kdialog', ['--getsavefilename', os.homedir()]]],
  },
  darwin: {
    dir: [['osascript', ['-e', 'POSIX path of (choose folder)']]],
    file: [['osascript', ['-e', 'POSIX path of (choose file)']]],
    save: [['osascript', ['-e', 'POSIX path of (choose file name)']]],
  },
  win32: Object.fromEntries(Object.entries({
    dir: '$d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }',
    file: '$d = New-Object System.Windows.Forms.OpenFileDialog; if ($d.ShowDialog() -eq "OK") { $d.FileName }',
    save: '$d = New-Object System.Windows.Forms.SaveFileDialog; if ($d.ShowDialog() -eq "OK") { $d.FileName }',
  }).map(([k, ps]) => [k, [['powershell', ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; ' + ps]]]])),
}

export function pickPath(mode, platform = process.platform) {
  const tries = PICKERS[platform]?.[mode] ?? PICKERS.linux[mode]
  if (!tries) return Promise.reject(new Error(`Kiểu chọn không hợp lệ: ${mode}`))
  return new Promise((resolve, reject) => {
    const next = i => {
      if (i >= tries.length) return reject(new Error('Không mở được hộp thoại chọn file (cần zenity hoặc kdialog trên Linux). Hãy gõ đường dẫn.'))
      execFile(tries[i][0], tries[i][1], { timeout: 10 * 60000, windowsHide: false }, (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') return next(i + 1)
        // cancel exits non-zero and silent; a dialog that could not open (no display) says why on stderr
        const why = String(stderr).trim().split('\n').filter(l => !/Gtk-WARNING|^\s*$/.test(l))[0]
        if (err && why && !err.killed) return reject(new Error(`Không mở được hộp thoại chọn: ${why}`))
        resolve(err ? '' : String(stdout).trim())
      })
    }
    next(0)
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
    // pid 0 or a negative one would signal a whole process group in stopWebDashboard
    if (!Number.isInteger(state.pid) || state.pid <= 0) throw new Error('stale')
    // a pid reused by some other process (after a reboot): Linux names the command, elsewhere compare with boot time
    // (Linux skips the uptime test: WSL/VM uptime stops while paused, which would make a live dashboard look stale)
    if (process.platform === 'linux') {
      // our own `swap.js web --server` child, not any process whose command line happens to contain "web"
      const cmd = fs.readFileSync(`/proc/${state.pid}/cmdline`, 'utf-8').split('\0')
      if (!cmd.includes('--server') || !cmd.some(a => a.endsWith('swap.js'))) throw new Error('stale')
    } else if (state.started && state.started < Date.now() - os.uptime() * 1000) throw new Error('stale')
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
      note: profileNote(home, name) || null,
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
    weekly: Object.fromEntries(profiles.map(n => [n, weeklyPace(home, n, cache, usageHistory)])),
    recovered: recoveredProfiles(home, cache, cur),
    projectUsage: projectUsageTotals(home, 7),
    settingsList: settingsList(home),
    featureItems: featureItems(home),
  }
}

export function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='cs-g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%233b82f6'/%3E%3Cstop offset='1' stop-color='%230b2a6b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='15' fill='url(%23cs-g)'/%3E%3Cpath d='M14 24h32M39 17l7 7-7 7M50 40H18M25 33l-7 7 7 7' fill='none' stroke='%23fff' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='52' cy='11' r='5' fill='%23D97757'/%3E%3C/svg%3E">
  <meta name="theme-color" content="#02050d">
  <title>claude-swap Dashboard — Quản lý Đa Tài Khoản Claude Code</title>
  <style>
    :root {
      color-scheme: dark;
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
      --bg: #02050d;
      --sidebar: #040914;
      --card-bg: #071022;
      --card-border: #11213f;
      --surface-2: #0b1a35;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --accent-2: #3b82f6;
      --accent-soft: #6ea8ff;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #e6ebf4;
      --text-muted: #8fa3c4;
      --text-dim: #5a7099;
      --border: #1d3560;
      --code-bg: #132a50;
      --radius: 12px;
      --focus: 0 0 0 3px rgba(110, 168, 255, 0.45);
      --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767; --grid: #142542;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-text-size-adjust: 100%; font-size: 17px; }
    body { font-family: var(--font); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; display: grid; grid-template-columns: 232px minmax(0, 1fr); }
    button, input, select, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: none; box-shadow: var(--focus); }
    ::selection { background: rgba(110, 168, 255, 0.35); }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: #213a66; border-radius: 999px; }
    ::-webkit-scrollbar-thumb:hover { background: #2c4c85; }
    .ic { width: 1.1em; height: 1.1em; vertical-align: -0.2em; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    /* Sidebar */
    .sidebar { background: var(--sidebar); border-right: 1px solid var(--card-border); display: flex; flex-direction: column; gap: 6px; padding: 16px 12px; overflow-y: auto; min-height: 0; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 14px; font-weight: 700; font-size: 1.02rem; letter-spacing: -0.01em; color: #fff; }
    .brand-logo { width: 34px; height: 34px; flex: none; border-radius: 9px; box-shadow: 0 6px 18px rgba(37, 99, 235, 0.35); }
    .brand-text { display: flex; flex-direction: column; line-height: 1.15; }
    .brand-badge { color: var(--text-dim); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
    .nav-label { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-dim); font-weight: 700; padding: 10px 10px 4px; }
    nav { display: flex; flex-direction: column; gap: 2px; }
    .tab-btn { background: transparent; border: none; color: var(--text-muted); padding: 9px 12px; white-space: nowrap; border-radius: 9px; font-size: 0.9rem; font-weight: 500; transition: color 0.2s var(--ease), background-color 0.2s var(--ease); display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; }
    .tab-btn .ic { width: 1.15em; height: 1.15em; }
    .tab-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.05); }
    .tab-btn.active { color: #fff; background: rgba(37, 99, 235, 0.16); box-shadow: inset 3px 0 0 var(--accent-soft); }
    .tab-btn.active .ic { color: var(--accent-soft); }
    .side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding-top: 12px; }
    .side-current { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 11px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
    .side-current .lbl { font-size: 0.68rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
    .side-current .val { display: flex; align-items: center; gap: 8px; font-weight: 700; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .side-meta { font-size: 0.72rem; color: var(--text-dim); padding: 0 6px; }

    /* App shell */
    .app { display: flex; flex-direction: column; min-width: 0; height: 100vh; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 24px; border-bottom: 1px solid var(--card-border); background: rgba(3, 8, 18, 0.8); }
    .page-title { font-size: 1.12rem; font-weight: 700; color: #fff; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
    .page-sub { font-size: 0.8rem; color: var(--text-muted); }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    main { flex: 1; min-height: 0; padding: 18px 24px; overflow: hidden; }
    .tab-content { display: none; height: 100%; min-height: 0; }
    .tab-content.active { display: flex; flex-direction: column; gap: 16px; animation: fadeIn 0.25s var(--ease); }
    .scroll-y { overflow-y: auto; min-height: 0; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

    /* Buttons */
    .btn { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; border: 1px solid transparent; padding: 7px 14px; border-radius: 9px; font-size: 0.86rem; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; white-space: nowrap; transition: filter 0.2s var(--ease), transform 0.1s var(--ease), background-color 0.2s var(--ease), border-color 0.2s var(--ease); }
    .btn:active { transform: scale(0.97); }
    .btn:hover { filter: brightness(1.12); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; filter: none; }
    .btn-secondary { background: var(--surface-2); color: var(--text); border-color: var(--border); }
    .btn-secondary:hover { background: #1a3463; border-color: #34548a; filter: none; }
    .btn-sm { padding: 4px 10px; font-size: 0.8rem; min-height: 30px; }
    .btn-icon { padding: 0; width: 30px; min-height: 30px; }
    .btn-danger { background: rgba(239, 68, 68, 0.12); color: #fca5a5; border-color: rgba(239, 68, 68, 0.35); }
    .btn-danger:hover { background: var(--danger); color: #fff; filter: none; }
    .btn-success { background: rgba(16, 185, 129, 0.14); color: #6ee7b7; border-color: rgba(16, 185, 129, 0.4); }
    .btn-success:hover { background: var(--success); color: #04261b; filter: none; }

    /* KPI tiles */
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; flex: none; }
    .stat-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius); padding: 14px 16px; display: flex; align-items: center; gap: 12px; min-width: 0; }
    .stat-ic { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; flex: none; font-size: 1.1rem; }
    .stat-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .stat-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
    .stat-value { font-size: 1.2rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .c-blue { background: rgba(57, 135, 229, 0.15); color: #7cb4f5; }
    .c-violet { background: rgba(139, 92, 246, 0.16); color: #b9a1fb; }
    .c-green { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; }
    .c-amber { background: rgba(245, 158, 11, 0.15); color: #fcd34d; }
    .c-pink { background: rgba(213, 81, 129, 0.15); color: #f49ac0; }
    .pulse-dot.idle { background: var(--muted, #64748b); box-shadow: none; animation: none; }
    .pc-note { font-size: 12px; opacity: .8; margin: 2px 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [hidden] { display: none !important; }
    .feat-search { width: 100%; margin-bottom: 14px; }
    .feat-empty { opacity: .7; font-size: 13px; padding: 12px 0; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18), 0 0 10px var(--success); animation: pulse 2s infinite; flex: none; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.45; } 100% { opacity: 1; } }

    /* Profile cards */
    .section-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex: none; }
    .section-bar h2 { font-size: 0.95rem; color: #fff; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .profiles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 12px; align-content: start; flex: 1; overflow-y: auto; min-height: 0; padding: 2px; }
    .profile-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius); padding: 14px; display: flex; flex-direction: column; gap: 10px; position: relative; transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease); animation: cardIn 0.3s var(--ease) both; }
    .profile-card:hover { border-color: rgba(110, 168, 255, 0.45); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
    @keyframes cardIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .profile-card.is-active { border-color: rgba(110, 168, 255, 0.7); background: linear-gradient(180deg, rgba(37, 99, 235, 0.13) 0%, rgba(7, 16, 34, 0) 70%), var(--card-bg); box-shadow: 0 0 0 1px rgba(110, 168, 255, 0.2); }
    .profile-card.is-disabled { opacity: 0.72; }
    .pc-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .avatar { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-weight: 700; color: #fff; flex: none; text-transform: uppercase; }
    .pc-id { min-width: 0; flex: 1; }
    .profile-name { font-size: 0.98rem; font-weight: 700; color: #fff; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .profile-name .alias { color: var(--text-dim); font-size: 0.76rem; font-weight: 500; }
    .profile-email { font-size: 0.78rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { font-size: 0.68rem; padding: 2px 8px; border-radius: 999px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; flex: none; border: 1px solid; }
    .badge-green { background: rgba(16, 185, 129, 0.12); color: #6ee7b7; border-color: rgba(16, 185, 129, 0.35); }
    .badge-muted { background: rgba(148, 163, 184, 0.08); color: var(--text-muted); border-color: var(--border); }
    .tags { display: flex; gap: 5px; flex-wrap: wrap; }
    .tag-pill { background: rgba(139, 92, 246, 0.1); color: #c4b5fd; font-size: 0.7rem; padding: 1px 8px; border-radius: 999px; border: 1px solid rgba(139, 92, 246, 0.28); display: inline-flex; align-items: center; gap: 4px; }
    .quota-box { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; background: rgba(0, 0, 0, 0.35); border: 1px solid #142542; border-radius: 10px; padding: 10px 12px; }
    .quota-item { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .quota-empty { grid-column: 1 / -1; color: var(--text-dim); font-size: 0.8rem; }
    .quota-meta { display: flex; justify-content: space-between; font-size: 0.74rem; color: var(--text-muted); }
    .quota-val { font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
    .progress-bar-bg { background: #132648; height: 6px; border-radius: 999px; overflow: hidden; width: 100%; }
    .progress-bar-fill { height: 100%; border-radius: 999px; transition: width 0.6s var(--ease), background-color 0.4s var(--ease); }
    .fill-green { background: linear-gradient(90deg, #059669, #34d399); }
    .fill-yellow { background: linear-gradient(90deg, #d97706, #fbbf24); }
    .fill-orange { background: linear-gradient(90deg, #ea580c, #fb923c); }
    .fill-red { background: linear-gradient(90deg, #dc2626, #f87171); }
    .cooldown-text { grid-column: 1 / -1; font-size: 0.76rem; color: var(--accent-soft); display: flex; align-items: center; gap: 5px; }
    .profile-actions { display: flex; gap: 6px; align-items: center; margin-top: auto; }
    .profile-actions .spacer { flex: 1; }
    .in-use { font-size: 0.8rem; color: #34d399; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; }

    /* Cards (settings, stats, features) */
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius); padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; }
    .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .card-title { font-size: 0.95rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; letter-spacing: -0.01em; }
    .card-title .stat-ic { width: 28px; height: 28px; border-radius: 8px; font-size: 0.9rem; }
    .card-desc { font-size: 0.78rem; color: var(--text-muted); }
    .card-body { overflow-y: auto; min-height: 0; }
    .settings-layout { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-content: start; }
    .settings-layout .span-2 { grid-column: span 2; }
    .settings-layout .tall .card-body { max-height: 420px; }
    .form-stack { display: flex; flex-direction: column; gap: 12px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    .form-label { font-size: 0.8rem; font-weight: 600; color: #cfd8e6; display: flex; align-items: center; gap: 6px; }
    .form-hint { font-size: 0.74rem; color: var(--text-dim); }
    .form-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .form-control { background: #050c1b; border: 1px solid var(--border); color: #fff; padding: 7px 10px; border-radius: 8px; font-size: 0.86rem; min-height: 34px; width: 100%; transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease); }
    .form-control:hover { border-color: #34548a; }
    .form-control:focus { outline: none; border-color: var(--accent-soft); box-shadow: var(--focus); }
    .form-switch { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 0.86rem; }
    .form-switch input { display: none; }
    .switch-slider { width: 38px; height: 22px; background: #233d6b; border-radius: 11px; position: relative; flex: none; transition: background-color 0.2s var(--ease); }
    .switch-slider::after { content: ''; position: absolute; width: 16px; height: 16px; border-radius: 50%; background: #fff; top: 3px; left: 3px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); transition: transform 0.25s var(--ease); }
    input:checked + .switch-slider { background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    input:checked + .switch-slider::after { transform: translateX(16px); }
    .setting-row, .fi-row { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 7px 8px; border-radius: 8px; transition: background-color 0.2s var(--ease); }
    .setting-row + .setting-row { border-top: 1px solid #142542; }
    .setting-row:hover, .fi-row:hover { background: rgba(255, 255, 255, 0.03); }
    .setting-row .ft { font-weight: 600; color: #fff; font-family: var(--mono); font-size: 0.82rem; }
    .setting-row .fd, .fi-group .fd { font-size: 0.74rem; color: var(--text-muted); }
    .setting-row .form-control { min-width: 150px; }
    .all-settings-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; }
    .all-settings-grid .setting-row + .setting-row { border-top: none; }
    .all-settings-grid .setting-row { border-bottom: 1px solid #142542; border-radius: 0; }
    .fi-group { margin-bottom: 10px; }
    .fi-group > .ft { font-weight: 600; color: var(--accent-soft); font-size: 0.82rem; margin-bottom: 2px; }
    .fi-row { font-size: 0.82rem; }

    /* Docs */
    .docs-search input { width: 100%; max-width: 520px; padding: 9px 14px; border-radius: 10px; background: #050c1b; border: 1px solid var(--border); color: #fff; font-size: 0.9rem; }
    .docs-search input:focus { outline: none; border-color: var(--accent-soft); box-shadow: var(--focus); }
    .docs-grid { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 18px; flex: 1; min-height: 0; }
    .docs-nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
    .docs-nav-link { color: var(--text-muted); padding: 7px 12px; border-radius: 8px; text-decoration: none; font-size: 0.86rem; border-left: 2px solid transparent; transition: color 0.2s var(--ease), background-color 0.2s var(--ease), border-color 0.2s var(--ease); }
    .docs-nav-link:hover, .docs-nav-link.active { color: #fff; background: rgba(110, 168, 255, 0.1); border-left-color: var(--accent-soft); }
    .docs-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; overflow-y: auto; min-height: 0; align-content: start; }
    .docs-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius); padding: 18px; }
    .docs-card.wide { grid-column: 1 / -1; }
    .docs-card h2 { color: var(--accent-soft); margin-bottom: 10px; font-size: 1rem; display: flex; align-items: center; gap: 8px; }
    .docs-card p { font-size: 0.86rem; line-height: 1.6; color: #cbd5e1; margin-bottom: 10px; }
    .cmd-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    .cmd-table th, .cmd-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #142542; }
    .cmd-table th { background: #071228; color: var(--text-muted); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; position: sticky; top: 0; z-index: 1; }
    .cmd-table tr:hover td { background: rgba(255, 255, 255, 0.025); }
    .cmd-code { background: rgba(56, 189, 248, 0.1); color: #7dd3fc; padding: 2px 6px; border-radius: 6px; font-family: var(--mono); font-size: 0.8rem; }

    /* Modal */
    .modal-backdrop { position: fixed; inset: 0; background: rgba(3, 6, 14, 0.72); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); display: none; justify-content: center; align-items: center; z-index: 200; }
    .modal-backdrop.show { display: flex; }
    .modal-box { background: var(--card-bg); border: 1px solid var(--border); border-radius: 16px; width: 90%; max-width: 460px; padding: 22px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6); }
    .modal-header { display: flex; justify-content: space-between; align-items: center; }
    .modal-title { font-size: 1.05rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }
    .modal-close { background: none; border: none; color: var(--text-muted); font-size: 1.4rem; width: 34px; height: 34px; border-radius: 8px; }
    .modal-close:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }

    .info-btn { background: none; border: none; color: var(--text-dim); width: 18px; height: 18px; padding: 0; border-radius: 50%; display: inline-grid; place-items: center; vertical-align: middle; flex: none; font-size: 0.8rem; transition: color 0.15s var(--ease), background-color 0.15s var(--ease); }
    .info-btn:hover, .info-btn[aria-expanded="true"] { color: var(--accent-soft); background: rgba(110, 168, 255, 0.14); }
    .help-pop { position: fixed; z-index: 300; max-width: 320px; background: #08132a; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; font-size: 0.82rem; line-height: 1.55; color: #cbd5e1; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55); display: none; }
    .help-pop.show { display: block; animation: fadeIn 0.15s var(--ease); }
    .help-pop b { display: block; color: #fff; font-family: var(--mono); font-size: 0.8rem; margin-bottom: 4px; }
    .path-row { display: flex; gap: 6px; }
    .path-row .form-control { flex: 1; min-width: 0; }

    /* Toast */
    #toast { position: fixed; bottom: 20px; right: 20px; background: var(--surface-2); color: #fff; border: 1px solid var(--border); border-left: 3px solid var(--accent-soft); padding: 11px 18px; border-radius: 10px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55); z-index: 999; opacity: 0; visibility: hidden; transform: translateY(16px); transition: opacity 0.25s var(--ease), transform 0.25s var(--ease), visibility 0s linear 0.25s; }
    #toast.show { opacity: 1; visibility: visible; transform: none; transition: opacity 0.25s var(--ease), transform 0.25s var(--ease), visibility 0s; }

    /* Stats & charts (categorical slots validated against #111827) */
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }
    .stats-layout { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-content: start; }
    .stats-layout .span-2 { grid-column: span 2; }
    .stats-layout .span-3 { grid-column: 1 / -1; }
    .chart-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius); padding: 16px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .chart-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .chart-head .form-control { width: auto; }
    .chart-title { font-size: 0.95rem; font-weight: 700; color: #fff; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
    .chart-sub { font-size: 0.76rem; color: var(--text-muted); }
    .chart-wrap { position: relative; width: 100%; }
    .chart-wrap svg { width: 100%; height: auto; display: block; }
    .chart-wrap text { fill: var(--text-muted); font-size: 13px; }
    #forecast-table td, #history-table td:nth-child(-n+4), #cmd-tbody td:first-child { white-space: nowrap; }
    .legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.78rem; color: #cbd5e1; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .viz-tip { position: absolute; pointer-events: none; background: #050c1b; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; font-size: 0.8rem; color: #fff; display: none; white-space: nowrap; z-index: 5; box-shadow: 0 8px 22px rgba(0, 0, 0, 0.55); }
    .viz-tip i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 6px; }
    .draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1.1s var(--ease) forwards; }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    .fade-in { animation: fadeOnly 1.1s var(--ease) both; }
    @keyframes fadeOnly { from { opacity: 0; } }
    .grow { transform-box: fill-box; transform-origin: 50% 100%; animation: growY 0.6s var(--ease) both; }
    @keyframes growY { from { transform: scaleY(0); } }
    @keyframes growX { from { width: 0; } }
    .hover-dot { transition: cx 0.12s var(--ease), cy 0.12s var(--ease); }
    .hbar-row { display: grid; grid-template-columns: 20px minmax(0, 110px) 1fr 34px; gap: 10px; align-items: center; font-size: 0.84rem; padding: 6px 4px; border-radius: 8px; transition: background-color 0.15s var(--ease); }
    .hbar-row:hover { background: rgba(255, 255, 255, 0.03); }
    .hbar-rank { color: var(--text-dim); font-variant-numeric: tabular-nums; font-size: 0.76rem; }
    .hbar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e5e7eb; display: flex; align-items: center; gap: 7px; }
    .hbar-name i, .sw { width: 8px; height: 8px; border-radius: 3px; flex: none; display: inline-block; }
    .hbar-track, .mini-bar { height: 8px; background: #132648; border-radius: 999px; overflow: hidden; }
    .hbar-track i, .mini-bar i { display: block; height: 100%; border-radius: 999px; animation: growX 0.8s var(--ease) both; }
    .hbar-val { text-align: right; color: #fff; font-weight: 600; font-variant-numeric: tabular-nums; }
    .mini { display: flex; align-items: center; gap: 8px; min-width: 120px; }
    .mini .mini-bar { flex: 1; min-width: 56px; height: 6px; }
    .mini b { font-weight: 600; color: #fff; min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
    .pill { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; font-size: 0.74rem; font-weight: 600; border: 1px solid; white-space: nowrap; }
    .pill-red { color: #fca5a5; background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.35); }
    .pill-orange { color: #fdba74; background: rgba(249, 115, 22, 0.12); border-color: rgba(249, 115, 22, 0.35); }
    .pill-yellow { color: #fcd34d; background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.35); }
    .pill-green { color: #6ee7b7; background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.35); }
    .pill-blue { color: #93c5fd; background: rgba(57, 135, 229, 0.12); border-color: rgba(57, 135, 229, 0.35); }
    .pill-violet { color: #c4b5fd; background: rgba(139, 92, 246, 0.12); border-color: rgba(139, 92, 246, 0.35); }
    .muted { color: var(--text-muted); }
    .cmd-table td { font-variant-numeric: tabular-nums; }
    .cmd-table tbody tr { transition: background-color 0.15s var(--ease); }
    .empty-state { color: var(--text-dim); font-size: 0.86rem; padding: 22px 0; text-align: center; }
    .tbl-wrap { overflow: auto; max-height: 280px; }

    /* All features */
    .feat-layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; flex: 1; min-height: 0; }
    .feat-main { overflow-y: auto; min-height: 0; padding-right: 4px; }
    .feat-side { display: flex; flex-direction: column; min-height: 0; }
    .feat-side .card { flex: 1; }
    .feat-intro { font-size: 0.8rem; color: var(--text-muted); }
    .feat-out { background: #020611; border: 1px solid var(--border); border-radius: 10px; padding: 12px; font-family: var(--mono); font-size: 0.78rem; color: #e5e7eb; white-space: pre-wrap; flex: 1; min-height: 120px; overflow: auto; }
    .feat-out.err { border-color: var(--danger); }
    .quick-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .feat-group { margin-bottom: 18px; }
    .feat-group h3 { font-size: 0.9rem; color: #fff; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
    .feat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
    .feat-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 11px; padding: 12px; display: flex; flex-direction: column; gap: 7px; transition: border-color 0.2s var(--ease); }
    .feat-card:hover { border-color: rgba(110, 168, 255, 0.4); }
    .feat-card .ft { font-weight: 600; color: #fff; font-size: 0.86rem; }
    .feat-card .fd { font-size: 0.74rem; color: var(--text-muted); }
    .feat-card .fc { font-family: var(--mono); font-size: 0.72rem; color: #7dd3fc; }
    .feat-card .form-control { padding: 6px 9px; font-size: 0.82rem; min-height: 32px; }
    .feat-card label.flag { font-size: 0.8rem; color: #cbd5e1; display: flex; gap: 6px; align-items: center; }

    @media (max-width: 1280px) {
      .settings-layout { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .all-settings-grid { grid-template-columns: 1fr; }
      .docs-body { grid-template-columns: 1fr; }
    }
    @media (max-width: 1100px) {
      body { grid-template-columns: 64px minmax(0, 1fr); }
      .sidebar { padding: 14px 8px; align-items: center; }
      .brand-text, .nav-label, .tab-btn .lbl, .side-foot { display: none; }
      .brand { padding: 4px 0 12px; }
      .tab-btn { justify-content: center; padding: 10px; }
      .feat-layout { grid-template-columns: minmax(0, 1fr) 300px; }
      .stats-layout { grid-template-columns: 1fr 1fr; }
      .stats-layout .span-2, .stats-layout .span-3 { grid-column: 1 / -1; }
    }
    @media (max-width: 760px) {
      body { display: block; height: auto; overflow: auto; }
      .sidebar { flex-direction: row; position: sticky; top: 0; z-index: 50; padding: 8px 12px; overflow-x: auto; }
      .sidebar nav { flex-direction: row; }
      .brand { padding: 0 8px 0 0; }
      .app, main { height: auto; overflow: visible; }
      main { padding: 16px; }
      .topbar { padding: 12px 16px; flex-wrap: wrap; }
      .tab-content.active { height: auto; }
      .profiles-grid, .feat-main, .docs-body, .settings-layout, .stats-layout { overflow: visible; }
      .settings-layout, .stats-layout, .feat-layout, .docs-grid, .docs-body, .form-row2 { grid-template-columns: 1fr; }
      .settings-layout .span-2 { grid-column: auto; }
      .docs-nav { flex-direction: row; flex-wrap: wrap; }
      .feat-out { max-height: 260px; }
      .stats-row { grid-template-columns: 1fr 1fr; }
      .stat-card { padding: 12px; }
      .stat-ic { display: none; }
    }
  </style>
</head>
<body>

  <aside class="sidebar">
    <div class="brand">
      <svg class="brand-logo" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="cs-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#0b2a6b"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#cs-g)"/><path d="M14 24h32M39 17l7 7-7 7M50 40H18M25 33l-7 7 7 7" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="52" cy="11" r="5" fill="#D97757"/></svg>
      <span class="brand-text"><span>claude-swap</span><span class="brand-badge">Web UI</span></span>
    </div>
    <div class="nav-label">Tổng quan</div>
    <nav>
      <button class="tab-btn active" data-tab="dashboard" title="Profiles" onclick="switchTab('dashboard')">👥<span class="lbl">Profiles</span></button>
      <button class="tab-btn" data-tab="stats" title="Thống kê" onclick="switchTab('stats')">📈<span class="lbl">Thống kê</span></button>
    </nav>
    <div class="nav-label">Quản lý</div>
    <nav>
      <button class="tab-btn" data-tab="features" title="Tính năng" onclick="switchTab('features')">🧰<span class="lbl">Tính năng</span></button>
      <button class="tab-btn" data-tab="settings" title="Cấu hình" onclick="switchTab('settings')">⚙️<span class="lbl">Cấu hình</span></button>
      <button class="tab-btn" data-tab="docs" title="Hướng dẫn" onclick="switchTab('docs')">📖<span class="lbl">Hướng dẫn</span></button>
    </nav>
    <div class="side-foot">
      <div class="side-current">
        <span class="lbl">Đang dùng</span>
        <span class="val"><span class="pulse-dot"></span><span id="side-current">-</span></span>
      </div>
      <div class="side-meta">MIT • Node.js zero-deps</div>
    </div>
  </aside>

  <div class="app">
  <header class="topbar">
    <div>
      <div class="page-title" id="page-title">Profiles</div>
      <div class="page-sub" id="page-sub">Tài khoản đã lưu, quota 5 giờ / 7 ngày và chuyển nhanh</div>
    </div>
    <div class="header-actions">
      <button class="btn btn-secondary btn-sm btn-icon" title="Làm mới" onclick="loadData()">🔄</button>
      <button class="btn btn-secondary btn-sm" onclick="toggleLanguage()" id="langBtn">🌐 Tiếng Việt</button>
      <button class="btn btn-sm" onclick="showAddModal()">➕ Thêm Profile</button>
    </div>
  </header>

  <main>
    <!-- TAB 1: DASHBOARD -->
    <section id="tab-dashboard" class="tab-content active">
      <div class="stats-row">
        <div class="stat-card">
          <span class="stat-ic c-green">👤</span>
          <div class="stat-body">
            <span class="stat-label">Profile đang dùng</span>
            <div class="stat-value"><span class="pulse-dot"></span><span id="stat-current">-</span></div>
          </div>
        </div>
        <div class="stat-card">
          <span class="stat-ic c-blue">👥</span>
          <div class="stat-body">
            <span class="stat-label">Tổng số tài khoản</span>
            <div class="stat-value" id="stat-total">0</div>
          </div>
        </div>
        <div class="stat-card">
          <span class="stat-ic c-violet">🤖</span>
          <div class="stat-body">
            <span class="stat-label">Tự động switch</span>
            <div class="stat-value" id="stat-auto">Tắt</div>
          </div>
        </div>
        <div class="stat-card">
          <span class="stat-ic c-amber">⚖️</span>
          <div class="stat-body">
            <span class="stat-label">Cân bằng tải</span>
            <div class="stat-value" id="stat-balance">Tắt</div>
          </div>
        </div>
      </div>

      <div class="profiles-grid" id="profiles-container">
        <!-- Rendered by JS -->
      </div>
    </section>

    <!-- TAB: STATS -->
    <section id="tab-stats" class="tab-content scroll-y">
      <div class="stats-row" id="stats-tiles"></div>

      <div class="stats-layout">
        <div class="chart-card span-2">
          <div class="chart-head">
            <div>
              <div class="chart-title" id="usage-title">📈 Mức dùng quota theo thời gian</div>
              <div class="chart-sub">Đủ mọi lần đo trong 6 giờ gần nhất, cũ hơn mỗi giờ một điểm, giữ 7 ngày</div>
            </div>
            <select id="usage-window" class="form-control" onchange="statsKey=''; renderStats()">
              <option value="util5h">Hạn mức 5 giờ</option>
              <option value="util7d">Hạn mức 7 ngày</option>
            </select>
          </div>
          <div class="legend" id="usage-legend"></div>
          <div class="chart-wrap" id="usage-chart"></div>
        </div>
        <div class="chart-card">
          <div class="chart-head">
            <div>
              <div class="chart-title">🎯 Profile được chuyển đến nhiều nhất</div>
              <div class="chart-sub">Trong lịch sử đã lưu (tối đa 100 lần gần nhất)</div>
            </div>
          </div>
          <div class="chart-wrap" id="dest-chart"></div>
        </div>

        <div class="chart-card">
          <div class="chart-head">
            <div>
              <div class="chart-title">📊 Số lần chuyển mỗi ngày</div>
              <div class="chart-sub">14 ngày gần nhất, theo kiểu chuyển</div>
            </div>
          </div>
          <div class="legend" id="daily-legend"></div>
          <div class="chart-wrap" id="daily-chart"></div>
        </div>
        <div class="chart-card span-2">
          <div class="chart-head"><div class="chart-title">⏳ Dự báo cạn quota 5 giờ & ngân sách 7 ngày</div></div>
          <div class="tbl-wrap"><table class="cmd-table" id="forecast-table"></table></div>
        </div>

        <div class="chart-card">
          <div class="chart-head"><div>
            <div class="chart-title">📁 Usage theo dự án</div>
            <div class="chart-sub">7 ngày qua, ước tính từ % quota 5h tăng thêm ở thư mục đó</div>
          </div></div>
          <div class="tbl-wrap"><table class="cmd-table" id="project-table"></table></div>
        </div>
        <div class="chart-card span-2">
          <div class="chart-head"><div class="chart-title">📜 Lịch sử chuyển profile gần nhất</div></div>
          <div class="tbl-wrap"><table class="cmd-table" id="history-table"></table></div>
        </div>
      </div>
    </section>

    <!-- TAB: ALL FEATURES -->
    <section id="tab-features" class="tab-content">
      <div class="feat-layout">
        <div class="feat-main">
          <input type="search" id="feat-search" class="form-control feat-search" placeholder="🔎 Tìm lệnh: swap, token, webhook, codex… (phím /)" oninput="filterFeatures(this.value)" autocomplete="off">
          <div class="feat-empty" id="feat-empty" hidden>Không có lệnh nào khớp.</div>
          <div class="feat-group" id="quick-group">
            <h3>👀 Xem nhanh</h3>
            <div class="quick-row" id="quick-row"></div>
          </div>
          <div id="features-container"></div>
        </div>
        <div class="feat-side">
          <div class="card">
            <div class="card-head">
              <div class="card-title"><span class="stat-ic c-blue">💻</span>Kết quả lệnh</div>
            </div>
            <p class="feat-intro">Mọi lệnh <span class="cmd-code">/profile</span> đều có ở đây. Auto-switch, cân bằng tải, che email và URL webhook chỉnh ở tab ⚙️ Cấu hình (URL webhook là bí mật nên không đi qua dòng lệnh). Mật khẩu sao lưu đi qua stdin, không lưu ở đâu cả.</p>
            <pre class="feat-out" id="cli-output">Kết quả lệnh sẽ hiện ở đây.</pre>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: SETTINGS -->
    <section id="tab-settings" class="tab-content scroll-y">
      <div class="section-bar">
        <h2>⚙️ Cấu hình nhanh</h2>
        <button class="btn btn-sm" onclick="saveAllConfigs()">💾 Lưu cấu hình</button>
      </div>
      <div class="settings-layout">
        <!-- Auto switch config -->
        <div class="card">
          <div class="card-head"><div>
            <div class="card-title"><span class="stat-ic c-violet">🤖</span>Auto-switch</div>
            <div class="card-desc">Tự chuyển tài khoản khi chạm ngưỡng quota hoặc bị 429.</div>
          </div></div>
          <div class="form-stack">
            <label class="form-switch">
              <input type="checkbox" id="cfg-auto-enabled">
              <span class="switch-slider"></span>
              <span id="cfg-auto-enabled-label">Kiểm tra quota trước mỗi prompt</span> <button type="button" class="info-btn" data-help="auto.enabled" title="Giải thích auto.enabled" aria-label="Giải thích auto.enabled">ℹ</button>
            </label>
            <div class="form-row2">
              <div class="form-group">
                <label class="form-label">Ngưỡng 5 giờ (%) <button type="button" class="info-btn" data-help="auto.threshold" title="Giải thích auto.threshold" aria-label="Giải thích auto.threshold">ℹ</button></label>
                <input type="number" id="cfg-auto-threshold" class="form-control" min="50" max="99" value="95">
              </div>
              <div class="form-group">
                <label class="form-label">Bảo vệ 7 ngày (%) <button type="button" class="info-btn" data-help="auto.safeguard" title="Giải thích auto.safeguard" aria-label="Giải thích auto.safeguard">ℹ</button></label>
                <input type="number" id="cfg-auto-safeguard" class="form-control" min="50" max="95" value="85">
              </div>
            </div>
            <label class="form-switch">
              <input type="checkbox" id="cfg-auto-return">
              <span class="switch-slider"></span>
              <span>Tự quay về profile chính khi quota hồi</span> <button type="button" class="info-btn" data-help="auto.return" title="Giải thích auto.return" aria-label="Giải thích auto.return">ℹ</button>
            </label>
            <div class="form-row2">
              <div class="form-group">
                <label class="form-label">Profile chính <button type="button" class="info-btn" data-help="auto.primary" title="Giải thích auto.primary" aria-label="Giải thích auto.primary">ℹ</button></label>
                <select id="cfg-auto-primary" class="form-control">
                  <option value="">(Tự động)</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Nhóm (pool tag) <button type="button" class="info-btn" data-help="auto.pool" title="Giải thích auto.pool" aria-label="Giải thích auto.pool">ℹ</button></label>
                <input type="text" id="cfg-auto-pool" class="form-control" placeholder="all hoặc tên tag">
              </div>
            </div>
          </div>
        </div>

        <!-- Load balancing + masking -->
        <div class="card">
          <div class="card-head"><div>
            <div class="card-title"><span class="stat-ic c-amber">⚖️</span>Cân bằng tải</div>
            <div class="card-desc">Chủ động dàn đều mức dùng giữa các tài khoản.</div>
          </div></div>
          <div class="form-stack">
            <label class="form-switch">
              <input type="checkbox" id="cfg-balance-enabled">
              <span class="switch-slider"></span>
              <span>Kích hoạt</span>
            </label>
            <div class="form-group">
              <label class="form-label">Thuật toán <button type="button" class="info-btn" data-help="balance" title="Giải thích balance" aria-label="Giải thích balance">ℹ</button></label>
              <select id="cfg-balance-mode" class="form-control">
                <option value="least-used">Least-Used (còn nhiều quota nhất)</option>
                <option value="round-robin">Round-Robin (luân phiên)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Nhóm (pool tag) <button type="button" class="info-btn" data-help="balance.pool" title="Giải thích balance.pool" aria-label="Giải thích balance.pool">ℹ</button></label>
              <input type="text" id="cfg-balance-pool" class="form-control" placeholder="all hoặc tên tag">
            </div>
            <div class="form-group">
              <label class="form-label">🙈 Bảo mật</label>
              <label class="form-switch">
                <input type="checkbox" id="cfg-masking">
                <span class="switch-slider"></span>
                <span>Che email dạng us***@domain.com</span> <button type="button" class="info-btn" data-help="mask" title="Giải thích mask" aria-label="Giải thích mask">ℹ</button>
              </label>
            </div>
          </div>
        </div>

        <!-- Webhook -->
        <div class="card">
          <div class="card-head"><div>
            <div class="card-title"><span class="stat-ic c-pink">🔔</span>Webhook cảnh báo <button type="button" class="info-btn" data-help="webhook" title="Giải thích webhook" aria-label="Giải thích webhook">ℹ</button></div>
            <div class="card-desc">URL chứa khóa bí mật nên không hiện lại: ô trống là giữ nguyên, gỡ ở tab 🧰 Tính năng.</div>
          </div></div>
          <div class="form-stack">
            <div class="form-group">
              <label class="form-label">Telegram</label>
              <input type="text" id="cfg-webhook-telegram" class="form-control" placeholder="https://api.telegram.org/bot.../sendMessage?chat_id=...">
            </div>
            <div class="form-group">
              <label class="form-label">Discord</label>
              <input type="text" id="cfg-webhook-discord" class="form-control" placeholder="https://discord.com/api/webhooks/...">
            </div>
            <div class="form-group">
              <label class="form-label">Slack</label>
              <input type="text" id="cfg-webhook-slack" class="form-control" placeholder="https://hooks.slack.com/services/...">
            </div>
            <div class="form-group">
              <label class="form-label">Generic</label>
              <input type="text" id="cfg-webhook-generic" class="form-control" placeholder="https://example.com/hook">
            </div>
            <div><button class="btn btn-secondary btn-sm" onclick="sendTestWebhook()">🧪 Gửi thử</button></div>
          </div>
        </div>

        <div class="card span-2 tall">
          <div class="card-head"><div>
            <div class="card-title"><span class="stat-ic c-blue">🔧</span>Toàn bộ cài đặt</div>
            <div class="card-desc">Mọi cài đặt của /profile settings. Đổi một ô là lưu ngay.</div>
          </div></div>
          <div class="card-body"><div id="all-settings" class="all-settings-grid"></div></div>
        </div>
        <div class="card tall">
          <div class="card-head"><div>
            <div class="card-title"><span class="stat-ic c-green">🧩</span>Cấu hình đang có</div>
            <div class="card-desc">Alias, tag, liên kết, lịch, ngân sách, webhook. Bấm ✕ để gỡ.</div>
          </div></div>
          <div class="card-body"><div id="feature-items"></div></div>
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
          <div id="doc-intro" class="docs-card wide">
            <h2>🚀 1. Tổng Quan về claude-swap</h2>
            <p><strong>claude-swap</strong> là plugin cao cấp dành cho Claude Code cho phép chuyển đổi nóng giữa nhiều tài khoản (cá nhân, công ty, dự án khách hàng) mà không cần thoát session hay làm gián đoạn ngữ cảnh công việc.</p>
            <p>Toàn bộ kiến trúc được xây dựng thuần túy trên nền tảng <strong>Node.js built-ins (100% Zero-Dependencies)</strong>, xử lý local tức thì và không tốn bất kỳ token model nào.</p>
          </div>

          <div id="doc-commands" class="docs-card wide">
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
                <tr><td><span class="cmd-code">/profile rename &lt;cũ&gt; &lt;mới&gt;</span></td><td>Đổi tên profile, alias, liên kết, lịch sử và ngân sách đi theo</td></tr>
                <tr><td><span class="cmd-code">/profile undo</span></td><td>Quay lại profile trước lần chuyển gần nhất (gọi lần nữa để đi lại)</td></tr>
                <tr><td><span class="cmd-code">/profile statusline</span></td><td>Status line chi tiết (on/off, band = dải màu trên khung nhập, line = dòng chữ thường): thanh 5h/7d, giờ reset, cảnh báo sắp cạn</td></tr>
                <tr><td><span class="cmd-code">/profile upgrade</span></td><td>Cập nhật plugin lên bản mới nhất và tự nạp lại</td></tr>
                <tr><td><span class="cmd-code">/profile run &lt;tên&gt;</span></td><td>Chạy session Claude Code song song độc lập</td></tr>
                <tr><td><span class="cmd-code">/profile login [tên]</span></td><td>Lấy token 1 năm qua <span class="cmd-code">claude setup-token</span> (chạy trong terminal)</td></tr>
                <tr><td><span class="cmd-code">/profile add-token &lt;tok&gt;</span></td><td>Đăng ký profile trực tiếp từ setup-token hoặc API key</td></tr>
                <tr><td><span class="cmd-code">/profile balance</span></td><td>Bật/tắt chế độ cân bằng tải Quota thông minh</td></tr>
                <tr><td><span class="cmd-code">/profile webhook</span></td><td>Cấu hình thông báo Telegram, Discord, Slack</td></tr>
                <tr><td><span class="cmd-code">/profile forecast</span></td><td>Dự báo tốc độ tiêu thụ % token/giờ và thời điểm cạn hạn mức</td></tr>
                <tr><td><span class="cmd-code">/profile cooldown</span></td><td>Đồng hồ đếm ngược thời gian reset quota 5h của các tài khoản</td></tr>
                <tr><td><span class="cmd-code">/profile doctor</span></td><td>Quét chẩn đoán token OAuth, đăng nhập MCP, thời hạn và sức khỏe tài khoản</td></tr>
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

          <div id="doc-security" class="docs-card wide">
            <h2>🔐 7. Bảo Mật & Cách Ly Session Song Song</h2>
            <p>Mỗi profile được lưu trữ tại <span class="cmd-code">~/.config/claude-cli-profiles/&lt;tên&gt;.json</span> với phân quyền <span class="cmd-code">0600</span> nghiêm ngặt:</p>
            <p>• Khi chạy song song bằng <span class="cmd-code">/profile run &lt;tên&gt;</span>, một thư mục cô lập độc lập được tạo tại <span class="cmd-code">~/.config/claude-cli-profiles/.sessions/&lt;tên&gt;</span>, giúp hai cửa sổ terminal chạy hai tài khoản Claude Code cùng lúc mà không bị lẫn lộn token.</p>
            <p>• Session song song dùng chung skill, agent, plugin, settings và memory với <span class="cmd-code">~/.claude</span> (qua symlink); chỉ có đăng nhập là riêng theo profile.</p>
            <p>• Đăng nhập của các MCP server (<span class="cmd-code">mcpOAuth</span>) thuộc về máy, không thuộc tài khoản: khi đổi profile chúng được giữ nguyên, nên không phải đăng nhập lại MCP.</p>
          </div>
        </div>
      </div>
    </section>
  </main>
  </div>

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
        <div style="font-size: 12px; opacity: .75; margin-top: 6px;">🔑 Token 1 năm: chạy <span class="cmd-code">claude setup-token</span> trong terminal, mở link, đăng nhập, rồi dán token <span class="cmd-code">sk-ant-oat01-…</span> vào đây. Hoặc <span class="cmd-code">node swap.js login [tên]</span> làm trọn gói.</div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;">
        <button class="btn btn-secondary" onclick="closeAddModal()">Hủy</button>
        <button class="btn" onclick="submitAddProfile()">Tạo Profile</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>
  <div id="help-pop" class="help-pop" role="tooltip"></div>


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
      // a refused action must not be reported as done: every caller's catch shows this message instead
      if (!res.ok) {
        let msg = 'lỗi ' + res.status;
        try {
          msg = (await res.clone().json()).error || msg;
        } catch (e) {}
        throw new Error(msg);
      }
      return res;
    }

    function esc(v) {
      return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.classList.add('show');
      clearTimeout(t._hide);
      t._hide = setTimeout(() => t.classList.remove('show'), 3000);
    }

    const TAB_META = {
      dashboard: ['Profiles', 'Tài khoản đã lưu, quota 5 giờ / 7 ngày và chuyển nhanh'],
      stats: ['Thống kê', 'Mức dùng quota, dự báo và lịch sử chuyển profile'],
      features: ['Tính năng', 'Chạy mọi lệnh /profile ngay trên web'],
      settings: ['Cấu hình', 'Auto-switch, cân bằng tải, webhook và toàn bộ cài đặt'],
      docs: ['Hướng dẫn', 'Tra cứu lệnh và cách các tính năng hoạt động'],
    };
    function switchTab(name) {
      // by data-tab, not event.target: a click can land on the button's SVG icon
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + name));
      document.getElementById('page-title').textContent = TAB_META[name][0];
      document.getElementById('page-sub').textContent = TAB_META[name][1];
    }

    async function loadData() {
      try {
        const res = await api('/api/data');
        appData = await res.json();
        renderDashboard();
        renderSettings();
        renderAllSettings();
        renderStats();
        renderFeatures();
      } catch (err) {
        showToast('Lỗi tải dữ liệu: ' + err.message);
      }
    }

    function renderDashboard() {
      document.getElementById('stat-current').innerText = appData.current || '(chưa chọn)';
      document.getElementById('side-current').innerText = appData.current || '(chưa chọn)';
      // green only while a profile is in use
      document.querySelectorAll('.pulse-dot').forEach(d => d.classList.toggle('idle', !appData.current));
      document.getElementById('stat-total').innerText = appData.profiles.length;
      document.getElementById('stat-auto').innerText = appData.auto.enabled ? ('Bật (' + appData.auto.threshold + '%)') : 'Tắt';
      document.getElementById('stat-balance').innerText = appData.balance.enabled ? (appData.balance.mode) : 'Tắt';

      // One card per profile, kept across polls: only the numbers change in place, so the bars glide to their new
      // width and hover state survives. A card is rebuilt only when what it shows besides the numbers changes.
      const container = document.getElementById('profiles-container');
      const old = new Map([...container.children].map(c => [c.dataset.name, c]));
      const now = Date.now();
      appData.profiles.forEach((p, i) => {
        const key = JSON.stringify([p.name, p.active, p.email, p.tags, p.aliases, p.disabled, p.quota5h === null, p.quota7d === null, p.cooldownSec > 0]);
        let card = old.get(p.name);
        old.delete(p.name);
        if (!card || card.dataset.key !== key) {
          const fresh = buildCard(p);
          fresh.dataset.key = key;
          if (card) card.replaceWith(fresh);
          card = fresh;
        }
        if (container.children[i] !== card) container.insertBefore(card, container.children[i] || null);
        card.dataset.resetAt = p.cooldownSec > 0 ? String(now + p.cooldownSec * 1000) : '';
        updateCard(card, p);
      });
      old.forEach(c => c.remove());
      tickCooldowns();
    }

    function fillClass(val, is7d) {
      return 'progress-bar-fill ' + (is7d ? (val >= 85 ? 'fill-red' : 'fill-green') : val >= 95 ? 'fill-red' : val >= 80 ? 'fill-orange' : val >= 50 ? 'fill-yellow' : 'fill-green');
    }

    // the numbers of a card; a new bar starts at 0 and grows on the next frame
    function updateCard(card, p) {
      [[p.quota5h, false], [p.quota7d, true]].forEach(([q, is7d]) => {
        const item = card.querySelector(is7d ? '[data-q="7d"]' : '[data-q="5h"]');
        if (!item || q === null) return;
        const val = Math.round(q);
        item.querySelector('.quota-val').textContent = val + '%';
        const fill = item.querySelector('.progress-bar-fill');
        fill.className = fillClass(val, is7d);
        requestAnimationFrame(() => { fill.style.width = val + '%'; });
      });
    }

    // the reset countdown runs every second in the page instead of jumping on each 5 s poll
    function tickCooldowns() {
      document.querySelectorAll('.profile-card[data-reset-at]').forEach(card => {
        const el = card.querySelector('.cooldown-text');
        if (!el || !card.dataset.resetAt) return;
        const left = Math.max(0, Math.round((Number(card.dataset.resetAt) - Date.now()) / 1000));
        el.textContent = '⏱️ Reset sau: ' + Math.floor(left / 60) + 'm ' + String(left % 60).padStart(2, '0') + 's';
      });
    }
    setInterval(() => { if (!document.hidden) tickCooldowns(); }, 1000);

    function buildCard(p) {
        const card = document.createElement('div');
        card.className = 'profile-card' + (p.active ? ' is-active' : '');
        card.dataset.name = p.name;

        const bar = (label, q) => \`
              <div class="quota-meta"><span>\${label}</span><span class="quota-val"></span></div>
              <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: 0;"></div></div>\`;
        const quotaHtml = p.quota5h === null && p.quota7d === null
          ? '<div class="quota-empty">Chưa có dữ liệu quota</div>'
          : '<div class="quota-item" data-q="5h">' + (p.quota5h !== null ? bar('5 giờ', p.quota5h) : '<span class="quota-empty">5 giờ: -</span>') + '</div>' +
            (p.quota7d !== null ? '<div class="quota-item" data-q="7d">' + bar('7 ngày', p.quota7d) + '</div>' : '');
        const cooldownHtml = p.cooldownSec > 0 ? '<div class="cooldown-text"></div>' : '';
        const tagsHtml = p.tags.length ? '<div class="tags">' + p.tags.map(t => '<span class="tag-pill">🏷️ ' + esc(t) + '</span>').join('') + '</div>' : '';
        const aliasHtml = p.aliases.length ? ' <span class="alias">@' + esc(p.aliases.join(', @')) + '</span>' : '';
        const badge = p.active ? '<span class="badge badge-green"><span class="pulse-dot"></span>Đang dùng</span>'
          : p.disabled ? '<span class="badge badge-muted">Auto tắt</span>' : '';
        const name = esc(p.name);
        if (p.disabled) card.classList.add('is-disabled');

        card.innerHTML = \`
          <div class="pc-head">
            <div class="avatar" style="background:\${profileColor(p.name)}">\${esc(p.name.slice(0, 1))}</div>
            <div class="pc-id">
              <div class="profile-name">\${name}\${aliasHtml}</div>
              <div class="profile-email" title="\${esc(p.email || '')}">\${esc(p.email || 'Chưa liên kết email')}</div>
            </div>
            \${badge}
          </div>
          \${tagsHtml}
          \${p.note ? '<div class="pc-note" title="Ghi chú (/profile note)">📝 ' + esc(p.note) + '</div>' : ''}
          <div class="quota-box">\${quotaHtml}\${cooldownHtml}</div>
          <div class="profile-actions">
            \${!p.active ? \`<button class="btn btn-sm" onclick="doSwap('\${name}')">🔀 Chuyển</button>\` : '<span class="in-use">✓ Đang sử dụng</span>'}
            <span class="spacer"></span>
            <button class="btn btn-secondary btn-sm" title="\${p.disabled ? 'Cho auto-switch dùng lại profile này' : 'Không để auto-switch chọn profile này'}" onclick="toggleDisable('\${name}', \${p.disabled})">\${p.disabled ? '▶ Bật auto' : '🚫 Tắt auto'}</button>
            <button class="btn btn-sm btn-danger btn-icon" title="Xóa \${name}" onclick="doDelete('\${name}')">🗑</button>
          </div>
        \`;
        return card;
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
    function tile(label, value, sub, icon, color) {
      return '<div class="stat-card">' + (icon ? '<span class="stat-ic ' + color + '">' + icon + '</span>' : '') + '<div class="stat-body"><span class="stat-label">' + esc(label) + '</span><div class="stat-value">' + esc(value) + '</div>' + (sub ? '<span class="chart-sub">' + esc(sub) + '</span>' : '') + '</div></div>';
    }
    // a % cell: the number plus a thin bar in the quota colours (width defaults to the value itself)
    function miniBar(pct, width) {
      const v = Math.round(pct);
      return '<div class="mini"><div class="mini-bar"><i class="' + fillClass(v, false).replace('progress-bar-fill ', '') + '" style="width:' + Math.min(100, width === undefined ? v : width) + '%"></i></div><b>' + v + '%</b></div>';
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
      const W = 860, H = 280, L = 40, R = 135, T = 14, B = 30;
      let t0 = Infinity, t1 = -Infinity;
      series.forEach(s => s.pts.forEach(p => { t0 = Math.min(t0, p.t); t1 = Math.max(t1, p.t); }));
      if (t1 - t0 < 60000) { t0 -= 1800000; t1 += 1800000; }
      const X = t => L + (t - t0) / (t1 - t0) * (W - L - R);
      const Y = v => T + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - T - B);
      const limit = field === 'util5h' ? (appData.auto.threshold || 95) : (appData.auto.safeguardThreshold || 85);
      let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Mức dùng quota theo thời gian"><defs>';
      series.forEach((s, i) => {
        svg += '<linearGradient id="ug' + i + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:' + s.color + ';stop-opacity:' + (series.length > 3 ? 0.12 : 0.24) + '"/><stop offset="1" style="stop-color:' + s.color + ';stop-opacity:0"/></linearGradient>';
      });
      svg += '</defs>';
      // the band above the limit: where auto-switch (5h) or the safeguard (7d) kicks in
      svg += '<rect x="' + L + '" y="' + Y(100) + '" width="' + (W - L - R) + '" height="' + (Y(limit) - Y(100)) + '" fill="rgba(239,68,68,0.07)"/>';
      [0, 25, 50, 75, 100].forEach(v => {
        svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--grid)" stroke-width="1"' + (v ? ' stroke-dasharray="2 4"' : '') + '/>';
        svg += '<text x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '%</text>';
      });
      for (let i = 0; i < 4; i++) {
        const t = t0 + (t1 - t0) * i / 3;
        svg += '<text x="' + X(t) + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 ? 'start' : i === 3 ? 'end' : 'middle') + '">' + fmtTime(t) + '</text>';
      }
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(limit) + '" y2="' + Y(limit) + '" stroke="#f87171" stroke-opacity="0.6" stroke-width="1" stroke-dasharray="4 4"/>';
      svg += '<text x="' + (W - R + 6) + '" y="' + (Y(limit) + 4) + '" style="fill:#fca5a5">' + (field === 'util5h' ? 'ngưỡng ' : 'safeguard ') + limit + '%</text>';
      series.forEach((s, i) => {
        const xy = s.pts.map(p => [X(p.t), Y(p.v)]);
        const d = smoothPath(xy);
        if (xy.length > 1) svg += '<path class="fade-in" d="' + d + ' L' + xy[xy.length - 1][0].toFixed(1) + ' ' + Y(0) + ' L' + xy[0][0].toFixed(1) + ' ' + Y(0) + ' Z" fill="url(#ug' + i + ')"/>';
        svg += '<path class="draw" pathLength="1" d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
        if (s.pts.length < 12) s.pts.forEach(p => { svg += '<circle class="fade-in" cx="' + X(p.t) + '" cy="' + Y(p.v) + '" r="3.5" fill="' + s.color + '" stroke="var(--card-bg)" stroke-width="2"/>'; });
      });
      if (series.length <= 4) {
        const ends = series.map(s => { const p = s.pts[s.pts.length - 1]; return { s, x: X(p.t), y: Y(p.v), v: p.v }; }).sort((a, b) => a.y - b.y);
        for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
        ends.forEach(e => { svg += '<text x="' + (W - R + 6) + '" y="' + (e.y + 4) + '" style="fill:#e5e7eb;font-weight:600">' + esc(e.s.name) + ' ' + Math.round(e.v) + '%</text>'; });
      }
      svg += '<line id="usage-cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="#94a3b8" stroke-opacity="0.5" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>';
      series.forEach((s, i) => { svg += '<circle class="hover-dot" data-i="' + i + '" r="4.5" fill="' + s.color + '" stroke="#fff" stroke-width="1.5" visibility="hidden"/>'; });
      svg += '<rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>';
      svg += '</svg>';
      wrap.innerHTML = svg;
      const el = wrap.querySelector('svg');
      const cross = wrap.querySelector('#usage-cross');
      const dots = [...wrap.querySelectorAll('.hover-dot')];
      attachTip(wrap, el, x => {
        if (x === null || x < L || x > W - R) { cross.setAttribute('visibility', 'hidden'); dots.forEach(c => c.setAttribute('visibility', 'hidden')); return ''; }
        const t = t0 + (x - L) / (W - L - R) * (t1 - t0);
        let best = null;
        series.forEach(s => s.pts.forEach(p => { if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; }));
        cross.setAttribute('x1', X(best.t)); cross.setAttribute('x2', X(best.t)); cross.setAttribute('visibility', 'visible');
        const rows = series.map((s, i) => {
          const near = s.pts.reduce((a, p) => Math.abs(p.t - best.t) < Math.abs(a.t - best.t) ? p : a);
          const hit = Math.abs(near.t - best.t) <= 600000;
          dots[i].setAttribute('visibility', hit ? 'visible' : 'hidden');
          if (hit) { dots[i].setAttribute('cx', X(near.t)); dots[i].setAttribute('cy', Y(near.v)); }
          return hit ? '<div><i style="background:' + s.color + '"></i>' + esc(s.name) + ': <b>' + Math.round(near.v) + '%</b></div>' : '';
        }).join('');
        return '<div style="color:#94a3b8;margin-bottom:4px;">' + fmtTime(best.t) + '</div>' + rows;
      });
    }

    // monotone cubic (Fritsch-Carlson): smooth, and never bends past a measured value, so 0-100% stays in range
    function smoothPath(pts) {
      const f = v => v.toFixed(1);
      const n = pts.length;
      if (n < 3) return pts.map((p, i) => (i ? 'L' : 'M') + f(p[0]) + ' ' + f(p[1])).join(' ');
      const dx = [], m = [], tg = [];
      for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0; }
      tg[0] = m[0]; tg[n - 1] = m[n - 2];
      for (let i = 1; i < n - 1; i++) {
        tg[i] = m[i - 1] * m[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
      }
      let d = 'M' + f(pts[0][0]) + ' ' + f(pts[0][1]);
      for (let i = 0; i < n - 1; i++) {
        const h = dx[i] / 3;
        d += ' C' + f(pts[i][0] + h) + ' ' + f(pts[i][1] + h * tg[i]) + ' ' + f(pts[i + 1][0] - h) + ' ' + f(pts[i + 1][1] - h * tg[i + 1]) + ' ' + f(pts[i + 1][0]) + ' ' + f(pts[i + 1][1]);
      }
      return d;
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
      const W = 400, H = 240, L = 26, R = 6, T = 10, B = 26;
      const step = Math.max(1, Math.ceil(max / 4));
      const top = step * 4;
      const bw = (W - L - R) / days.length;
      const Y = v => T + (1 - v / top) * (H - T - B);
      let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Số lần chuyển profile mỗi ngày">';
      svg += '<rect id="daily-hl" x="0" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '" rx="4" fill="rgba(255,255,255,0.05)" visibility="hidden"/>';
      for (let v = 0; v <= top; v += step) {
        svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--grid)"' + (v ? ' stroke-dasharray="2 4"' : '') + '/>';
        svg += '<text x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '</text>';
      }
      days.forEach((d, i) => {
        const x = L + i * bw + bw * 0.2, w = bw * 0.6;
        let acc = 0;
        TYPE_META.forEach(m => {
          const v = d[m[0]];
          if (!v) return;
          const y0 = Y(acc), y1 = Y(acc + v);
          svg += '<rect class="grow" style="animation-delay:' + (i * 30) + 'ms" x="' + x + '" y="' + y1 + '" width="' + w + '" height="' + Math.max(1, y0 - y1 - (acc ? 2 : 0)) + '" rx="3" fill="' + m[2] + '"/>';
          acc += v;
        });
        if (i % 2 === 1 || days.length <= 7) svg += '<text x="' + (x + w / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + d.label + '</text>';
      });
      svg += '<rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/></svg>';
      wrap.innerHTML = svg;
      const hl = wrap.querySelector('#daily-hl');
      attachTip(wrap, wrap.querySelector('svg'), x => {
        const i = x === null ? -1 : Math.floor((x - L) / bw);
        const d = days[i];
        hl.setAttribute('visibility', d ? 'visible' : 'hidden');
        if (!d) return '';
        hl.setAttribute('x', L + i * bw);
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
      wrap.innerHTML = rows.map((r, i) =>
        '<div class="hbar-row" title="' + esc(r[0]) + ': ' + r[1] + ' lần">' +
        '<span class="hbar-rank">#' + (i + 1) + '</span>' +
        '<span class="hbar-name"><i style="background:' + profileColor(r[0]) + '"></i>' + esc(r[0]) + '</span>' +
        '<div class="hbar-track"><i style="width:' + (r[1] / max * 100) + '%;background:' + profileColor(r[0]) + ';animation-delay:' + (i * 60) + 'ms"></i></div>' +
        '<span class="hbar-val">' + r[1] + '</span></div>'
      ).join('');
    }

    function renderStats() {
      const hist = appData.swapHistory || [];
      const key = JSON.stringify([hist, appData.usageHistory, appData.forecast, appData.weekly, appData.recovered, appData.projectUsage, appData.auto, (appData.profiles || []).map(p => p.name)]);
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
        tile('Tổng lượt chuyển', hist.length, hist.length >= 100 ? '100 lần gần nhất' : '', '🔀', 'c-blue') +
        tile('7 ngày qua', week, '', '📅', 'c-violet') +
        tile('Tay / Auto / Dự án', counts.manual + ' / ' + counts.auto + ' / ' + counts.project, '', '📊', 'c-amber') +
        tile('Hay dùng nhất', top ? top[0] : '-', top ? top[1] + ' lần' : '', '⭐', 'c-pink') +
        ((appData.recovered || []).length ? tile('Đã hồi quota', appData.recovered.join(', '), 'dùng lại được', '✅', 'c-green') : '');

      renderUsageChart();
      renderDailyChart(hist);
      renderDestChart(hist);

      const fc = appData.forecast || {};
      const names = Object.keys(fc);
      const perHour = v => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)) + '%/giờ';
      // 7-day budget: the quota left spread over the hours until the reset, against the pace of the last 3 hours
      const weekCell = n => {
        const w = (appData.weekly || {})[n];
        if (!w) return '<td class="muted">-</td>';
        const over = w.rate !== null && w.rate > w.budget;
        return '<td><span class="pill ' + (over ? 'pill-orange' : 'pill-blue') + '">' + (over ? '⚠ ' : '') + 'còn ' + Math.round(100 - w.pct) + '% → ≈' + perHour(w.budget) + '</span>' +
          (w.rate !== null ? ' <span class="muted">đang ' + perHour(w.rate) + '</span>' : '') + '</td>';
      };
      document.getElementById('forecast-table').innerHTML = names.length
        ? '<thead><tr><th>Profile</th><th>Đang dùng</th><th>Tốc độ</th><th>Chạm ngưỡng</th><th>Ngân sách 7 ngày</th></tr></thead><tbody>' + names.map(n => {
            const f = fc[n];
            const who = '<td><span class="hbar-name"><i style="background:' + profileColor(n) + '"></i>' + esc(n) + '</span></td>';
            if (!f.hasData) return '<tr>' + who + '<td colspan="3" class="muted">' + esc(f.message) + '</td>' + weekCell(n) + '</tr>';
            const eta = f.trend === 'increasing'
              ? '<span class="pill ' + (f.minutesUntilThreshold <= 30 ? 'pill-red' : f.minutesUntilThreshold <= 60 ? 'pill-orange' : 'pill-yellow') + '">⏳ ~' + f.minutesUntilThreshold + ' phút</span> <span class="muted">' + fmtTime(f.estimatedTimestamp) + '</span>'
              : '<span class="pill pill-green">✓ Ổn định</span>';
            return '<tr>' + who + '<td>' + miniBar(f.currentUtil) + '</td><td>' + (f.burnRatePerHour > 0 ? '+' + f.burnRatePerHour + '%/giờ' : '<span class="muted">0</span>') + '</td><td>' + eta + '</td>' + weekCell(n) + '</tr>';
          }).join('') + '</tbody>'
        : '<tbody><tr><td class="empty-state">Chưa có profile nào.</td></tr></tbody>';

      const proj = appData.projectUsage || [];
      const projMax = Math.max(1, ...proj.map(p => p.pct));
      document.getElementById('project-table').innerHTML = proj.length
        ? '<thead><tr><th>Dự án</th><th>% 5h đã dùng</th><th>Thư mục</th></tr></thead><tbody>' + proj.slice(0, 15).map(p =>
            '<tr><td>📁 ' + esc(p.dir.split(/[\\\\/]/).pop()) + '</td><td>' + miniBar(p.pct, p.pct / projMax * 100) + '</td><td class="muted">' + esc(p.dir) + '</td></tr>'
          ).join('') + '</tbody>'
        : '<tbody><tr><td class="empty-state">Chưa có dữ liệu. Số liệu dồn dần mỗi lần plugin đo quota khi bạn làm việc.</td></tr></tbody>';

      const typeLabel = { auto: '<span class="pill pill-violet">🤖 Tự động</span>', project: '<span class="pill pill-green">📁 Dự án</span>' };
      document.getElementById('history-table').innerHTML = hist.length
        ? '<thead><tr><th>Thời gian</th><th>Kiểu</th><th>Từ</th><th>Sang</th><th>Lý do</th></tr></thead><tbody>' + hist.slice(0, 20).map(h =>
            '<tr><td class="muted">' + fmtTime(h.timestamp) + '</td><td>' + (typeLabel[h.type] || '<span class="pill pill-blue">👤 Thủ công</span>') + '</td><td>' + esc(h.from) + '</td><td><span class="hbar-name"><i style="background:' + profileColor(h.to) + '"></i>' + esc(h.to) + '</span></td><td class="muted">' + esc(h.reason) + '</td></tr>'
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
        ['Đổi tên profile', ['rename'], [['profile', 'Profile'], ['text', 'Tên mới']]],
        ['Quay lại profile trước', ['undo'], []],
        ['Xóa profile', ['delete'], [['profile', 'Profile']], true],
        ['Đặt alias', ['alias'], [['text', 'Alias (vd: w)'], ['profile', 'Profile']]],
        ['Xóa alias', ['unalias'], [['text', 'Alias']]],
        ['Gắn tag', ['tag'], [['profile', 'Profile'], ['text', 'Tag (vd: corp)']]],
        ['Gỡ tag', ['untag'], [['profile', 'Profile'], ['text', 'Tag']]],
        ['Cho nghỉ auto-switch', ['disable'], [['profile', 'Profile']]],
        ['Cho đi làm lại', ['enable'], [['profile', 'Profile']]],
        ['Nhập profile từ thư mục khác', ['import'], [['dir', 'Đường dẫn thư mục'], ['flag', 'Ghi đè profile trùng tên', '--force']]],
        ['Ghi chú cho profile', ['note'], [['profile', 'Profile'], ['text', 'Nội dung']]],
        ['Xóa ghi chú', ['note', '--clear'], [['profile', 'Profile']], true],
        ['Khôi phục profile đã xóa', ['restore'], [['text', 'Tên profile (trong thùng rác 7 ngày)']]],
        ['Gộp profile trùng tài khoản', ['dedupe', '--apply'], [], true],
      ]],
      ['🤖 Tự động & quota', [
        ['Thứ tự ưu tiên auto-switch', ['auto', 'order'], [['text', 'Danh sách, vd: work,personal']]],
        ['Hạn mức mỗi lượt (xoay vòng account)', ['auto', 'step'], [['number', '% quota 5h mỗi lượt (0 = tắt)', '5']]],
        ['Kiểm tra quota và đổi nếu cần', ['auto', 'check', '--yes'], []], // the click is the confirmation auto.confirm asks for
        ['Cân bằng tải: sang profile kế tiếp', ['balance', 'next'], []],
        ['Mượn tạm profile', ['temp'], [['profile', 'Profile'], ['text', 'Thời gian (vd: 30m, 1h)', '1h']]],
        ['Trả profile đang mượn', ['untemp'], []],
        ['Trạng thái mượn tạm', ['temp'], []],
        ['Dọn profile hỏng', ['cleanup', '--force'], [], true],
        ['Đổi profile theo lịch', ['schedule'], [['text', 'Khung giờ HH:MM-HH:MM (vd: 09:00-18:00)'], ['profile', 'Profile']]],
        ['Xóa lịch đổi profile', ['unschedule'], [['text', 'Số thứ tự hoặc all', 'all']]],
        ['Làm mới token hết hạn', ['repair'], [['text', 'Profile (bỏ trống = tất cả)', '', true]]],
        ['Tự làm mới token ở nền', ['repair', 'auto'], [['choice', 'Trạng thái', ['on', 'off']]]],
        ['Đổi một cài đặt', ['settings', 'set'], [['text', 'Key (vd: auto.threshold)'], ['text', 'Giá trị']]],
      ]],
      ['📁 Dự án, nhánh Git & model', [
        ['Gắn profile cho thư mục', ['bind'], [['profile', 'Profile'], ['dir', 'Đường dẫn thư mục dự án']]],
        ['Gỡ gắn thư mục', ['unbind'], [['dir', 'Đường dẫn thư mục dự án']]],
        ['Thư mục đang gắn profile nào?', ['bind', 'get'], [['dir', 'Đường dẫn thư mục dự án']]],
        ['Gắn profile theo nhánh Git', ['bind-branch'], [['text', 'Mẫu nhánh (vd: feat/*)'], ['profile', 'Profile'], ['dir', 'Đường dẫn repo']]],
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
        ['Xuất bản sao lưu mã hóa', ['export'], [['dir', 'Thư mục lưu bản sao lưu'], ['password', 'Mật khẩu']]],
        ['Khôi phục từ file mã hóa', ['import-enc'], [['file', 'Đường dẫn đầy đủ tới file .enc'], ['password', 'Mật khẩu'], ['flag', 'Ghi đè profile trùng tên', '--force']]],
        ['Chọn nơi đồng bộ', ['sync', 'setup'], [['dir', 'Thư mục đồng bộ, vd: thư mục Drive/MEGA']]],
        ['Trạng thái đồng bộ', ['sync'], []],
        ['Đẩy bản đồng bộ', ['sync', 'push'], [['password', 'Mật khẩu']]],
        ['Kéo bản đồng bộ', ['sync', 'pull'], [['password', 'Mật khẩu'], ['flag', 'Ghi đè profile trùng tên', '--force']]],
        ['Xuất cấu hình không chứa token', ['share'], [['save', 'Đường dẫn đầy đủ (bỏ trống = in ra)', '', true]]],
      ]],
      ['💻 Shell & công cụ', [
        ['Snippet cho shell prompt', ['prompt'], [['choice', 'Shell', ['starship', 'zsh', 'bash', 'tmux', 'powershell']]]],
        ['Script Tab completion', ['completion'], [['choice', 'Shell', ['bash', 'zsh', 'fish']]]],
        ['Lịch sử chuyển profile', ['history'], [['number', 'Số dòng', '20']]],
        ['Status line chi tiết', ['statusline'], [['choice', 'Trạng thái', ['on', 'off', 'toggle', 'line', 'band']]]],
        ['Cập nhật plugin', ['upgrade'], []],
        ['Mở thư mục profile', ['folder'], []],
        ['Đổi ngôn ngữ', ['lang'], [['choice', 'Ngôn ngữ', ['vi', 'en']]]],
      ]],
      ['🧰 AI CLI khác (Codex, Antigravity, OpenCode)', [
        ...[['codex', 'Codex'], ['agy', 'Antigravity'], ['opencode', 'OpenCode']].flatMap(t => [
          ['Lưu tài khoản ' + t[1] + ' đang đăng nhập', [t[0], 'save'], [['text', 'Tên profile'], ['flag', 'Ghi đè', '--force']]],
          ['Chuyển tài khoản ' + t[1], [t[0], 'use'], [['text', 'Tên profile'], ['flag', 'Bỏ qua login chưa lưu (cất vào thùng rác)', '--force']]],
          ['Xóa profile ' + t[1], [t[0], 'delete'], [['text', 'Tên profile']], true],
        ]),
      ]],
    ];
    // one plain-language (and slightly cheeky) line per card, keyed by its title
    const QUIPS = {
      'Chuyển profile': 'Đổi tài khoản trong một nốt nhạc. Claude còn không biết mình vừa đổi chủ.',
      'Tạo profile từ tài khoản đang đăng nhập': 'Chụp ảnh tài khoản đang dùng rồi cất vào ngăn kéo. Lần sau lôi ra là xài.',
      'Lưu tài khoản hiện tại vào profile': 'Cập nhật profile bằng tài khoản đang đăng nhập, rất hợp sau khi vừa /login lại.',
      'Đổi tên profile': 'Đổi tên mà không bỏ rơi ai: alias, liên kết, lịch sử, ngân sách đều đi theo.',
      'Quay lại profile trước': 'Lỡ tay đổi nhầm? Về chỗ cũ trong một nốt nhạc. Bấm lần nữa thì đi lại.',
      'Xóa profile': 'Chia tay dứt khoát: không thùng rác, không tái hợp.',
      'Đặt alias': 'Đặt biệt danh cho profile. Gõ "w" nhanh hơn "work-company-production-2" nhiều.',
      'Xóa alias': 'Biệt danh hết thời thì xóa. Profile gốc vẫn bình an vô sự.',
      'Gắn tag': 'Dán nhãn để phân nhóm, rồi cho auto-switch hay cân bằng tải chỉ chạy trong nhóm đó.',
      'Gỡ tag': 'Bóc nhãn ra. Profile không giận đâu.',
      'Cho nghỉ auto-switch': 'Cho profile nghỉ phép: auto-switch sẽ không gọi nó dậy, nhưng bạn vẫn đổi tay được.',
      'Cho đi làm lại': 'Hết phép rồi, quay lại vòng xoay auto-switch thôi.',
      'Nhập profile từ thư mục khác': 'Dọn nhà cho profile từ thư mục khác (hoặc máy cũ) về đây.',
      'Thứ tự ưu tiên auto-switch': 'Xếp hàng xem ai lên thay khi profile hiện tại hết quota. Có trước có sau.',
      'Hạn mức mỗi lượt (xoay vòng account)': 'Mỗi account dùng N% quota 5h rồi nhường lượt cho account kế tiếp, xoay vòng mãi. Mỗi lần đổi đều có thông báo.',
      'Kiểm tra quota và đổi nếu cần': 'Khỏi chờ tới prompt kế tiếp: bấm là kiểm tra, chạm ngưỡng là đổi ngay.',
      'Cân bằng tải: sang profile kế tiếp': 'Chuyền bóng cho đồng đội theo thuật toán cân bằng. Không ai phải gánh team.',
      'Mượn tạm profile': 'Mượn có hẹn giờ trả. Hết giờ tự trả, khỏi sợ mang tiếng quên.',
      'Trả profile đang mượn': 'Trả sớm cho giữ uy tín, quay về profile gốc ngay.',
      'Trạng thái mượn tạm': 'Đang mượn của ai, còn bao nhiêu phút nữa phải trả?',
      'Dọn profile hỏng': 'Đổ rác: xóa thật những profile hỏng. Không hoàn tác được, nên chạy "Cleanup (chỉ quét)" trước.',
      'Đổi profile theo lịch': 'Tới giờ là tự đổi, mỗi khung giờ một lần. Khung qua đêm như 22:00-06:00 cũng được.',
      'Xóa lịch đổi profile': 'Gỡ một dòng lịch theo số thứ tự, hoặc all để xóa hết.',
      'Làm mới token hết hạn': 'Gửi một request rất nhỏ trong session riêng để lấy token mới, không cần chuyển profile.',
      'Tự làm mới token ở nền': 'Mỗi 6 giờ tự làm mới token hết hạn, để profile nào cũng sẵn sàng khi cần.',
      'Đổi một cài đặt': 'Như /profile settings set: xem danh sách key bằng nút ⚙️ Cài đặt ở trên.',
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
      'Status line chi tiết': 'Bật/tắt dòng trạng thái trong Claude Code: thanh 5h/7d, giờ reset, cảnh báo sắp cạn.',
      'Cập nhật plugin': 'Kéo bản mới nhất về. Plugin tự nạp lại sau khi cập nhật, khỏi khởi động lại Claude Code.',
      'Mở thư mục profile': 'Mở thư mục chứa profile. Ngó thì được, đừng sửa tay.',
      'Ghi chú cho profile': 'Dán một dòng nhắc nhở lên profile, vd: "tài khoản công ty, đừng dùng cuối tuần".',
      'Khôi phục profile đã xóa': 'Lôi profile ra khỏi thùng rác (giữ 7 ngày). Alias thì không theo về.',
      'Gộp profile trùng tài khoản': 'Nhiều profile cùng một tài khoản? Giữ cái token mới nhất, gộp phần còn lại vào.',
      'Xóa ghi chú': 'Bóc tờ giấy nhắc ra khỏi profile.',
      'Đổi ngôn ngữ': 'Tiếng Việt hay English cho các thông báo của CLI.',
    };
    const QUICK = [['📋 Danh sách', ['list'], 'Điểm danh cả đội, kèm thanh quota.'], ['🟢 Đang dùng', ['current'], 'Mình đang là ai?'], ['📊 Usage', ['usage'], 'Quota 5h, 7d và từng model (lấy từ cache).'], ['🔄 Usage (làm mới)', ['usage', '--refresh'], 'Hỏi lại server số mới nhất. Đừng spam, server cũng biết mệt.'],
      ['📈 Dự báo', ['forecast'], 'Bói xem bao giờ cạn quota, dựa trên tốc độ tiêu thụ thật.'], ['⏱️ Cooldown', ['cooldown'], 'Đếm ngược tới lúc quota 5h hồi sức.'], ['🩺 Doctor', ['doctor'], 'Khám tổng quát: token, file cấu hình, kết nối.'], ['🧹 Cleanup (chỉ quét)', ['cleanup'], 'Tìm profile trùng hoặc hỏng. Chỉ nhìn, không xóa.'], ['🔧 Sửa token', ['repair'], 'Làm mới token hết hạn của các profile khác, không cần chuyển sang. Mất vài giây mỗi profile.'], ['⚙️ Cài đặt', ['settings'], 'Mọi cài đặt và giá trị hiện tại trong một bảng.'], ['🗓️ Lịch', ['schedule'], 'Các khung giờ tự đổi profile.'],
      ['📊 Thống kê', ['stats'], 'Đổi tay bao nhiêu lần, tự động bao nhiêu lần.'], ['🔤 Aliases', ['aliases'], 'Danh bạ biệt danh.'], ['🏷️ Tags', ['tags'], 'Ai thuộc nhóm nào.'], ['🚫 Đang nghỉ', ['disabled'], 'Danh sách profile đang nghỉ phép.'],
      ['🌿 Nhánh Git', ['branch-bindings'], 'Nhánh nào đi với tài khoản nào.'], ['🧠 Model', ['affinities'], 'Model nào đi với tài khoản nào.'], ['💰 Ngân sách', ['budget'], 'Trần chi tiêu hiện tại.'], ['🔔 Webhook', ['webhook'], 'Kênh báo nào đang bật.'],
      ['⚖️ Cân bằng tải', ['balance'], 'Đang chia việc theo kiểu nào.'], ['🤖 Auto', ['auto'], 'Auto-switch đang cấu hình ra sao.'], ['🛡️ Che email', ['mask'], 'Email đang được che hay đang lộ mặt.'], ['💻 Statusline', ['statusline'], 'Chuỗi trạng thái gọn để nhét vào prompt.'], ['ℹ️ Phiên bản', ['version'], 'Đang chạy bản nào.'],
      ['✅ Kiểm tra đăng nhập', ['verify'], 'Hỏi server xem từng profile còn đăng nhập được không.'], ['🔍 Trùng tài khoản', ['dedupe'], 'Xem profile nào trùng tài khoản. Chỉ nhìn, chưa gộp.'], ['📤 Cấu hình (JSON)', ['export-config'], 'Alias, tag, ghi chú, auto-switch dạng JSON. Không có token.'], ['🌐 Ngôn ngữ', ['lang'], 'Đang nói tiếng gì.'],
      ['🤖 Codex', ['codex'], 'Các tài khoản Codex đã lưu.'], ['🛰️ Antigravity', ['agy'], 'Các tài khoản Antigravity đã lưu.'], ['🧩 OpenCode', ['opencode'], 'Các tài khoản OpenCode đã lưu.']];
    let featuresBuilt = false;
    let featureProfiles = '';

    function fieldHtml(id, f) {
      const kind = f[0], label = esc(f[1]);
      if (kind === 'flag') return '<label class="flag"><input type="checkbox" id="' + id + '"> ' + label + '</label>';
      if (kind === 'profile') return '<select id="' + id + '" class="form-control feat-profile" aria-label="' + label + '"></select>';
      if (kind === 'choice') return '<select id="' + id + '" class="form-control" aria-label="' + label + '">' + f[2].map(o => '<option>' + esc(o) + '</option>').join('') + '</select>';
      const type = kind === 'password' ? 'password' : kind === 'number' ? 'number' : 'text';
      if (PICK_LABEL[kind]) {
        return '<div class="path-row"><input id="' + id + '" type="text" class="form-control" placeholder="' + label + '" aria-label="' + label + '" value="' + esc(f[2] || '') + '">' +
          '<button type="button" class="btn btn-secondary btn-sm" title="' + PICK_LABEL[kind] + '" onclick="pickInto(' + "'" + id + "', '" + kind + "'" + ')">📁 Chọn</button></div>';
      }
      return '<input id="' + id + '" type="' + type + '" class="form-control" placeholder="' + label + '" aria-label="' + label + '" value="' + esc(f[2] || '') + '"' + (type === 'password' ? ' autocomplete="off"' : '') + '>';
    }

    const PICK_LABEL = { dir: 'Chọn thư mục', file: 'Chọn file', save: 'Chọn nơi lưu file' };
    async function pickInto(id, mode) {
      try {
        showToast('Đang mở hộp thoại chọn trên máy chạy dashboard...');
        const res = await api('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'pick_path', mode })
        });
        const data = await res.json();
        if (data.path) document.getElementById(id).value = data.path;
      } catch (err) {
        showToast('Lỗi: ' + err.message);
      }
    }

    // hides cards and quick buttons whose title, quip or command does not hold every typed word
    function filterFeatures(q) {
      // accent-blind: "token het han" finds "Làm mới token hết hạn"
      const fold = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
      const words = fold(q).split(' ').filter(Boolean);
      const hit = text => { const t = fold(text); return words.every(w => t.includes(w)); };
      let shown = 0;
      document.querySelectorAll('#quick-row button').forEach(b => { const ok = hit(b.textContent + ' ' + b.title + ' ' + b.dataset.cmd); b.hidden = !ok; if (ok) shown++; });
      document.getElementById('quick-group').hidden = !document.querySelector('#quick-row button:not([hidden])');
      document.querySelectorAll('#features-container .feat-group').forEach(g => {
        let any = false;
        g.querySelectorAll('.feat-card').forEach(c => { const ok = hit(c.textContent); c.hidden = !ok; if (ok) { any = true; shown++; } });
        g.hidden = !any;
      });
      document.getElementById('feat-empty').hidden = shown > 0;
    }
    document.addEventListener('keydown', e => {
      const box = document.getElementById('feat-search');
      if (e.key === '/' && box && box.offsetParent && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); box.focus(); }
      if (e.key === 'Escape' && document.activeElement === box) { box.value = ''; filterFeatures(''); box.blur(); }
    });

    function renderFeatures() {
      if (!featuresBuilt) {
        featuresBuilt = true;
        document.getElementById('quick-row').innerHTML = QUICK.map((q, i) => '<button class="btn btn-secondary btn-sm" title="' + esc(q[2]) + '" data-cmd="' + esc(q[1].join(' ')) + '" onclick="runQuick(' + i + ')">' + esc(q[0]) + '</button>').join('');
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

    // what each setting does, shown by the ⓘ button; the short line next to it comes from swap.js SETTINGS
    const HELP = {
      'auto.enabled': 'Trước mỗi prompt, plugin kiểm tra quota của profile đang dùng. Khi chạm ngưỡng (auto.threshold) hoặc bị giới hạn 429, nó tự chuyển sang profile còn nhiều quota nhất. Tắt thì chỉ cảnh báo và gợi ý profile kế tiếp.',
      'auto.threshold': '% quota 5 giờ của profile hiện tại mà khi đạt tới thì tự chuyển. Ví dụ 95: dùng tới 95% rồi đổi. Thấp hơn thì đổi sớm và chừa dư cho profile đó; cao hơn thì tận dụng gần hết.',
      'auto.safeguard': 'Không chuyển sang profile có quota 7 ngày từ mức này trở lên, để khỏi đốt cạn hạn mức tuần của nó. 0 = không xét 7 ngày.',
      'auto.step': 'Luân phiên theo lượt: mỗi profile được dùng thêm N% quota 5 giờ (tính từ lúc bắt đầu lượt), rồi nhường cho profile kế tiếp theo auto.order hoặc theo tên. Giúp dàn đều mức dùng. Khi bật, auto-return tạm ngưng. 0 = tắt.',
      'auto.forecast': 'Dựa vào tốc độ tiêu thụ gần đây: nếu dự báo sẽ chạm ngưỡng trong N phút tới thì chuyển luôn, không đợi chạm. Số liệu cũ hơn 20 phút bị bỏ qua. 0 = tắt.',
      'auto.confirm': 'Mỗi lần auto-switch định đổi profile, Claude Code hỏi Có/Không trước. Chọn Không thì lần đổi đó được hoãn 15 phút.',
      'swap.guard': 'Đổi tài khoản áp dụng cho mọi session Claude trên máy. Khi bật: nếu session khác vừa dùng profile hiện tại trong 15 phút qua, lệnh đổi tay bị chặn (cần --force) và có cảnh báo. Tắt: đổi luôn. Auto-switch thì luôn đợi.',
      'auto.return': 'Đang ở profile khác mà profile chính (auto.primary) đã hồi quota 5 giờ thì tự quay về profile chính.',
      'auto.primary': 'Profile "nhà" mà auto.return quay về. Để trống = tự động.',
      'auto.pool': 'Khi tự chuyển, chỉ chọn trong các profile mang tag này (gắn tag ở tab Tính năng). Trống hoặc "all" = mọi profile.',
      'auto.order': 'Tên các profile cách nhau dấu phẩy, vd: work,personal,backup. Auto-switch thử theo thứ tự này thay vì chọn profile ít dùng nhất. Bị bỏ qua khi bật cân bằng tải.',
      'balance': 'off: tắt. least-used: luôn chọn profile có % 5 giờ thấp nhất. round-robin: lần lượt sang profile kế tiếp theo tên. Khi bật, auto.order bị bỏ qua.',
      'balance.pool': 'Chỉ cân bằng giữa các profile mang tag này. Trống hoặc "all" = mọi profile.',
      'statusline': 'band: dải màu phía trên ô nhập của Claude Code (profile, % 5 giờ/7 ngày, giờ reset, nút đổi nhanh). line: một dòng chữ thường. off: ẩn.',
      'notify': 'Hiện thông báo desktop của hệ điều hành mỗi khi profile được đổi, bằng tay hay tự động.',
      'mask': 'Che email thành us***@domain.com trong /profile list, status line và dashboard. Hữu ích khi chia sẻ màn hình.',
      'repair.auto': '6 giờ một lần, ở nền, chạy một lệnh claude rất nhỏ (model haiku) cho profile có token hết hạn để làm mới, khỏi phải /login lại.',
      'update.auto': '6 giờ một lần, khi mở Claude Code, tự kiểm tra và cập nhật plugin claude-swap lên bản mới nhất.',
      'lang': 'Ngôn ngữ thông báo của plugin: vi (Tiếng Việt) hoặc en (English).',
      'webhook': 'Gửi cảnh báo ra ngoài: gần hết quota, khi tự đổi profile, khi một profile mất đăng nhập. Telegram: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>. Discord/Slack: URL incoming webhook của kênh. Generic: URL bất kỳ nhận POST JSON.',
    };
    function infoBtn(key) {
      return '<button type="button" class="info-btn" data-help="' + esc(key) + '" title="Giải thích ' + esc(key) + '" aria-label="Giải thích ' + esc(key) + '">ℹ</button>';
    }
    document.addEventListener('click', e => {
      const pop = document.getElementById('help-pop');
      const btn = e.target.closest && e.target.closest('.info-btn');
      document.querySelectorAll('.info-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
      if (!btn) { if (!pop.contains(e.target)) pop.classList.remove('show'); return; }
      e.preventDefault(); // a button inside a switch label must not flip the switch
      if (pop.classList.contains('show') && pop.dataset.key === btn.dataset.help) { pop.classList.remove('show'); return; }
      const key = btn.dataset.help;
      pop.dataset.key = key;
      pop.innerHTML = '<b>' + esc(key) + '</b>' + esc(HELP[key] || 'Chưa có giải thích.');
      pop.classList.add('show');
      btn.setAttribute('aria-expanded', 'true');
      const r = btn.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left - 12, window.innerWidth - pop.offsetWidth - 8));
      const below = r.bottom + 8 + pop.offsetHeight < window.innerHeight;
      pop.style.left = left + 'px';
      pop.style.top = (below ? r.bottom + 8 : r.top - pop.offsetHeight - 8) + 'px';
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('help-pop').classList.remove('show'); });
    document.addEventListener('scroll', () => document.getElementById('help-pop').classList.remove('show'), true);

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

    // "Toàn bộ cài đặt" and "Cấu hình đang có": redrawn only when the data changes, so the 5s poll keeps what is being typed
    let allSettingsKey = '', featureItemsKey = '';
    function renderAllSettings() {
      const sKey = JSON.stringify(appData.settingsList), fKey = JSON.stringify(appData.featureItems);
      if (sKey !== allSettingsKey) renderSettingRows(sKey);
      if (fKey !== featureItemsKey) renderFeatureItems(fKey);
    }

    function renderSettingRows(key) {
      allSettingsKey = key;
      document.getElementById('all-settings').innerHTML = (appData.settingsList || []).map((r, i) => {
        const attrs = ' data-i="' + i + '" onchange="setSettingEl(this)"';
        let ctl;
        if (r.type === 'bool') {
          ctl = '<label class="form-switch"><input type="checkbox"' + attrs + (r.value ? ' checked' : '') + '><span class="switch-slider"></span><span>' + (r.value ? 'Bật' : 'Tắt') + '</span></label>';
        } else if (r.type === 'choice') {
          ctl = '<select class="form-control"' + attrs + '>' + (r.choices || []).map(c => '<option value="' + esc(c) + '"' + (String(r.value) === c ? ' selected' : '') + '>' + esc(c || '(không)') + '</option>').join('') + '</select>';
        } else {
          ctl = '<input class="form-control" type="' + (r.type === 'number' ? 'number' : 'text') + '" value="' + esc(r.value) + '" placeholder="—"' + attrs + '>';
        }
        return '<div class="setting-row"><div><div class="ft">' + esc(r.key) + ' ' + infoBtn(r.key) + '</div><div class="fd">' + esc(r.desc) + '</div></div><div>' + ctl + '</div></div>';
      }).join('');
    }

    function renderFeatureItems(key) {
      featureItemsKey = key;
      document.getElementById('feature-items').innerHTML = (appData.featureItems || []).map(f =>
        '<div class="fi-group"><div class="ft">' + esc(f.title) + (f.items.length ? ' (' + f.items.length + ')' : '') + '</div>' +
        (f.items.length ? f.items.map(it => '<div class="fi-row"><span>' + esc(it.text) + '</span>' +
          (it.remove ? '<button class="btn btn-sm btn-danger" data-args="' + esc(JSON.stringify(it.remove)) + '" onclick="removeItem(this)">✕ Gỡ</button>' : '') + '</div>').join('')
          : '<div class="fd">chưa có</div>') + '</div>'
      ).join('');
    }

    async function cliToast(args) {
      try {
        const res = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cli', args }) });
        const data = await res.json();
        showToast((data.ok ? '' : '⚠ ') + String(data.output || data.error || 'OK').split(String.fromCharCode(10))[0]);
      } catch (err) {
        showToast('Lỗi: ' + err.message);
      }
      allSettingsKey = featureItemsKey = '';
      loadData();
    }

    function setSettingEl(el) {
      const r = appData.settingsList[Number(el.dataset.i)];
      cliToast(['settings', 'set', r.key, el.type === 'checkbox' ? (el.checked ? 'on' : 'off') : el.value.trim()]);
    }

    function removeItem(el) {
      cliToast(JSON.parse(el.dataset.args));
    }

    async function doSwap(name, force) {
      try {
        const res = await api('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'swap', profile: name, force: !!force })
        });
        const data = await res.json();
        if (data.ok) {
          showToast('Đã chuyển sang: ' + name);
          loadData();
        } else {
          showToast('Lỗi: ' + data.error);
        }
      } catch (err) {
        // matches the live-session refusal of swap.js runCliInner 'swap'
        if (!force && /phiên khác đang dùng/.test(err.message)) {
          if (confirm(err.message + ' Vẫn chuyển sang ' + name + '?')) doSwap(name, true);
          return;
        }
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

    // Auto-refresh every 5 seconds while the tab is visible, and at once when it comes back
    setInterval(() => { if (!document.hidden) loadData(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData(); });
    loadData();

    // Emoji -> inline SVG (Lucide-style outlines, drawn in currentColor). Every text node is rewritten after each
    // render by the observer below, so the strings that build the page and the labels swap.js sends need no change.
    // An emoji with no entry stays as text.
    const dot = c => '<circle cx="12" cy="12" r="7" fill="' + c + '" stroke="none"/>';
    const ICONS = {
      '🤖': '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
      '⚙': '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
      '🔔': '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
      '📊': '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
      '📈': '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
      '🧰': '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
      '📁': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
      '⚖': '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
      '🟢': dot('#10b981'), '🟡': dot('#f59e0b'), '🟠': dot('#f97316'), '🔴': dot('#ef4444'), '⚪': dot('#cbd5e1'),
      '👤': '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
      '✓': '<path d="M20 6 9 17l-5-5"/>',
      '✅': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
      '🔀': '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
      '➕': '<path d="M5 12h14"/><path d="M12 5v14"/>',
      '✕': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
      '💰': '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
      '📋': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
      '🌿': '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
      '🔐': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
      '⏱': '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
      '🏷': '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
      '⚠': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
      '💻': '<rect width="18" height="12" x="3" y="4" rx="2" ry="2"/><line x1="2" x2="22" y1="20" y2="20"/>',
      '📖': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
      '🌐': '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
      '📜': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
      '👀': '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
      '🧩': '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
      '🧪': '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
      '💾': '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
      '🔍': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
      '🚀': '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
      '🔄': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
      '🩺': '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
      '🧹': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
      '🔧': '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>',
      '🗓': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
      '🔤': '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
      '🚫': '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
      '🧠': '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
      '🛡': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
      '⏳': '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
      '🎯': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
      '🚧': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
      '🔂': '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>',
      '🔁': '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
      '⭐': '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
      '👥': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      '🔢': '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
      '🙈': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
      '⬆': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
      '🔖': '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
      'ℹ': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
      '▶': '<polygon points="6 3 20 12 6 21 6 3"/>',
      '🗑': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
      '📅': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    };
    const ICON_KEYS = Object.keys(ICONS).sort((a, b) => b.length - a.length);
    const VS16 = String.fromCharCode(0xfe0f);
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const NO_ICON_IN = { OPTION: 1, TEXTAREA: 1, SCRIPT: 1, STYLE: 1, TITLE: 1 };

    function iconEl(key) {
      const s = document.createElementNS(SVG_NS, 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      s.setAttribute('class', 'ic');
      s.setAttribute('aria-hidden', 'true');
      s.innerHTML = ICONS[key];
      return s;
    }

    function svgify(root) {
      const found = [];
      const take = n => {
        const p = n.parentNode;
        if (p && !NO_ICON_IN[p.nodeName] && !(p instanceof SVGElement)) found.push(n);
      };
      if (root.nodeType === 3) {
        take(root);
      } else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) take(n);
      }
      for (const node of found) {
        const text = node.nodeValue.split(VS16).join('');
        const parts = [];
        let buf = '';
        let hit = false;
        for (let i = 0; i < text.length;) {
          const key = ICON_KEYS.find(k => text.startsWith(k, i));
          if (key) {
            if (buf) parts.push(document.createTextNode(buf));
            buf = '';
            parts.push(iconEl(key));
            i += key.length;
            hit = true;
          } else {
            buf += text[i++];
          }
        }
        if (!hit) continue;
        if (buf) parts.push(document.createTextNode(buf));
        const parent = node.parentNode;
        for (const part of parts) parent.insertBefore(part, node);
        parent.removeChild(node);
        // a button that is now only an icon still needs a name
        if (parent.nodeName === 'BUTTON' && !parent.textContent.trim() && !parent.getAttribute('aria-label')) {
          parent.setAttribute('aria-label', parent.getAttribute('title') || 'icon');
        }
      }
    }

    // only what a render just added is rewritten, in the observer's own microtask, so no frame shows the emoji
    const svgifyObserver = new MutationObserver(records => {
      const roots = new Set();
      for (const r of records) {
        if (r.type === 'characterData') roots.add(r.target);
        for (const n of r.addedNodes) roots.add(n);
      }
      svgifyObserver.disconnect();
      for (const n of roots) if (n.isConnected) svgify(n);
      svgifyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    svgify(document.body);
    svgifyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
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
    let url
    try {
      url = new URL(req.url, `http://${HOST}:${port}`)
    } catch {
      // a malformed request target would otherwise be an unhandled rejection that kills the server
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad Request')
      return
    }

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
            // swap and delete go through the CLI, so the dashboard gets the same checks: another live session, a full
            // quota window, a login no profile holds (saved first), the only profile holding an account
            case 'swap':
            case 'delete': {
              const args = [action, String(body.profile ?? '')]
              if (action === 'swap' && body.force === true) args.push('--force')
              const ran = await runSwapCli(home, args)
              res.writeHead(ran.code === 0 ? 200 : 400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(ran.code === 0 ? { ok: true, output: ran.output } : { error: ran.output.replace(/^❌ Lỗi:\s*/, '').trim() }))
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
            case 'add_profile': {
              if (body.token) {
                // '-' would make addTokenProfile read the server's stdin, which blocks it on a terminal
                if (typeof body.token !== 'string' || body.token.trim() === '-') {
                  res.writeHead(400, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ error: 'Token không hợp lệ.' }))
                  return
                }
                addTokenProfile(home, body.token, body.name)
              } else {
                // through the CLI: an existing name is refused instead of silently overwritten
                const ran = await runSwapCli(home, ['new', String(body.name ?? '')])
                if (ran.code !== 0) {
                  res.writeHead(400, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ error: ran.output.replace(/^❌ Lỗi:\s*/, '').trim() }))
                  return
                }
              }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }
            case 'save_config': {
              // each field goes through the setting it edits, with that setting's validation: no other key can be
              // written, and an empty number field is refused instead of stored as null (which turned auto-switch off).
              // Every field that can be refused goes first, so a bad one fails before anything is saved; the on/off
              // switches, which cannot fail, come last.
              const a = body.auto
              const b = body.balance
              if (a) {
                setSetting(home, 'auto.threshold', String(a.threshold))
                setSetting(home, 'auto.safeguard', String(a.safeguard || 0))
                setSetting(home, 'auto.primary', typeof a.primary === 'string' ? a.primary : '')
                setSetting(home, 'auto.pool', typeof a.pool === 'string' ? a.pool : '')
              }
              if (b) setSetting(home, 'balance', b.enabled === true ? String(b.mode || 'least-used') : 'off')
              if (a) {
                setSetting(home, 'auto.enabled', a.enabled === true ? 'on' : 'off')
                setSetting(home, 'auto.return', a.autoReturn === true ? 'on' : 'off')
              }
              if (b) {
                const pool = typeof b.pool === 'string' && b.pool.trim() ? b.pool.trim() : 'all'
                saveBalanceConfig(home, { ...loadBalanceConfig(home), pool })
              }
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
            case 'pick_path': {
              const picked = await pickPath(String(body.mode))
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true, path: picked }))
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
  if (!server.listening) throw new Error(`Không còn cổng trống từ ${initialPort} đến ${port - 1}.`)

  atomicWrite(pf, JSON.stringify({ pid: process.pid, port, token, started: Date.now() }))
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
