#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import child_process from 'node:child_process'
import crypto from 'node:crypto'

export const AUTH_KEYS = ['oauthAccount', 'primaryApiKey', 'customApiKeyResponses']
export const KEYCHAIN_SERVICE = 'Claude Code-credentials'
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
export const WARN_PCT = 80
export const USAGE_TTL = 300 // seconds
export const USAGE_BACKOFF = 600 // seconds
export const USAGE_LIMITS = [
  ['five_hour', '5 giờ'],
  ['seven_day', '7 ngày'],
  ['seven_day_opus', '7 ngày Opus'],
  ['seven_day_sonnet', '7 ngày Sonnet'],
]
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export class SwapError extends Error {}
export class ProfileExists extends SwapError {}

// ---------------------------------------------------------------- paths

export function claudeJson(home) {
  return path.join(home, '.claude.json')
}

export function credentialsFile(home) {
  return path.join(home, '.claude', '.credentials.json')
}

export function profilesDir(home) {
  const d = path.join(home, '.config', 'claude-cli-profiles')
  fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(d, 0o700)
  } catch {}
  return d
}

export function checkName(name) {
  if (!name || !NAME_RE.test(name)) {
    throw new SwapError(`Tên profile không hợp lệ: '${name}' (chỉ dùng chữ, số, _ . -)`)
  }
  return name
}

export function profilePath(home, name) {
  return path.join(profilesDir(home), `${checkName(name)}.json`)
}

export function atomicWrite(filePath, text, mode = 0o600) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  )
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf-8', mode })
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

export function backup(filePath) {
  if (fs.existsSync(filePath)) {
    const bak = `${filePath}.bak`
    fs.copyFileSync(filePath, bak)
    try {
      fs.chmodSync(bak, 0o600)
    } catch {}
  }
}

// ---------------------------------------------------------------- credentials

export function useKeychain(home) {
  return process.platform === 'darwin' && !fs.existsSync(credentialsFile(home))
}

export function readCredentials(home) {
  if (useKeychain(home)) {
    try {
      const res = child_process.execFileSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      return res.trim() || null
    } catch {
      return null
    }
  }
  const f = credentialsFile(home)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null
}

export function writeCredentials(home, data) {
  if (useKeychain(home)) {
    const user = os.userInfo().username
    try {
      child_process.execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', user, '-w', data],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      throw new SwapError(`Không ghi được Keychain: ${err.message}`)
    }
    return
  }
  const f = credentialsFile(home)
  backup(f)
  atomicWrite(f, data)
}

export function clearCredentials(home) {
  if (useKeychain(home)) {
    try {
      child_process.execFileSync(
        'security',
        ['delete-generic-password', '-s', KEYCHAIN_SERVICE],
        { stdio: 'ignore' }
      )
    } catch {}
    return
  }
  const f = credentialsFile(home)
  backup(f)
  if (fs.existsSync(f)) {
    try {
      fs.unlinkSync(f)
    } catch {}
  }
}

// ---------------------------------------------------------------- claude.json & profiles

export function loadClaudeJson(home) {
  const p = claudeJson(home)
  if (!fs.existsSync(p)) {
    throw new SwapError(`Không tìm thấy ${p}.\nHãy chạy \`claude\` và đăng nhập (/login) trước.`)
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (err) {
    throw new SwapError(`${p} bị hỏng JSON: ${err.message}`)
  }
}

export function listProfiles(home) {
  const dir = profilesDir(home)
  try {
    const files = fs.readdirSync(dir)
    return files
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => f.slice(0, -5))
      .filter(name => NAME_RE.test(name))
      .sort()
  } catch {
    return []
  }
}

export function readCurrent(home) {
  const f = path.join(profilesDir(home), '.current')
  try {
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim() : ''
  } catch {
    return ''
  }
}

export function currentProfile(home) {
  const name = readCurrent(home)
  if (!name) return null
  return fs.existsSync(profilePath(home, name)) ? name : null
}

export function setCurrent(home, name) {
  const f = path.join(profilesDir(home), '.current')
  if (name) {
    atomicWrite(f, name)
  } else if (fs.existsSync(f)) {
    try {
      fs.unlinkSync(f)
    } catch {}
  }
}

export function profileEmail(home, name) {
  try {
    const data = JSON.parse(fs.readFileSync(profilePath(home, name), 'utf-8'))
    return data.claude_json?.oauthAccount?.emailAddress || ''
  } catch {
    return ''
  }
}

export function accountId(oauthAccount) {
  if (!oauthAccount || typeof oauthAccount !== 'object') return null
  return oauthAccount.accountUuid || oauthAccount.emailAddress || null
}

export function profileExists(home, name) {
  try {
    return fs.existsSync(profilePath(home, name))
  } catch {
    return false
  }
}

export function saveProfile(home, name, force = false) {
  const target = profilePath(home, name)
  if (fs.existsSync(target) && !force) {
    throw new ProfileExists(`Profile '${name}' đã tồn tại.`)
  }
  const data = loadClaudeJson(home)
  const auth = {}
  for (const k of AUTH_KEYS) {
    if (k in data) {
      auth[k] = data[k]
    }
  }
  let existingTags = []
  if (fs.existsSync(target)) {
    try {
      const old = JSON.parse(fs.readFileSync(target, 'utf-8'))
      if (Array.isArray(old.tags)) existingTags = old.tags
    } catch {}
  }
  const profile = {
    claude_json: auth,
    credentials: readCredentials(home),
    tags: existingTags,
  }
  if (Object.keys(profile.claude_json).length === 0 && !profile.credentials) {
    throw new SwapError('Không thấy thông tin đăng nhập nào. Hãy /login trong Claude CLI trước.')
  }
  atomicWrite(target, JSON.stringify(profile, null, 2))
  setCurrent(home, name)
  return target
}

export function swapProfile(home, name, options = {}) {
  const src = profilePath(home, name)
  if (!fs.existsSync(src)) {
    throw new SwapError(`Không có profile '${name}'.`)
  }
  let profile
  try {
    profile = JSON.parse(fs.readFileSync(src, 'utf-8'))
    if (!profile || typeof profile !== 'object' || !profile.claude_json) {
      throw new Error('thiếu trường claude_json')
    }
  } catch (err) {
    throw new SwapError(`File profile '${name}' bị hỏng: ${err.message}`)
  }

  const cj = claudeJson(home)
  const data = fs.existsSync(cj) ? loadClaudeJson(home) : {}
  const cur = currentProfile(home)
  if (cur) {
    let curId = null
    try {
      const curProfile = JSON.parse(fs.readFileSync(profilePath(home, cur), 'utf-8'))
      curId = accountId(curProfile.claude_json?.oauthAccount)
    } catch {}
    if (curId && curId === accountId(data.oauthAccount)) {
      saveProfile(home, cur, true)
      if (cur === name) {
        return
      }
    }
  }

  for (const k of AUTH_KEYS) {
    delete data[k]
  }
  for (const k of AUTH_KEYS) {
    if (k in profile.claude_json) {
      data[k] = profile.claude_json[k]
    }
  }

  backup(cj)
  atomicWrite(cj, JSON.stringify(data, null, 2))

  if (profile.credentials) {
    writeCredentials(home, profile.credentials)
  } else {
    clearCredentials(home)
  }
  setCurrent(home, name)

  recordSwapHistory(home, {
    timestamp: new Date().toISOString(),
    from: cur || '(none)',
    to: name,
    type: options.type || 'manual',
    reason: options.reason || '',
    cwd: options.cwd || process.cwd(),
  })
}

// ---------------------------------------------------------------- history & stats

export function swapHistoryFile(home) {
  return path.join(profilesDir(home), '.swap-history.json')
}

export function loadSwapHistory(home) {
  const f = swapHistoryFile(home)
  try {
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      if (Array.isArray(data)) return data
    }
  } catch {}
  return []
}

export function recordSwapHistory(home, entry) {
  const list = loadSwapHistory(home)
  list.unshift({
    timestamp: entry.timestamp || new Date().toISOString(),
    from: entry.from || '(none)',
    to: entry.to || '',
    type: entry.type || 'manual',
    reason: entry.reason || '',
    cwd: entry.cwd || process.cwd(),
  })
  if (list.length > 100) {
    list.length = 100
  }
  atomicWrite(swapHistoryFile(home), JSON.stringify(list, null, 2))
}

export function formatSwapHistory(home, limit = 10) {
  const list = loadSwapHistory(home)
  if (list.length === 0) {
    return 'Chưa có lịch sử chuyển profile.'
  }
  const slice = list.slice(0, limit)
  const lines = ['📜 Lịch sử chuyển profile gần nhất:']
  for (const item of slice) {
    const time = new Date(item.timestamp).toLocaleString('vi-VN')
    const typeTag = item.type === 'auto' ? '🤖 [auto]' : item.type === 'project' ? '📁 [project]' : '👤 [manual]'
    const reasonText = item.reason ? ` (${item.reason})` : ''
    lines.push(`• ${time} | ${typeTag} ${item.from} ➔ ${item.to}${reasonText}`)
  }
  return lines.join('\n')
}

export function formatSwapStats(home) {
  const list = loadSwapHistory(home)
  if (list.length === 0) {
    return 'Chưa có dữ liệu thống kê chuyển profile.'
  }
  let manual = 0
  let auto = 0
  let project = 0
  const toCounts = {}
  for (const item of list) {
    if (item.type === 'auto') auto++
    else if (item.type === 'project') project++
    else manual++
    if (item.to) {
      toCounts[item.to] = (toCounts[item.to] || 0) + 1
    }
  }
  const sortedProfiles = Object.entries(toCounts).sort((a, b) => b[1] - a[1])
  const topStr = sortedProfiles.map(([name, count]) => `${name} (${count})`).join(', ')

  return [
    '📊 Thống kê chuyển đổi profile:',
    `- Tổng số lần chuyển: ${list.length}`,
    `- Thủ công (manual): ${manual}`,
    `- Tự động (auto): ${auto}`,
    `- Theo dự án (project): ${project}`,
    `- Profile được chuyển đến nhiều nhất: ${topStr || '(chưa có)'}`,
  ].join('\n')
}

export function deleteProfile(home, name) {
  const f = profilePath(home, name)
  if (!fs.existsSync(f)) {
    throw new SwapError(`Không có profile '${name}'.`)
  }
  fs.unlinkSync(f)
  if (readCurrent(home) === name) {
    setCurrent(home, null)
  }
}

export function openProfilesFolder(home) {
  const d = profilesDir(home)
  if (process.platform === 'win32') {
    child_process.spawn('explorer', [d], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'darwin') {
    child_process.spawn('open', [d], { detached: true, stdio: 'ignore' }).unref()
  } else {
    child_process.spawn('xdg-open', [d], { detached: true, stdio: 'ignore' }).unref()
  }
  return d
}

// ---------------------------------------------------------------- tags

export function getProfileTags(home, name) {
  try {
    const f = profilePath(home, name)
    if (!fs.existsSync(f)) return []
    const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
    return Array.isArray(data.tags) ? data.tags : []
  } catch {
    return []
  }
}

export function addProfileTag(home, name, tag) {
  if (!tag) throw new SwapError('Thiếu tên tag.')
  const f = profilePath(home, name)
  if (!fs.existsSync(f)) throw new SwapError(`Profile '${name}' không tồn tại.`)
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
  const tags = new Set(Array.isArray(data.tags) ? data.tags : [])
  tags.add(tag.trim())
  data.tags = Array.from(tags)
  atomicWrite(f, JSON.stringify(data, null, 2))
  return data.tags
}

export function removeProfileTag(home, name, tag) {
  const f = profilePath(home, name)
  if (!fs.existsSync(f)) throw new SwapError(`Profile '${name}' không tồn tại.`)
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
  data.tags = (Array.isArray(data.tags) ? data.tags : []).filter(t => t !== tag.trim())
  atomicWrite(f, JSON.stringify(data, null, 2))
  return data.tags
}

export function listAllTags(home) {
  const map = {}
  for (const name of listProfiles(home)) {
    const tags = getProfileTags(home, name)
    for (const t of tags) {
      if (!map[t]) map[t] = []
      map[t].push(name)
    }
  }
  return map
}

// ---------------------------------------------------------------- import

function profileFromClaudeDir(folder) {
  const candCreds = [
    path.join(folder, '.credentials.json'),
    path.join(folder, '.claude', '.credentials.json'),
  ]
  const creds = candCreds.find(p => fs.existsSync(p) && fs.statSync(p).isFile())
  const cj = path.join(folder, '.claude.json')
  const auth = {}
  if (fs.existsSync(cj)) {
    try {
      const data = JSON.parse(fs.readFileSync(cj, 'utf-8'))
      if (data && typeof data === 'object') {
        for (const k of AUTH_KEYS) {
          if (k in data) auth[k] = data[k]
        }
      }
    } catch {}
  }
  const text = creds ? fs.readFileSync(creds, 'utf-8') : null
  if (Object.keys(auth).length === 0 && !text) return null
  return { claude_json: auth, credentials: text }
}

function nameFromFolder(folder) {
  const base = path.basename(folder).replace(/^\.+/, '')
  const sanitized = base.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64)
  return NAME_RE.test(sanitized) ? sanitized : 'imported'
}

export function importProfiles(home, folderPath, overwrite = false) {
  const expanded = folderPath.startsWith('~')
    ? path.join(os.homedir(), folderPath.slice(1))
    : folderPath
  const folder = path.resolve(expanded)
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new SwapError(`Không phải thư mục: ${folderPath}`)
  }
  const result = { added: [], exists: [], invalid: [] }
  if (path.resolve(folder) === path.resolve(profilesDir(home))) {
    return result
  }

  const raw = profileFromClaudeDir(folder)
  if (raw) {
    const name = nameFromFolder(folder)
    const target = profilePath(home, name)
    if (fs.existsSync(target) && !overwrite) {
      result.exists.push(name)
    } else {
      atomicWrite(target, JSON.stringify(raw, null, 2))
      result.added.push(name)
    }
  }

  let candidates = []
  try {
    candidates = fs.readdirSync(folder).filter(f => f.endsWith('.json'))
  } catch (err) {
    throw new SwapError(`Không đọc được thư mục ${folderPath}: ${err.message}`)
  }

  for (const file of candidates) {
    if (file === '.claude.json' || file === '.credentials.json') continue
    const fullPath = path.join(folder, file)
    let ok = false
    let data = null
    const stem = file.slice(0, -5)
    try {
      data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
      ok =
        NAME_RE.test(stem) &&
        data &&
        typeof data === 'object' &&
        data.claude_json &&
        typeof data.claude_json === 'object' &&
        (typeof data.credentials === 'string' || data.credentials === null || data.credentials === undefined)
    } catch {
      ok = false
    }

    if (!ok) {
      result.invalid.push(file)
      continue
    }

    const target = profilePath(home, stem)
    if (fs.existsSync(target) && !overwrite) {
      result.exists.push(stem)
      continue
    }
    atomicWrite(target, JSON.stringify(data, null, 2))
    result.added.push(stem)
  }

  return result
}

// ---------------------------------------------------------------- usage

export async function fetchUsage(token) {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-swap',
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    err.headers = res.headers
    throw err
  }
  return await res.json()
}

export function fmtReset(value) {
  if (!value) return ''
  try {
    const d = new Date(value)
    if (isNaN(d.getTime())) return ''
    const day = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    return `${day}/${month} ${hours}:${mins}`
  } catch {
    return ''
  }
}

export function parseLimits(data) {
  if (!data || typeof data !== 'object') return []
  const out = new Map()
  for (const [key, label] of USAGE_LIMITS) {
    const lim = data[key]
    if (lim && typeof lim === 'object' && lim.utilization !== undefined && lim.utilization !== null) {
      out.set(label, [label, Number(lim.utilization), fmtReset(lim.resets_at)])
    }
  }
  const limitsArr = Array.isArray(data.limits) ? data.limits : []
  for (const lim of limitsArr) {
    if (!lim || typeof lim !== 'object' || lim.kind !== 'weekly_scoped' || lim.percent === undefined) {
      continue
    }
    const model = lim.scope?.model?.display_name
    if (model) {
      const label = `7 ngày ${model}`
      out.set(label, [label, Number(lim.percent), fmtReset(lim.resets_at)])
    }
  }
  return Array.from(out.values())
}

export function usageCacheFile(home) {
  return path.join(profilesDir(home), '.usage-cache.json')
}

export function loadUsageCache(home) {
  const f = usageCacheFile(home)
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {}
  } catch {
    return {}
  }
}

function retryAfter(headers) {
  try {
    const val = headers?.get?.('Retry-After')
    if (val) {
      return Math.min(Math.max(parseFloat(val), 30), 3600)
    }
  } catch {}
  return USAGE_BACKOFF
}

function rateLimitedNote(hit, hasData) {
  const hhmm = ts => {
    const d = new Date(ts * 1000)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  let note = `Anthropic đang giới hạn tần suất (HTTP 429), thử lại sau ${hhmm(hit.retry_at)}`
  if (hasData && hit.at) {
    note += ` — đang hiện số liệu lúc ${hhmm(hit.at)}`
  }
  return note
}

export async function profileUsage(
  home,
  name,
  active,
  fetchFn = fetchUsage,
  cache = {},
  force = false
) {
  const row = { name, active, email: '', limits: [], note: '' }
  let token = null
  let expires = null
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath(home, name), 'utf-8'))
    const creds = active ? readCredentials(home) : profile.credentials
    const oauth = JSON.parse(creds || '{}').claudeAiOauth || {}
    token = oauth.accessToken
    expires = oauth.expiresAt
  } catch {
    return { ...row, note: 'file profile bị hỏng' }
  }

  row.email = profileEmail(home, name)
  if (!token) {
    return { ...row, note: 'không có token OAuth (API key không có quota gói)' }
  }
  if (typeof expires === 'number' && expires / 1000 < Date.now() / 1000) {
    return {
      ...row,
      note: `token đã hết hạn — chuyển sang profile này (swap ${name}) để CLI làm mới`,
    }
  }

  const key = `${name}|${row.email}`
  const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}
  const cached = Array.isArray(hit.limits) ? hit.limits : []
  const now = Date.now() / 1000

  if (hit.retry_at && hit.retry_at > now) {
    return { ...row, limits: cached, note: rateLimitedNote(hit, cached.length > 0) }
  }
  if (cached.length > 0 && !force && now - (hit.at || 0) < USAGE_TTL) {
    return { ...row, limits: cached }
  }

  try {
    const data = await fetchFn(token)
    const limits = parseLimits(data)
    cache[key] = { limits, at: now }
    return { ...row, limits, note: limits.length ? '' : 'không có dữ liệu quota' }
  } catch (err) {
    if (err.status === 429) {
      hit.retry_at = now + retryAfter(err.headers)
      cache[key] = hit
      return { ...row, limits: cached, note: rateLimitedNote(hit, cached.length > 0) }
    }
    const note =
      err.status === 401
        ? 'lỗi HTTP 401 (token hết hạn/bị thu hồi)'
        : err.status
        ? `lỗi HTTP ${err.status}`
        : `lỗi mạng: ${err.message}`
    return { ...row, note }
  }
}

export async function usageRows(home, fetchFn = fetchUsage, force = false) {
  const cur = currentProfile(home)
  const cache = loadUsageCache(home)
  const profiles = listProfiles(home)
  const rows = await Promise.all(
    profiles.map(n => profileUsage(home, n, n === cur, fetchFn, cache, force))
  )
  try {
    atomicWrite(usageCacheFile(home), JSON.stringify(cache, null, 2))
  } catch {}
  return rows
}

export function bar(pct, width = 20) {
  const filled = Math.round((Math.max(0, Math.min(pct, 100)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function statusIcon(pct) {
  if (pct >= 95) return '🔴'
  if (pct >= WARN_PCT) return '🟠'
  if (pct >= 50) return '🟡'
  return '🟢'
}

export function shouldColor(color) {
  if (color !== undefined && color !== null) return Boolean(color)
  if (process.env.NO_COLOR) return false
  if (process.env.CLICOLOR === '0') return false
  return true
}

export function chartBar(pct, width = 8, color = false) {
  const filled = Math.round((Math.max(0, Math.min(pct, 100)) / 100) * width)
  const empty = width - filled
  if (!color) {
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
  }
  let c = '\x1b[1;32m'
  if (pct >= 95) c = '\x1b[1;31m'
  else if (pct >= WARN_PCT) c = '\x1b[1;38;5;208m'
  else if (pct >= 50) c = '\x1b[1;33m'
  return `\x1b[90m[\x1b[0m${c}${'█'.repeat(filled)}\x1b[0m\x1b[38;5;240m${'░'.repeat(empty)}\x1b[90m]\x1b[0m`
}

export function formatLimitChart(label, pct, color = false) {
  const lbl = label.replace('5 giờ', '5h').replace('7 ngày', '7d')
  const pctVal = Math.max(0, Math.min(Number(pct), 100))
  const pctInt = Math.round(pctVal)
  const barStr = chartBar(pctVal, 8, color)
  const warn = pctInt >= WARN_PCT ? ' ⚠' : ''
  if (!color) {
    return `${lbl} ${barStr} ${pctInt}%${warn}`
  }
  let c = '\x1b[1;32m'
  if (pctInt >= 95) c = '\x1b[1;31m'
  else if (pctInt >= WARN_PCT) c = '\x1b[1;38;5;208m'
  else if (pctInt >= 50) c = '\x1b[1;33m'
  const warnColored = pctInt >= WARN_PCT ? '\x1b[1;31m ⚠\x1b[0m' : ''
  return `\x1b[1;36m${lbl}\x1b[0m ${barStr} ${c}${pctInt}%\x1b[0m${warnColored}`
}

export function profileListReport(home, color = null) {
  const profiles = listProfiles(home)
  if (profiles.length === 0) {
    return 'Chưa có profile nào. Tạo bằng: /profile new <tên>'
  }
  const cur = currentProfile(home)
  const cache = loadUsageCache(home)
  const useColor = shouldColor(color)
  const lines = []

  for (const n of profiles) {
    const active = n === cur
    const email = profileEmail(home, n)
    const icon = active ? '🟢' : '⚪'
    const activeStr = active ? ' (Active)' : ''

    let summary = ''
    const key = `${n}|${email}`
    const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}
    const cachedLimits = Array.isArray(hit.limits) ? hit.limits : []
    if (cachedLimits.length > 0) {
      const charts = cachedLimits
        .slice(0, 2)
        .map(lim => formatLimitChart(lim[0], Number(lim[1]), useColor))
      if (charts.length) {
        summary = '  ' + charts.join('   ')
      }
    } else if (hit.note) {
      summary = useColor ? `  \x1b[38;5;214m(${hit.note})\x1b[0m` : `  (${hit.note})`
    }

    const emailStr = email ? `  👤 ${email}` : ''

    if (useColor) {
      const nameAndActive = active ? `${n} (Active)` : n
      const nameColored = active ? `\x1b[1;32m${nameAndActive}\x1b[0m` : `\x1b[1;37m${n}\x1b[0m`
      const emailColored = email ? `  \x1b[38;5;248m👤 ${email}\x1b[0m` : ''
      lines.push(`${icon} ${nameColored}${emailColored}${summary}`)
    } else {
      lines.push(`${icon} ${n}${activeStr}${emailStr}${summary}`)
    }
  }
  return lines.join('\n')
}

export async function usageReport(home, fetchFn = fetchUsage, force = false, color = false) {
  const rows = await usageRows(home, fetchFn, force)
  if (rows.length === 0) {
    return 'Chưa có profile nào.'
  }
  const lines = []
  for (const r of rows) {
    const { name, active, email } = r
    if (color) {
      const icon = active ? '🟢' : '⚪'
      const nameColored = active ? `\x1b[1;32m${name} (Active)\x1b[0m` : `\x1b[1;37m${name}\x1b[0m`
      const emailColored = email ? `  \x1b[38;5;248m👤 ${email}\x1b[0m` : ''
      lines.push(`${icon} ${nameColored}${emailColored}`)
    } else {
      lines.push(`${name}${active ? ' (Active)' : ''}  ${email}`.trimEnd())
    }

    for (const [label, pct, reset] of r.limits) {
      const icon = statusIcon(pct)
      const pctVal = Math.max(0, Math.min(Number(pct), 100))
      const pctInt = Math.round(pctVal)
      const warn = pctInt >= WARN_PCT ? ' ⚠' : ''
      const resetStr = reset ? `  reset ${reset}` : ''

      if (color) {
        let c = '\x1b[1;32m'
        if (pctVal >= 95) c = '\x1b[1;31m'
        else if (pctVal >= WARN_PCT) c = '\x1b[1;38;5;208m'
        else if (pctVal >= 50) c = '\x1b[1;33m'
        const filled = Math.round((pctVal / 100) * 20)
        const empty = 20 - filled
        const barColored = `\x1b[90m[\x1b[0m${c}${'█'.repeat(filled)}\x1b[0m\x1b[38;5;240m${'░'.repeat(empty)}\x1b[90m]\x1b[0m`
        const lblColored = `\x1b[1;36m${label.padEnd(12)}\x1b[0m`
        const pctColored = `${c}${String(pctInt).padStart(3)}%\x1b[0m`
        const warnColored = pctInt >= WARN_PCT ? '\x1b[1;31m ⚠\x1b[0m' : ''
        const resetColored = reset ? `  \x1b[38;5;245mreset ${reset}\x1b[0m` : ''
        lines.push(`  ${icon} ${lblColored} ${barColored} ${pctColored}${warnColored}${resetColored}`)
      } else {
        lines.push(`  ${icon} ${label.padEnd(12)}${bar(pct)} ${String(pctInt).padStart(3)}%${warn}${resetStr}`)
      }
    }

    if (r.note) {
      const noteStr = color ? `  \x1b[38;5;214m⚠ ${r.note}\x1b[0m` : `  ${r.note}`
      lines.push(noteStr)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- auto-switch

export function autoSwitchConfigFile(home) {
  return path.join(profilesDir(home), '.auto-switch.json')
}

export function loadAutoSwitchConfig(home) {
  const f = autoSwitchConfigFile(home)
  try {
    if (fs.existsSync(f)) {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
      return {
        enabled: parsed.enabled !== false,
        threshold: typeof parsed.threshold === 'number' ? parsed.threshold : 95,
        order: Array.isArray(parsed.order) ? parsed.order : [],
        pool: typeof parsed.pool === 'string' && parsed.pool !== 'all' ? parsed.pool : null,
      }
    }
  } catch {}
  return { enabled: true, threshold: 95, order: [], pool: null }
}

export function saveAutoSwitchConfig(home, config) {
  const f = autoSwitchConfigFile(home)
  atomicWrite(f, JSON.stringify(config, null, 2))
}

function parseResetTime(hit, lim) {
  if (hit?.resets_at_epoch) return Number(hit.resets_at_epoch)
  if (hit?.resets_at) {
    const t = new Date(hit.resets_at).getTime()
    if (!isNaN(t)) return t
  }
  if (lim && lim[2]) {
    const match = String(lim[2]).match(/(\d{1,2}):(\d{2})/)
    if (match) {
      const d = new Date()
      d.setHours(parseInt(match[1], 10), parseInt(match[2], 10), 0, 0)
      return d.getTime()
    }
  }
  return Number.MAX_SAFE_INTEGER
}

export function findNextProfile(home, options = {}) {
  const config = options.config || loadAutoSwitchConfig(home)
  const allProfiles = listProfiles(home)
  const cur = currentProfile(home)
  const cache = options.cache || loadUsageCache(home)

  const candidates = []
  for (const name of allProfiles) {
    if (name === cur) continue

    const email = profileEmail(home, name)
    const key = `${name}|${email}`
    const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}

    try {
      const profile = JSON.parse(fs.readFileSync(profilePath(home, name), 'utf-8'))
      if (config.pool && config.pool !== 'all') {
        const tags = Array.isArray(profile.tags) ? profile.tags : []
        if (!tags.includes(config.pool)) {
          continue
        }
      }
      const oauth = JSON.parse(profile.credentials || '{}').claudeAiOauth || {}
      if (!oauth.accessToken) continue
      if (typeof oauth.expiresAt === 'number' && oauth.expiresAt / 1000 < Date.now() / 1000) {
        continue
      }
    } catch {
      continue
    }

    const limits = Array.isArray(hit.limits) ? hit.limits : []
    const fiveHour = limits.find(l => l[0] === '5 giờ') || limits[0]
    const rawUtil = fiveHour ? Number(fiveHour[1]) : 0
    const util = rawUtil <= 1 && rawUtil > 0 ? rawUtil * 100 : rawUtil

    if (util >= config.threshold) {
      continue
    }

    const resetTime = parseResetTime(hit, fiveHour)
    candidates.push({ name, util, resetTime })
  }

  if (candidates.length === 0) {
    return null
  }

  if (config.order && config.order.length > 0) {
    for (const orderedName of config.order) {
      const found = candidates.find(c => c.name === orderedName)
      if (found) {
        return found.name
      }
    }
  }

  candidates.sort((a, b) => {
    if (a.util !== b.util) {
      return a.util - b.util
    }
    return a.resetTime - b.resetTime
  })

  return candidates[0].name
}

export async function autoCheckAndSwap(home, options = {}) {
  const config = options.config || loadAutoSwitchConfig(home)
  if (!config.enabled) {
    return { swapped: false, reason: 'disabled' }
  }

  const cur = currentProfile(home)
  if (!cur) {
    return { swapped: false, reason: 'no_current' }
  }

  const email = profileEmail(home, cur)
  const cache = options.cache || loadUsageCache(home)
  const key = `${cur}|${email}`
  const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}

  const limits = Array.isArray(hit.limits) ? hit.limits : []
  const fiveHour = limits.find(l => l[0] === '5 giờ') || limits[0]
  const rawUtil = fiveHour ? Number(fiveHour[1]) : 0
  const util = rawUtil <= 1 && rawUtil > 0 ? rawUtil * 100 : rawUtil

  const isRateLimited = Boolean(hit.retry_at && hit.retry_at > Date.now() / 1000)
  if (isRateLimited || util >= config.threshold) {
    const next = findNextProfile(home, { config, cache })
    if (next && next !== cur) {
      swapProfile(home, next, {
        type: 'auto',
        reason: isRateLimited ? 'Rate limited' : `Mức dùng ${util}% >= ngưỡng ${config.threshold}%`,
        cwd: process.cwd(),
      })
      sendNotification(home, 'claude-swap', `Đã chuyển sang '${next}' (mức dùng: ${util}% >= ngưỡng ${config.threshold}%)`)
      return {
        swapped: true,
        from: cur,
        to: next,
        util,
        threshold: config.threshold,
        rateLimited: isRateLimited,
      }
    }
    return {
      swapped: false,
      reason: 'no_candidate',
      current: cur,
      util,
      threshold: config.threshold,
    }
  }

  return {
    swapped: false,
    reason: 'below_threshold',
    current: cur,
    util,
    threshold: config.threshold,
  }
}

// ---------------------------------------------------------------- project-binding

export function projectBindingsFile(home) {
  return path.join(profilesDir(home), '.project-bindings.json')
}

export function loadProjectBindings(home) {
  const f = projectBindingsFile(home)
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {}
  } catch {
    return {}
  }
}

export function saveProjectBindings(home, bindings) {
  const f = projectBindingsFile(home)
  atomicWrite(f, JSON.stringify(bindings, null, 2))
}

export function bindProfile(home, projectDir, name) {
  if (!name) throw new SwapError('Thiếu tên profile để gán.')
  if (!profileExists(home, name)) {
    throw new SwapError(`Profile '${name}' không tồn tại.`)
  }
  const resolvedDir = path.resolve(projectDir || process.cwd())
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    throw new SwapError(`Thư mục dự án không hợp lệ: ${resolvedDir}`)
  }

  // 1. Write local .claude-profile in project directory
  try {
    fs.writeFileSync(path.join(resolvedDir, '.claude-profile'), name.trim() + '\n', 'utf-8')
  } catch {}

  // 2. Save in global registry
  const bindings = loadProjectBindings(home)
  bindings[resolvedDir] = name.trim()
  saveProjectBindings(home, bindings)
  return { dir: resolvedDir, profile: name.trim() }
}

export function unbindProfile(home, projectDir) {
  const resolvedDir = path.resolve(projectDir || process.cwd())
  const marker = path.join(resolvedDir, '.claude-profile')
  if (fs.existsSync(marker)) {
    try { fs.unlinkSync(marker) } catch {}
  }
  const bindings = loadProjectBindings(home)
  if (bindings[resolvedDir]) {
    delete bindings[resolvedDir]
    saveProjectBindings(home, bindings)
  }
  return { dir: resolvedDir }
}

export function getBoundProfile(home, startDir = process.cwd()) {
  let cur = path.resolve(startDir)
  const bindings = loadProjectBindings(home)

  while (true) {
    const marker = path.join(cur, '.claude-profile')
    if (fs.existsSync(marker)) {
      try {
        const name = fs.readFileSync(marker, 'utf-8').trim()
        if (name && profileExists(home, name)) {
          return { profile: name, source: 'local', dir: cur }
        }
      } catch {}
    }

    if (bindings[cur]) {
      const name = bindings[cur]
      if (name && profileExists(home, name)) {
        return { profile: name, source: 'global', dir: cur }
      }
    }

    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }

  return null
}

// ---------------------------------------------------------------- notifications

export function notificationConfigFile(home) {
  return path.join(profilesDir(home), '.notification-config.json')
}

export function loadNotificationConfig(home) {
  const f = notificationConfigFile(home)
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : { enabled: true }
  } catch {
    return { enabled: true }
  }
}

export function saveNotificationConfig(home, config) {
  const f = notificationConfigFile(home)
  atomicWrite(f, JSON.stringify(config, null, 2))
}

export function sendNotification(home, title, message) {
  const config = loadNotificationConfig(home)
  if (!config.enabled) return

  try {
    if (process.platform === 'linux') {
      child_process.spawn('notify-send', [title, message], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`
      child_process.spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'win32') {
      const psScript = `[reflection.assembly]::loadwithpartialname('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('${message.replace(/'/g, "''")}', '${title.replace(/'/g, "''")}')`
      child_process.spawn('powershell', ['-Command', psScript], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {}
}

// ---------------------------------------------------------------- encryption

export function exportEncryptedProfiles(home, targetPath, password) {
  if (!password) throw new SwapError('Vui lòng cung cấp mật khẩu mã hóa.')
  const profiles = {}
  for (const name of listProfiles(home)) {
    try {
      profiles[name] = JSON.parse(fs.readFileSync(profilePath(home, name), 'utf-8'))
    } catch {}
  }
  const payload = JSON.stringify({
    version: 1,
    profiles,
    autoSwitch: loadAutoSwitchConfig(home),
    projectBindings: loadProjectBindings(home),
  })

  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512')
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()

  const container = {
    format: 'claude-swap-encrypted',
    version: 1,
    kdf: 'pbkdf2-sha512',
    iterations: 100000,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  }

  const resolved = path.resolve(targetPath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, JSON.stringify(container, null, 2), 'utf-8')
  return { path: resolved, count: Object.keys(profiles).length }
}

export function importEncryptedProfiles(home, sourcePath, password, overwrite = false) {
  if (!password) throw new SwapError('Vui lòng cung cấp mật khẩu giải mã.')
  const resolved = path.resolve(sourcePath)
  if (!fs.existsSync(resolved)) {
    throw new SwapError(`Không tìm thấy file: ${sourcePath}`)
  }
  let container
  try {
    container = JSON.parse(fs.readFileSync(resolved, 'utf-8'))
    if (container.format !== 'claude-swap-encrypted') {
      throw new Error('Định dạng không khớp')
    }
  } catch (err) {
    throw new SwapError(`File sao lưu không hợp lệ: ${err.message}`)
  }

  let payload
  try {
    const salt = Buffer.from(container.salt, 'hex')
    const iv = Buffer.from(container.iv, 'hex')
    const tag = Buffer.from(container.tag, 'hex')
    const data = Buffer.from(container.data, 'hex')
    const key = crypto.pbkdf2Sync(password, salt, container.iterations || 100000, 32, 'sha512')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
    payload = JSON.parse(decrypted.toString('utf-8'))
  } catch {
    throw new SwapError('Mật khẩu giải mã không chính xác hoặc dữ liệu file bị hỏng.')
  }

  const result = { added: [], exists: [] }
  const profiles = payload.profiles || {}
  for (const [name, data] of Object.entries(profiles)) {
    if (!NAME_RE.test(name)) continue
    const target = profilePath(home, name)
    if (fs.existsSync(target) && !overwrite) {
      result.exists.push(name)
      continue
    }
    atomicWrite(target, JSON.stringify(data, null, 2))
    result.added.push(name)
  }

  return result
}

// ---------------------------------------------------------------- cli

export async function runCli(argv, home = os.homedir()) {
  let noColor = false
  const filteredArgv = []
  for (const arg of argv) {
    if (arg === '--no-color') {
      noColor = true
    } else {
      filteredArgv.push(arg)
    }
  }

  const cmd = filteredArgv[0]
  const color = !noColor && shouldColor()

  try {
    switch (cmd) {
      case 'list': {
        const refresh = filteredArgv.includes('--refresh')
        if (refresh) {
          await usageRows(home, fetchUsage, true)
        }
        console.log(profileListReport(home, color))
        return 0
      }
      case 'current': {
        console.log(currentProfile(home) || '')
        return 0
      }
      case 'usage': {
        const refresh = filteredArgv.includes('--refresh')
        console.log(await usageReport(home, fetchUsage, refresh, color))
        return 0
      }
      case 'folder': {
        const d = profilesDir(home)
        try {
          openProfilesFolder(home)
          console.log(`Đã mở: ${d}`)
        } catch {
          console.log(`Không mở được trình quản lý file. Thư mục: ${d}`)
        }
        return 0
      }
      case 'import': {
        const force = filteredArgv.includes('--force')
        const targetPath = filteredArgv.slice(1).find(a => a !== '--force')
        if (!targetPath) {
          throw new SwapError('Thiếu đường dẫn thư mục cần nhập.')
        }
        const r = importProfiles(home, targetPath, force)
        console.log(`Đã nhập: ${r.added.join(', ') || '(không có)'}`)
        if (r.exists.length > 0) {
          console.log(`Trùng tên, bỏ qua (dùng --force để ghi đè): ${r.exists.join(', ')}`)
        }
        if (r.invalid.length > 0) {
          console.log(`Không phải file profile: ${r.invalid.join(', ')}`)
        }
        return 0
      }
      case 'new':
      case 'save': {
        const force = filteredArgv.includes('--force')
        const name = filteredArgv.slice(1).find(a => a !== '--force')
        if (!name) {
          throw new SwapError('Thiếu tên profile.')
        }
        const verb = cmd === 'new' ? 'tạo' : 'lưu'
        const saved = saveProfile(home, name, force)
        console.log(`Đã ${verb}: ${saved}`)
        return 0
      }
      case 'swap': {
        const name = filteredArgv[1]
        if (!name) throw new SwapError('Thiếu tên profile.')
        const isProject = filteredArgv.includes('--project')
        swapProfile(home, name, {
          type: isProject ? 'project' : 'manual',
          reason: isProject ? 'Project binding' : '',
        })
        console.log(
          `Đã chuyển sang '${name}'. Không cần tắt session; Claude CLI dùng tài khoản mới ở lần ` +
            'kiểm tra đăng nhập kế tiếp (có thể chưa ngay prompt sau). Xem /status để chắc chắn.'
        )
        return 0
      }
      case 'delete': {
        const name = filteredArgv[1]
        if (!name) throw new SwapError('Thiếu tên profile.')
        deleteProfile(home, name)
        console.log(`Đã xoá '${name}'.`)
        return 0
      }
      case 'auto': {
        const sub = filteredArgv[1]
        const cfg = loadAutoSwitchConfig(home)

        if (!sub || sub === 'status') {
          console.log(`Tự động chuyển profile: ${cfg.enabled ? '🟢 BẬT' : '⚪ TẮT'} (Ngưỡng: ${cfg.threshold}%)`)
          if (cfg.order && cfg.order.length > 0) {
            console.log(`Thứ tự ưu tiên: ${cfg.order.join(' -> ')}`)
          } else {
            console.log('Quy tắc chọn: Tự động (Ưu tiên còn nhiều token hơn, thời gian reset 5h ngắn hơn)')
          }
          return 0
        }

        if (sub === 'on') {
          cfg.enabled = true
          saveAutoSwitchConfig(home, cfg)
          console.log('Đã BẬT tự động chuyển profile.')
          return 0
        }

        if (sub === 'off') {
          cfg.enabled = false
          saveAutoSwitchConfig(home, cfg)
          console.log('Đã TẮT tự động chuyển profile.')
          return 0
        }

        if (sub === 'threshold') {
          const val = parseFloat(filteredArgv[2])
          if (isNaN(val) || val < 1 || val > 100) {
            console.error('Ngưỡng không hợp lệ. Vui lòng nhập số từ 1 đến 100.')
            return 1
          }
          cfg.threshold = Math.round(val)
          saveAutoSwitchConfig(home, cfg)
          console.log(`Đã đặt ngưỡng tự động chuyển sang profile khác: ${cfg.threshold}%.`)
          return 0
        }

        if (sub === 'order') {
          const val = filteredArgv[2]
          if (!val || val === 'default' || val === 'none') {
            cfg.order = []
            saveAutoSwitchConfig(home, cfg)
            console.log('Đã chuyển về quy tắc chọn profile tự động (nhiều token hơn, reset sớm hơn).')
            return 0
          }
          const names = val.split(',').map(s => s.trim()).filter(Boolean)
          cfg.order = names
          saveAutoSwitchConfig(home, cfg)
          console.log(`Đã đặt thứ tự chuyển profile: ${names.join(' -> ')}.`)
          return 0
        }

        if (sub === 'check') {
          const res = await autoCheckAndSwap(home)
          if (res.swapped) {
            console.log(`[auto-swap] Đã tự động chuyển từ '${res.from}' sang '${res.to}' (mức dùng: ${res.util}% >= ngưỡng ${res.threshold}%).`)
          } else if (res.reason === 'no_candidate') {
            console.log(`[auto-swap] Profile '${res.current}' đạt mức ${res.util}% nhưng không có profile thay thế khả dụng.`)
          } else if (res.reason === 'disabled') {
            console.log('Tự động chuyển profile đang tắt.')
          } else {
            console.log(`Không cần chuyển profile (mức dùng: ${res.util}%, ngưỡng: ${res.threshold}%).`)
          }
          return 0
        }

        if (sub === 'pool') {
          const val = filteredArgv[2]
          if (!val || val === 'all' || val === 'default' || val === 'none') {
            cfg.pool = null
            saveAutoSwitchConfig(home, cfg)
            console.log('Đã mở auto-switch cho tất cả các profile (không giới hạn pool).')
            return 0
          }
          cfg.pool = val.trim()
          saveAutoSwitchConfig(home, cfg)
          console.log(`Đã đặt nhóm (pool) cho auto-switch: '${cfg.pool}'.`)
          return 0
        }

        console.error(`Lệnh auto không hợp lệ: ${sub}. Dùng: /profile auto [on|off|threshold <%>|order <danh sách>|pool <tag|all>|check]`)
        return 1
      }
      case 'bind': {
        const sub = filteredArgv[1]
        if (sub === 'get') {
          const targetDir = filteredArgv[2] || process.cwd()
          const bound = getBoundProfile(home, targetDir)
          if (bound) {
            console.log(`Thư mục '${targetDir}' đang liên kết với profile: ${bound.profile} (${bound.source})`)
          } else {
            console.log(`Thư mục '${targetDir}' chưa liên kết với profile nào.`)
          }
          return 0
        }
        const profileName = sub || currentProfile(home)
        const targetDir = filteredArgv[2] || process.cwd()
        if (!profileName) throw new SwapError('Thiếu tên profile để liên kết.')
        const res = bindProfile(home, targetDir, profileName)
        console.log(`Đã liên kết thư mục '${res.dir}' với profile '${res.profile}'.`)
        return 0
      }
      case 'unbind': {
        const targetDir = filteredArgv[1] || process.cwd()
        const res = unbindProfile(home, targetDir)
        console.log(`Đã gỡ liên kết profile cho thư mục '${res.dir}'.`)
        return 0
      }
      case 'notify': {
        const sub = filteredArgv[1]
        const cfg = loadNotificationConfig(home)
        if (!sub || sub === 'status') {
          console.log(`Thông báo hệ thống: ${cfg.enabled ? '🟢 BẬT' : '⚪ TẮT'}`)
          return 0
        }
        if (sub === 'on') {
          cfg.enabled = true
          saveNotificationConfig(home, cfg)
          console.log('Đã BẬT thông báo hệ thống.')
          return 0
        }
        if (sub === 'off') {
          cfg.enabled = false
          saveNotificationConfig(home, cfg)
          console.log('Đã TẮT thông báo hệ thống.')
          return 0
        }
        console.error(`Lệnh notify không hợp lệ: ${sub}. Dùng: /profile notify [on|off]`)
        return 1
      }
      case 'tag': {
        const name = filteredArgv[1]
        const tag = filteredArgv[2]
        if (!name || !tag) throw new SwapError('Cú pháp: /profile tag <tên profile> <tag>')
        const tags = addProfileTag(home, name, tag)
        console.log(`Đã gắn tag '${tag}' cho profile '${name}'. Tags hiện tại: ${tags.join(', ')}`)
        return 0
      }
      case 'untag': {
        const name = filteredArgv[1]
        const tag = filteredArgv[2]
        if (!name || !tag) throw new SwapError('Cú pháp: /profile untag <tên profile> <tag>')
        const tags = removeProfileTag(home, name, tag)
        console.log(`Đã gỡ tag '${tag}' khỏi profile '${name}'. Tags hiện tại: ${tags.join(', ') || '(không có)'}`)
        return 0
      }
      case 'tags': {
        const map = listAllTags(home)
        const entries = Object.entries(map)
        if (entries.length === 0) {
          console.log('Chưa có tag nào được tạo. Dùng: /profile tag <profile> <tag>')
          return 0
        }
        for (const [tag, profiles] of entries) {
          console.log(`🏷️ ${tag}: ${profiles.join(', ')}`)
        }
        return 0
      }
      case 'export': {
        const targetPath = filteredArgv[1]
        if (!targetPath) throw new SwapError('Cú pháp: /profile export <đường dẫn file> [--password <mật khẩu>]')
        const passIndex = filteredArgv.indexOf('--password')
        const password = passIndex !== -1 ? filteredArgv[passIndex + 1] : ''
        if (!password) throw new SwapError('Vui lòng cung cấp mật khẩu với --password <mật khẩu>.')
        const res = exportEncryptedProfiles(home, targetPath, password)
        console.log(`Đã xuất ${res.count} profiles đã mã hóa ra: ${res.path}`)
        return 0
      }
      case 'import-enc': {
        const sourcePath = filteredArgv[1]
        if (!sourcePath) throw new SwapError('Cú pháp: /profile import-enc <đường dẫn file> [--password <mật khẩu>] [--force]')
        const passIndex = filteredArgv.indexOf('--password')
        const password = passIndex !== -1 ? filteredArgv[passIndex + 1] : ''
        if (!password) throw new SwapError('Vui lòng cung cấp mật khẩu với --password <mật khẩu>.')
        const force = filteredArgv.includes('--force')
        const res = importEncryptedProfiles(home, sourcePath, password, force)
        console.log(`Đã nhập thành công: ${res.added.join(', ') || '(không có profile mới)'}`)
        if (res.exists.length > 0) {
          console.log(`Bỏ qua profile đã tồn tại (dùng --force để ghi đè): ${res.exists.join(', ')}`)
        }
        return 0
      }
      case 'history': {
        const limit = parseInt(filteredArgv[1], 10) || 10
        console.log(formatSwapHistory(home, limit))
        return 0
      }
      case 'stats': {
        console.log(formatSwapStats(home))
        return 0
      }
      default:
        console.error(`Lệnh không hợp lệ: ${cmd}`)
        return 1
    }
  } catch (err) {
    if (err instanceof SwapError) {
      console.error(`Lỗi: ${err.message}`)
      return 1
    }
    throw err
  }
}

// Direct CLI invocation
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const code = await runCli(process.argv.slice(2))
  process.exit(code)
}
