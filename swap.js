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

export function languageFile(home = os.homedir()) {
  return path.join(profilesDir(home), '.language.json')
}

export function loadLanguage(home = os.homedir()) {
  if (process.env.CLAUDE_SWAP_LANG && ['vi', 'en'].includes(process.env.CLAUDE_SWAP_LANG.toLowerCase())) {
    return process.env.CLAUDE_SWAP_LANG.toLowerCase()
  }
  const file = languageFile(home)
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && data.language && ['vi', 'en'].includes(data.language.toLowerCase())) {
        return data.language.toLowerCase()
      }
    } catch {}
  }
  return 'vi'
}

export function setLanguage(home = os.homedir(), lang) {
  const norm = (lang || '').trim().toLowerCase()
  if (norm !== 'vi' && norm !== 'en') {
    throw new SwapError(
      norm
        ? `Ngôn ngữ không được hỗ trợ: '${lang}'. Chỉ hỗ trợ 'vi' hoặc 'en'.`
        : `Vui lòng chỉ định ngôn ngữ: /profile lang [vi|en]`
    )
  }
  const file = languageFile(home)
  atomicWrite(file, JSON.stringify({ language: norm, updatedAt: new Date().toISOString() }, null, 2))
  return norm
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
  const resolved = resolveProfileOrAlias(home, name)
  const src = profilePath(home, resolved)
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
    throw new SwapError(`File profile '${resolved}' bị hỏng: ${err.message}`)
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
      if (cur === resolved) {
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
  setCurrent(home, resolved)

  recordSwapHistory(home, {
    timestamp: new Date().toISOString(),
    from: cur || '(none)',
    to: resolved,
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
  if (!token || token.startsWith('tok-') || token.startsWith('mock-')) {
    return {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 0, resets_at: null },
    }
  }
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

export function profileListReport(home, color = null, lang = null) {
  const currentLang = lang || loadLanguage(home)
  const profiles = listProfiles(home)
  if (profiles.length === 0) {
    return currentLang === 'en'
      ? 'No profiles found. Create one with: /profile new <name>'
      : 'Chưa có profile nào. Tạo bằng: /profile new <tên>'
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

    const tags = getProfileTags(home, n)
    const tagBadge = tags.length
      ? useColor
        ? `  \x1b[35m🏷️ ${tags.join(', ')}\x1b[0m`
        : `  🏷️ ${tags.join(', ')}`
      : ''

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

    const disabled = isProfileDisabled(home, n)
    const disabledBadge = disabled
      ? useColor
        ? '  \x1b[33m(disabled)\x1b[0m'
        : '  (disabled)'
      : ''

    const emailStr = email ? `  👤 ${email}` : ''

    if (useColor) {
      const nameAndActive = active ? `${n} (Active)` : n
      const nameColored = active ? `\x1b[1;32m${nameAndActive}\x1b[0m` : `\x1b[1;37m${n}\x1b[0m`
      const emailColored = email ? `  \x1b[38;5;248m👤 ${email}\x1b[0m` : ''
      lines.push(`${icon} ${nameColored}${emailColored}${tagBadge}${disabledBadge}${summary}`)
    } else {
      lines.push(`${icon} ${n}${activeStr}${emailStr}${tagBadge}${disabledBadge}${summary}`)
    }
  }
  return lines.join('\n')
}

export async function usageReport(home, fetchFn = fetchUsage, force = false, color = false, lang = null) {
  const currentLang = lang || loadLanguage(home)
  const rows = await usageRows(home, fetchFn, force)
  if (rows.length === 0) {
    return currentLang === 'en' ? 'No profiles found.' : 'Chưa có profile nào.'
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
        autoReturn: parsed.autoReturn === true,
        primaryProfile: typeof parsed.primaryProfile === 'string' ? parsed.primaryProfile : null,
        safeguardThreshold:
          typeof parsed.safeguardThreshold === 'number'
            ? parsed.safeguardThreshold
            : parsed.safeguardThreshold === null || parsed.safeguardThreshold === false
            ? null
            : 85,
      }
    }
  } catch {}
  return {
    enabled: true,
    threshold: 95,
    order: [],
    pool: null,
    autoReturn: false,
    primaryProfile: null,
    safeguardThreshold: 85,
  }
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

function formatRemainingTime(ms) {
  if (ms <= 0) return 'Đã sẵn sàng'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) {
    return `còn ${hours} giờ ${minutes} phút`
  }
  return `còn ${minutes} phút`
}

export function formatCooldowns(home, cache = null, lang = null) {
  const currentLang = lang || loadLanguage(home)
  const profiles = listProfiles(home)
  if (profiles.length === 0) return currentLang === 'en' ? 'No profiles found.' : 'Chưa có profile nào.'
  const c = cache || loadUsageCache(home)
  const lines = [currentLang === 'en' ? '⏱️ 5-hour quota reset countdowns:' : '⏱️ Thời gian reset quota 5 giờ:']
  for (const name of profiles) {
    const email = profileEmail(home, name)
    const key = `${name}|${email}`
    const hit = c[key] && typeof c[key] === 'object' ? c[key] : {}
    const limits = Array.isArray(hit.limits) ? hit.limits : []
    const fiveHour = limits.find(l => l[0] === '5 giờ') || limits[0]
    const rawUtil = fiveHour ? Number(fiveHour[1]) : 0
    const util = Math.round(rawUtil <= 1 && rawUtil > 0 ? rawUtil * 100 : rawUtil)
    const resetTime = parseResetTime(hit, fiveHour)
    const isRateLimited = Boolean(hit.retry_at && hit.retry_at > Date.now() / 1000)

    let timeDesc = ''
    if (isRateLimited) {
      const waitSec = Math.max(0, Math.ceil(hit.retry_at - Date.now() / 1000))
      timeDesc = `⏳ Rate limited (thử lại sau ${waitSec}s)`
    } else if (resetTime === Number.MAX_SAFE_INTEGER) {
      timeDesc = 'Chưa có dữ liệu reset'
    } else {
      const remainingMs = resetTime - Date.now()
      const d = new Date(resetTime)
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      timeDesc = `Reset lúc ${timeStr} - ${formatRemainingTime(remainingMs)}`
    }
    const warn = util >= 95 ? ' 🔴' : util >= 80 ? ' 🟡' : ' 🟢'
    lines.push(`• ${name}: ${util}%${warn} (${timeDesc})`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- doctor & diagnostics

export function diagnoseProfiles(home) {
  const pDir = profilesDir(home)
  const results = []
  if (!fs.existsSync(pDir)) {
    return { profiles: [], activeProfile: null }
  }

  const files = fs.readdirSync(pDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
  const cache = loadUsageCache(home)
  const cur = currentProfile(home)

  for (const f of files) {
    const name = f.replace(/\.json$/, '')
    const fullPath = path.join(pDir, f)
    const report = {
      name,
      status: 'ok',
      issues: [],
      warnings: [],
      email: '',
      tokenExpiresAt: null,
      quota5h: null,
      quota7d: null,
    }

    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.claude_json) {
        throw new Error('Thiếu trường claude_json')
      }
    } catch (err) {
      report.status = 'error'
      report.issues.push(`File cấu hình bị hỏng hoặc không đúng chuẩn: ${err.message}`)
      results.push(report)
      continue
    }

    report.email = parsed.claude_json?.oauthAccount?.emailAddress || ''

    // Check credentials & token expiry
    if (parsed.credentials) {
      try {
        const creds = JSON.parse(parsed.credentials)
        const oauth = creds.claudeAiOauth
        if (oauth?.expiresAt) {
          const expMs = oauth.expiresAt > 1e11 ? oauth.expiresAt : oauth.expiresAt * 1000
          report.tokenExpiresAt = expMs
          const now = Date.now()
          if (expMs <= now) {
            report.status = 'error'
            report.issues.push('OAuth token đã hết hạn. Hãy /login để lấy lại token mới.')
          } else if (expMs - now < 24 * 3600 * 1000) {
            if (report.status === 'ok') report.status = 'warn'
            const hours = Math.round((expMs - now) / 3600000)
            report.warnings.push(`OAuth token sắp hết hạn trong khoảng ${hours} giờ.`)
          }
        }
      } catch {}
    }

    // Check cache quota & rate limit
    const key = `${name}|${report.email}`
    const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}
    if (hit.retry_at && hit.retry_at > Date.now() / 1000) {
      if (report.status === 'ok') report.status = 'warn'
      const wait = Math.ceil(hit.retry_at - Date.now() / 1000)
      report.warnings.push(`Đang bị tạm khóa do HTTP 429 rate limit (chờ ${wait}s).`)
    }
    const limits = Array.isArray(hit.limits) ? hit.limits : []
    const fiveH = limits.find(l => l[0] === '5 giờ')
    if (fiveH) {
      const u = Number(fiveH[1]) <= 1 && Number(fiveH[1]) > 0 ? Number(fiveH[1]) * 100 : Number(fiveH[1])
      report.quota5h = Math.round(u)
      if (u >= 95) {
        if (report.status === 'ok') report.status = 'warn'
        report.warnings.push(`Quota 5h đã chạm ngưỡng cạn kiệt (${Math.round(u)}%).`)
      }
    }
    const sevenD = limits.find(l => l[0] === '7 ngày')
    if (sevenD) {
      const u = Number(sevenD[1]) <= 1 && Number(sevenD[1]) > 0 ? Number(sevenD[1]) * 100 : Number(sevenD[1])
      report.quota7d = Math.round(u)
      if (u >= 95) {
        if (report.status === 'ok') report.status = 'warn'
        report.warnings.push(`Quota 7 ngày đã chạm ngưỡng cạn kiệt (${Math.round(u)}%).`)
      }
    }

    results.push(report)
  }

  return {
    profiles: results,
    activeProfile: cur,
  }
}

export function formatDiagnostics(diag, color = null, lang = 'vi') {
  const lines = [lang === 'en' ? '🩺 Profiles health check (Profile Doctor):\n' : '🩺 Kiểm tra sức khỏe profiles (Profile Doctor):\n']
  if (!diag || diag.profiles.length === 0) {
    lines.push(lang === 'en' ? 'No profiles found.' : 'Chưa có profile nào.')
    return lines.join('\n')
  }

  for (const p of diag.profiles) {
    const icon = p.status === 'ok' ? '🟢' : p.status === 'warn' ? '🟡' : '❌'
    lines.push(`${icon} ${p.name}:`)
    if (p.email) lines.push(`   • Email: ${p.email}`)
    if (p.tokenExpiresAt) {
      const d = new Date(p.tokenExpiresAt).toLocaleString('vi-VN')
      lines.push(`   • Token OAuth: Hạn đến ${d}`)
    }
    if (p.quota5h !== null || p.quota7d !== null) {
      const q5 = p.quota5h !== null ? `5h: ${p.quota5h}%` : ''
      const q7 = p.quota7d !== null ? `7d: ${p.quota7d}%` : ''
      lines.push(`   • Quota: ${[q5, q7].filter(Boolean).join(' | ')}`)
    }
    for (const iss of p.issues) {
      lines.push(`   ❗ Lỗi: ${iss}`)
    }
    for (const w of p.warnings) {
      lines.push(`   ⚠️ Cảnh báo: ${w}`)
    }
    if (p.status === 'ok') {
      lines.push('   ✨ Trạng thái: Hoạt động tốt')
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

// ---------------------------------------------------------------- statusline & prompt integration

export function getStatusline(home) {
  const cur = currentProfile(home)
  if (!cur) return '[Claude: ⚪ (none)]'
  const email = profileEmail(home, cur)
  const key = `${cur}|${email}`
  const cache = loadUsageCache(home)
  const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}

  if (hit.retry_at && hit.retry_at > Date.now() / 1000) {
    return `[Claude: ⏳ ${cur} (429)]`
  }

  const limits = Array.isArray(hit.limits) ? hit.limits : []
  const fiveHour = limits.find(l => l[0] === '5 giờ') || limits[0]
  if (fiveHour) {
    const rawUtil = Number(fiveHour[1])
    const util = Math.round(rawUtil <= 1 && rawUtil > 0 ? rawUtil * 100 : rawUtil)
    const icon = util >= 95 ? '🔴' : util >= 80 ? '🟡' : '🟢'
    return `[Claude: ${icon} ${cur} (${util}%)]`
  }

  return `[Claude: 🟢 ${cur}]`
}

export function generatePromptSnippet(shell = 'starship') {
  const s = String(shell).toLowerCase()
  if (s === 'starship') {
    return [
      '# Thêm đoạn sau vào ~/.config/starship.toml:',
      '[custom.claude_profile]',
      'command = "node /path/to/claude-swap/swap.js statusline"',
      'when = true',
      'format = "[$output]($style) "',
      'style = "bold cyan"',
    ].join('\n')
  }
  if (s === 'zsh') {
    return [
      '# Thêm hàm sau vào ~/.zshrc:',
      'claude_profile_prompt() {',
      '  node /path/to/claude-swap/swap.js statusline 2>/dev/null',
      '}',
      '# Gắn vào RPROMPT hoặc PROMPT:',
      'RPROMPT=\'$(claude_profile_prompt) \'${RPROMPT:-}',
    ].join('\n')
  }
  if (s === 'bash') {
    return [
      '# Thêm hàm sau vào ~/.bashrc:',
      'claude_profile_prompt() {',
      '  node /path/to/claude-swap/swap.js statusline 2>/dev/null',
      '}',
      '# Thêm $(claude_profile_prompt) vào biến PS1',
    ].join('\n')
  }
  if (s === 'tmux') {
    return [
      '# Thêm dòng sau vào ~/.tmux.conf:',
      'set -g status-right "#(node /path/to/claude-swap/swap.js statusline) %H:%M %d-%b-%y"',
    ].join('\n')
  }
  throw new SwapError(`Shell '${shell}' không được hỗ trợ. Các shell hỗ trợ: starship, zsh, bash, tmux`)
}

// ---------------------------------------------------------------- ephemeral & temporary swap

export function parseDuration(str) {
  if (!str || typeof str !== 'string') {
    throw new SwapError('Thời gian không hợp lệ. Ví dụ: 30m, 1h, 2h30m, 45s')
  }
  const trimmed = str.trim().toLowerCase()
  const re = /(\d+)\s*(ms|d|ngày|h|giờ|m|phút|s|giây)/g
  let totalMs = 0
  let match
  let matchedAny = false
  while ((match = re.exec(trimmed)) !== null) {
    matchedAny = true
    const num = parseInt(match[1], 10)
    const unit = match[2]
    if (unit === 'ms') totalMs += num
    else if (unit === 's' || unit === 'giây') totalMs += num * 1000
    else if (unit === 'm' || unit === 'phút') totalMs += num * 60 * 1000
    else if (unit === 'h' || unit === 'giờ') totalMs += num * 3600 * 1000
    else if (unit === 'd' || unit === 'ngày') totalMs += num * 24 * 3600 * 1000
  }
  if (!matchedAny || totalMs <= 0) {
    throw new SwapError(`Thời gian không hợp lệ: '${str}'. Ví dụ: 30m, 1h, 2h30m`)
  }
  return totalMs
}

export function tempProfileFile(home) {
  return path.join(profilesDir(home), '.temp-profile.json')
}

export function loadTempProfile(home) {
  const f = tempProfileFile(home)
  try {
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      if (data && typeof data === 'object' && data.tempProfile) {
        return data
      }
    }
  } catch {}
  return null
}

export function tempSwap(home, name, durationStr) {
  if (!profileExists(home, name)) {
    throw new SwapError(`Profile '${name}' không tồn tại.`)
  }
  const durationMs = parseDuration(durationStr)
  const orig = currentProfile(home) || ''
  if (orig === name) {
    throw new SwapError(`Profile '${name}' đang là profile active.`)
  }
  const expiresAt = Date.now() + durationMs

  swapProfile(home, name, {
    type: 'temp',
    reason: `Tạm thời ${durationStr}`,
  })

  const state = {
    tempProfile: name,
    originalProfile: orig,
    expiresAt,
    durationMs,
    durationStr,
  }
  atomicWrite(tempProfileFile(home), JSON.stringify(state, null, 2))
  return state
}

export function cancelTempSwap(home) {
  const state = loadTempProfile(home)
  if (!state) {
    throw new SwapError('Hiện tại không ở trạng thái profile tạm thời.')
  }
  const orig = state.originalProfile
  if (orig && profileExists(home, orig)) {
    swapProfile(home, orig, {
      type: 'temp',
      reason: 'Hủy chuyển tạm thời',
    })
  }
  try {
    fs.unlinkSync(tempProfileFile(home))
  } catch {}
  return { revertedTo: orig }
}

export function checkTempExpiry(home) {
  const state = loadTempProfile(home)
  if (!state) {
    return { expired: false }
  }
  if (Date.now() >= state.expiresAt) {
    const orig = state.originalProfile
    if (orig && profileExists(home, orig)) {
      swapProfile(home, orig, {
        type: 'auto',
        reason: 'Hết hạn profile tạm thời',
      })
      sendNotification(home, 'claude-swap', `Đã tự động quay về profile gốc '${orig}' do hết hạn mượn tạm.`)
    }
    try {
      fs.unlinkSync(tempProfileFile(home))
    } catch {}
    return { expired: true, revertedTo: orig }
  }
  return { expired: false, remainingMs: state.expiresAt - Date.now(), state }
}

export function findNextProfile(home, options = {}) {
  const config = options.config || loadAutoSwitchConfig(home)
  const allProfiles = listProfiles(home)
  const cur = currentProfile(home)
  const cache = options.cache || loadUsageCache(home)

  const candidates = []
  for (const name of allProfiles) {
    if (name === cur) continue
    if (isProfileDisabled(home, name)) continue

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
      const hasApiKey = Boolean(profile.claude_json?.primaryApiKey)
      const oauth = JSON.parse(profile.credentials || '{}').claudeAiOauth || {}
      if (!oauth.accessToken && !hasApiKey) continue
      if (!hasApiKey && typeof oauth.expiresAt === 'number' && oauth.expiresAt / 1000 < Date.now() / 1000) {
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

    const sevenDay = limits.find(l => l[0] === '7 ngày')
    const raw7d = sevenDay ? Number(sevenDay[1]) : 0
    const util7d = raw7d <= 1 && raw7d > 0 ? raw7d * 100 : raw7d
    if (config.safeguardThreshold && util7d >= config.safeguardThreshold) {
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
  // Check if temp profile expired
  const tempRes = checkTempExpiry(home)
  if (tempRes.expired) {
    return {
      swapped: true,
      from: options.currentProfile || currentProfile(home),
      to: tempRes.revertedTo,
      isTempRevert: true,
    }
  }

  const config = options.config || loadAutoSwitchConfig(home)
  if (!config.enabled) {
    return { swapped: false, reason: 'disabled' }
  }

  const cur = currentProfile(home)
  if (!cur) {
    return { swapped: false, reason: 'no_current' }
  }

  // Check branch binding
  const branchBound = getBoundBranchProfile(home, process.cwd())
  if (branchBound && branchBound.profile !== cur && profileExists(home, branchBound.profile)) {
    swapProfile(home, branchBound.profile, {
      type: 'project',
      reason: `Branch binding (${branchBound.branch})`,
      cwd: process.cwd(),
    })
    sendNotification(home, 'claude-swap', `Đã chuyển sang profile '${branchBound.profile}' theo nhánh '${branchBound.branch}'.`)
    return {
      swapped: true,
      from: cur,
      to: branchBound.profile,
      isBranchBinding: true,
    }
  }

  const email = profileEmail(home, cur)
  const cache = options.cache || loadUsageCache(home)

  // Check auto-return to primary profile
  if (
    config.autoReturn &&
    config.primaryProfile &&
    cur !== config.primaryProfile &&
    profileExists(home, config.primaryProfile)
  ) {
    const priEmail = profileEmail(home, config.primaryProfile)
    const priKey = `${config.primaryProfile}|${priEmail}`
    const priHit = cache[priKey] && typeof cache[priKey] === 'object' ? cache[priKey] : {}
    const priLimits = Array.isArray(priHit.limits) ? priHit.limits : []
    const pri5h = priLimits.find(l => l[0] === '5 giờ') || priLimits[0]
    const priRawUtil = pri5h ? Number(pri5h[1]) : 0
    const priUtil = priRawUtil <= 1 && priRawUtil > 0 ? priRawUtil * 100 : priRawUtil
    const priRateLimited = Boolean(priHit.retry_at && priHit.retry_at > Date.now() / 1000)

    if (!priRateLimited && priUtil < config.threshold) {
      swapProfile(home, config.primaryProfile, {
        type: 'auto',
        reason: 'Auto return to primary profile',
        cwd: process.cwd(),
      })
      sendNotification(
        home,
        'claude-swap',
        `Đã tự động quay về profile chính '${config.primaryProfile}' khi đã hồi token.`
      )
      return {
        swapped: true,
        from: cur,
        to: config.primaryProfile,
        util: priUtil,
        threshold: config.threshold,
        isAutoReturn: true,
      }
    }
  }

  const key = `${cur}|${email}`
  const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}

  const limits = Array.isArray(hit.limits) ? hit.limits : []
  const fiveHour = limits.find(l => l[0] === '5 giờ') || limits[0]
  const rawUtil = fiveHour ? Number(fiveHour[1]) : 0
  const util = rawUtil <= 1 && rawUtil > 0 ? rawUtil * 100 : rawUtil

  const sevenDay = limits.find(l => l[0] === '7 ngày')
  const raw7d = sevenDay ? Number(sevenDay[1]) : 0
  const util7d = raw7d <= 1 && raw7d > 0 ? raw7d * 100 : raw7d
  const isSafeguardTriggered = Boolean(config.safeguardThreshold && util7d >= config.safeguardThreshold)
  recordUsageSnapshot(home, cur, util, util7d)

  const isRateLimited = Boolean(hit.retry_at && hit.retry_at > Date.now() / 1000)
  if (isRateLimited || util >= config.threshold || isSafeguardTriggered) {
    const next = findNextProfile(home, { config, cache })
    if (next && next !== cur) {
      const reasonText = isRateLimited
        ? 'Rate limited'
        : isSafeguardTriggered
        ? `Mức dùng 7 ngày ${util7d}% >= ngưỡng bảo vệ ${config.safeguardThreshold}%`
        : `Mức dùng ${util}% >= ngưỡng ${config.threshold}%`
      swapProfile(home, next, {
        type: 'auto',
        reason: reasonText,
        cwd: process.cwd(),
      })
      sendNotification(home, 'claude-swap', `Đã chuyển sang '${next}' (${reasonText})`)
      return {
        swapped: true,
        from: cur,
        to: next,
        util,
        threshold: config.threshold,
        rateLimited: isRateLimited,
        safeguardTriggered: isSafeguardTriggered,
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

// ---------------------------------------------------------------- aliases

export function aliasesFile(home) {
  return path.join(profilesDir(home), '.aliases.json')
}

export function loadAliases(home) {
  const f = aliasesFile(home)
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {}
  } catch {
    return {}
  }
}

export function saveAliases(home, aliases) {
  const f = aliasesFile(home)
  atomicWrite(f, JSON.stringify(aliases, null, 2))
}

export function resolveProfileOrAlias(home, nameOrAlias) {
  if (!nameOrAlias) return nameOrAlias
  const aliases = loadAliases(home)
  if (aliases[nameOrAlias]) {
    return aliases[nameOrAlias]
  }
  return nameOrAlias
}

export function setAlias(home, alias, profileName) {
  if (!alias || !profileName) {
    throw new SwapError('Cú pháp: /profile alias <tên_alias> <tên_profile>')
  }
  const resolved = resolveProfileOrAlias(home, profileName)
  if (!profileExists(home, resolved)) {
    throw new SwapError(`Profile '${profileName}' không tồn tại.`)
  }
  const aliases = loadAliases(home)
  aliases[alias.trim()] = resolved
  saveAliases(home, aliases)
  return aliases
}

export function removeAlias(home, alias) {
  if (!alias) throw new SwapError('Thiếu tên alias cần xoá.')
  const aliases = loadAliases(home)
  if (!aliases[alias.trim()]) {
    throw new SwapError(`Alias '${alias}' không tồn tại.`)
  }
  delete aliases[alias.trim()]
  saveAliases(home, aliases)
  return aliases
}

export function listAliases(home) {
  return loadAliases(home)
}

// ---------------------------------------------------------------- git branch binding

export function branchBindingsFile(home) {
  return path.join(profilesDir(home), '.branch-bindings.json')
}

export function loadBranchBindings(home) {
  const f = branchBindingsFile(home)
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {}
  } catch {
    return {}
  }
}

export function saveBranchBindings(home, bindings) {
  const f = branchBindingsFile(home)
  atomicWrite(f, JSON.stringify(bindings, null, 2))
}

export function getCurrentGitBranch(dir = process.cwd()) {
  try {
    return child_process
      .execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      })
      .toString('utf-8')
      .trim()
  } catch {
    return null
  }
}

export function matchBranchPattern(pattern, branch) {
  if (!pattern || !branch) return false
  if (pattern === '*' || pattern === branch) return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(branch)
}

export function bindBranch(home, repoDir, pattern, profileName) {
  if (!pattern || !profileName) {
    throw new SwapError('Cú pháp: /profile bind-branch <pattern> <tên_profile>')
  }
  const resolvedName = resolveProfileOrAlias(home, profileName)
  if (!profileExists(home, resolvedName)) {
    throw new SwapError(`Profile '${profileName}' không tồn tại.`)
  }
  const resolvedDir = path.resolve(repoDir || process.cwd())
  const bindings = loadBranchBindings(home)
  if (!Array.isArray(bindings[resolvedDir])) {
    bindings[resolvedDir] = []
  }
  bindings[resolvedDir] = bindings[resolvedDir].filter(b => b.pattern !== pattern.trim())
  bindings[resolvedDir].push({ pattern: pattern.trim(), profile: resolvedName })
  saveBranchBindings(home, bindings)
  return { dir: resolvedDir, pattern: pattern.trim(), profile: resolvedName }
}

export function unbindBranch(home, repoDir, pattern = null) {
  const resolvedDir = path.resolve(repoDir || process.cwd())
  const bindings = loadBranchBindings(home)
  if (!bindings[resolvedDir]) {
    return { dir: resolvedDir, removed: 0 }
  }
  const prevCount = bindings[resolvedDir].length
  if (pattern) {
    bindings[resolvedDir] = bindings[resolvedDir].filter(b => b.pattern !== pattern.trim())
  } else {
    delete bindings[resolvedDir]
  }
  saveBranchBindings(home, bindings)
  return { dir: resolvedDir, removed: prevCount - (bindings[resolvedDir]?.length || 0) }
}

export function getBoundBranchProfile(home, startDir = process.cwd(), currentBranch = null) {
  let cur = path.resolve(startDir)
  const bindings = loadBranchBindings(home)
  const branch = currentBranch || getCurrentGitBranch(cur)
  if (!branch) return null

  while (true) {
    const repoBindings = bindings[cur]
    if (Array.isArray(repoBindings)) {
      for (const b of repoBindings) {
        if (matchBranchPattern(b.pattern, branch) && profileExists(home, b.profile)) {
          return { profile: b.profile, branch, pattern: b.pattern, dir: cur }
        }
      }
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

// ---------------------------------------------------------------- quota burn-rate & forecast

export function usageHistoryFile(home) {
  return path.join(profilesDir(home), '.usage-history.json')
}

export function loadUsageHistory(home) {
  const f = usageHistoryFile(home)
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {}
  } catch {
    return {}
  }
}

export function recordUsageSnapshot(home, profileName, util5h, util7d = null) {
  if (!profileName) return
  const f = usageHistoryFile(home)
  const history = loadUsageHistory(home)
  if (!Array.isArray(history[profileName])) {
    history[profileName] = []
  }
  history[profileName].push({
    timestamp: Date.now(),
    util5h: Number(util5h),
    util7d: util7d !== null ? Number(util7d) : null,
  })
  if (history[profileName].length > 50) {
    history[profileName] = history[profileName].slice(-50)
  }
  atomicWrite(f, JSON.stringify(history, null, 2))
}

export function calculateForecast(home, profileName, threshold = 95) {
  const history = loadUsageHistory(home)
  const entries = history[profileName] || []
  if (entries.length < 2) {
    return {
      profile: profileName,
      hasData: false,
      message: 'Chưa đủ dữ liệu lịch sử (cần ít nhất 2 lần đo quota).',
    }
  }

  const first = entries[0]
  const last = entries[entries.length - 1]
  const deltaMs = last.timestamp - first.timestamp
  const deltaHours = deltaMs / (3600 * 1000)

  if (deltaHours <= 0) {
    return { profile: profileName, hasData: false, message: 'Dữ liệu đo quá sát nhau.' }
  }

  const deltaUtil = last.util5h - first.util5h
  const burnRatePerHour = deltaUtil / deltaHours
  const currentUtil = last.util5h

  if (burnRatePerHour <= 0) {
    return {
      profile: profileName,
      hasData: true,
      currentUtil,
      burnRatePerHour: 0,
      trend: 'stable_or_decreasing',
      message: `Mức dùng: ${Math.round(currentUtil)}% | Tốc độ tiêu thụ ổn định hoặc đang hạ nhiệt.`,
    }
  }

  const remainingUtil = Math.max(0, threshold - currentUtil)
  const hoursUntilThreshold = remainingUtil / burnRatePerHour
  const minutesUntilThreshold = Math.round(hoursUntilThreshold * 60)
  const estimatedTimestamp = Date.now() + minutesUntilThreshold * 60 * 1000

  return {
    profile: profileName,
    hasData: true,
    currentUtil,
    burnRatePerHour: Math.round(burnRatePerHour * 10) / 10,
    trend: 'increasing',
    minutesUntilThreshold,
    estimatedTimestamp,
    message:
      `Mức dùng: ${Math.round(currentUtil)}% | Tốc độ tăng: +${Math.round(burnRatePerHour * 10) / 10}%/giờ. ` +
      `Dự kiến chạm ngưỡng ${threshold}% sau ~${minutesUntilThreshold} phút ` +
      `(${new Date(estimatedTimestamp).toLocaleTimeString('vi-VN')}).`,
  }
}

export function formatForecastReport(home, lang = null) {
  const currentLang = lang || loadLanguage(home)
  const profiles = listProfiles(home)
  if (profiles.length === 0) return currentLang === 'en' ? 'No profiles found.' : 'Chưa có profile nào.'
  const lines = [currentLang === 'en' ? '📈 Token Burn-Rate & Exhaustion Forecast (Quota Forecast):\n' : '📈 Dự báo tốc độ tiêu thụ Token & Cạn hạn mức (Quota Forecast):\n']
  for (const n of profiles) {
    const f = calculateForecast(home, n)
    if (!f.hasData) {
      lines.push(`• ${n}: ${f.message}`)
    } else if (f.trend === 'increasing') {
      const icon = f.minutesUntilThreshold <= 30 ? '🔴' : f.minutesUntilThreshold <= 60 ? '🟠' : '🟡'
      lines.push(`${icon} ${n}: ${f.message}`)
    } else {
      lines.push(`🟢 ${n}: ${f.message}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- interactive picker

export async function interactivePickProfile(home, options = {}) {
  const profiles = listProfiles(home)
  if (profiles.length === 0) {
    throw new SwapError('Chưa có profile nào để chọn.')
  }
  const cur = currentProfile(home)

  if (!process.stdin.isTTY || options.nonInteractive) {
    const nextIdx = profiles.indexOf(cur) + 1
    const target = profiles[nextIdx % profiles.length]
    swapProfile(home, target, { type: 'manual', reason: 'Interactive pick (non-interactive)' })
    return { selected: target, nonInteractive: true }
  }

  return new Promise(resolve => {
    let index = Math.max(0, profiles.indexOf(cur))
    const stdin = process.stdin
    const stdout = process.stdout

    const render = () => {
      stdout.write('\x1b[2J\x1b[0;0H')
      stdout.write("🎛️  CHỌN PROFILE (Dùng phím ↑ / ↓ để di chuyển, Enter để chọn, 'q' để hủy):\n\n")
      profiles.forEach((p, idx) => {
        const isSelected = idx === index
        const isActive = p === cur
        const pointer = isSelected ? '➔ ' : '  '
        const badge = isActive ? ' (Active)' : ''
        const tags = getProfileTags(home, p)
        const tagStr = tags.length ? ` [🏷️ ${tags.join(', ')}]` : ''
        if (isSelected) {
          stdout.write(`\x1b[1;36m${pointer}${p}${badge}${tagStr}\x1b[0m\n`)
        } else {
          stdout.write(`${pointer}${p}${badge}${tagStr}\n`)
        }
      })
    }

    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf-8')
    render()

    const onKey = key => {
      if (key === '\u0003' || key === 'q' || key === 'Q') {
        stdin.removeListener('data', onKey)
        stdin.setRawMode(wasRaw)
        stdin.pause()
        stdout.write('\nĐã hủy chọn profile.\n')
        resolve({ selected: null, cancelled: true })
        return
      }

      if (key === '\r' || key === '\n') {
        stdin.removeListener('data', onKey)
        stdin.setRawMode(wasRaw)
        stdin.pause()
        const target = profiles[index]
        swapProfile(home, target, { type: 'manual', reason: 'Interactive pick' })
        stdout.write(`\n✨ Đã chuyển sang: ${target}\n`)
        resolve({ selected: target })
        return
      }

      if (key === '\u001b[A' || key === 'k') {
        index = (index - 1 + profiles.length) % profiles.length
        render()
      } else if (key === '\u001b[B' || key === 'j') {
        index = (index + 1) % profiles.length
        render()
      }
    }

    stdin.on('data', onKey)
  })
}

// ---------------------------------------------------------------- remote sync

export function syncConfigFile(home) {
  return path.join(profilesDir(home), '.sync-config.json')
}

export function loadSyncConfig(home) {
  const f = syncConfigFile(home)
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {}
  } catch {
    return {}
  }
}

export function saveSyncConfig(home, config) {
  const f = syncConfigFile(home)
  atomicWrite(f, JSON.stringify(config, null, 2))
}

export function syncPush(home, targetPath, password) {
  const config = loadSyncConfig(home)
  const dest = targetPath || config.targetPath
  if (!dest) {
    throw new SwapError('Chưa cấu hình đường dẫn đích đồng bộ. Dùng: /profile sync setup <đường_dẫn_file>')
  }
  const pass = password || config.password
  if (!pass) {
    throw new SwapError('Vui lòng cung cấp mật khẩu mã hóa với --password <mật_khẩu>.')
  }

  const res = exportEncryptedProfiles(home, dest, pass)
  config.targetPath = dest
  config.lastPush = Date.now()
  saveSyncConfig(home, config)
  return { path: res.path, count: res.count }
}

export function syncPull(home, sourcePath, password, force = false) {
  const config = loadSyncConfig(home)
  const src = sourcePath || config.targetPath
  if (!src) {
    throw new SwapError('Chưa cấu hình đường dẫn nguồn đồng bộ. Dùng: /profile sync setup <đường_dẫn_file>')
  }
  const pass = password || config.password
  if (!pass) {
    throw new SwapError('Vui lòng cung cấp mật khẩu giải mã với --password <mật_khẩu>.')
  }

  const res = importEncryptedProfiles(home, src, pass, force)
  config.targetPath = src
  config.lastPull = Date.now()
  saveSyncConfig(home, config)
  return res
}

// ---------------------------------------------------------------- model affinity

export function modelAffinityFile(home) {
  return path.join(profilesDir(home), '.model-affinity.json')
}

export function loadModelAffinity(home) {
  const f = modelAffinityFile(home)
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {}
  } catch {
    return {}
  }
}

export function saveModelAffinity(home, affinities) {
  const f = modelAffinityFile(home)
  atomicWrite(f, JSON.stringify(affinities, null, 2))
}

export function setModelAffinity(home, modelName, profileName) {
  if (!modelName || !profileName) {
    throw new SwapError('Cú pháp: /profile affinity <model> <tên_profile>')
  }
  const resolved = resolveProfileOrAlias(home, profileName)
  if (!profileExists(home, resolved)) {
    throw new SwapError(`Profile '${profileName}' không tồn tại.`)
  }
  const affinities = loadModelAffinity(home)
  affinities[modelName.toLowerCase().trim()] = resolved
  saveModelAffinity(home, affinities)
  return affinities
}

export function removeModelAffinity(home, modelName) {
  if (!modelName) throw new SwapError('Thiếu tên model cần gỡ affinity.')
  const affinities = loadModelAffinity(home)
  delete affinities[modelName.toLowerCase().trim()]
  saveModelAffinity(home, affinities)
  return affinities
}

export function listModelAffinities(home) {
  return loadModelAffinity(home)
}

// ---------------------------------------------------------------- profile cleanup

export function analyzeProfilesForCleanup(home) {
  const profiles = listProfiles(home)
  const emailMap = new Map()
  const uuidMap = new Map()
  const expiredTokens = []
  const corruptFiles = []

  for (const n of profiles) {
    const f = profilePath(home, n)
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.claude_json) {
        corruptFiles.push(n)
        continue
      }
    } catch {
      corruptFiles.push(n)
      continue
    }

    const email = parsed.claude_json?.oauthAccount?.emailAddress
    const uuid = parsed.claude_json?.oauthAccount?.accountUuid

    if (email) {
      if (!emailMap.has(email)) emailMap.set(email, [])
      emailMap.get(email).push(n)
    }
    if (uuid) {
      if (!uuidMap.has(uuid)) uuidMap.set(uuid, [])
      uuidMap.get(uuid).push(n)
    }

    if (parsed.credentials) {
      try {
        const creds = JSON.parse(parsed.credentials)
        const exp = creds.claudeAiOauth?.expiresAt
        if (exp) {
          const expMs = exp > 1e11 ? exp : exp * 1000
          if (Date.now() - expMs > 7 * 24 * 3600 * 1000) {
            expiredTokens.push({ name: n, expiredAt: expMs })
          }
        }
      } catch {}
    }
  }

  const duplicates = []
  for (const [email, list] of emailMap.entries()) {
    if (list.length > 1) {
      duplicates.push({ type: 'email', value: email, profiles: list })
    }
  }
  for (const [uuid, list] of uuidMap.entries()) {
    if (list.length > 1 && !duplicates.some(d => d.profiles.join(',') === list.join(','))) {
      duplicates.push({ type: 'accountUuid', value: uuid, profiles: list })
    }
  }

  return { duplicates, expiredTokens, corruptFiles }
}

export function formatCleanupReport(analysis, color = null, lang = 'vi') {
  const { duplicates, expiredTokens, corruptFiles } = analysis
  const hasIssues = duplicates.length > 0 || expiredTokens.length > 0 || corruptFiles.length > 0

  if (!hasIssues) {
    return lang === 'en'
      ? '✨ Awesome! No duplicate, corrupt profiles or expired tokens over 7 days detected.'
      : '✨ Tuyệt vời! Không phát hiện profile trùng lặp, hỏng hoặc token hết hạn quá 7 ngày.'
  }

  const lines = [lang === 'en' ? '🧹 Profile Cleanup scan report:\n' : '🧹 Kết quả quét dọn dẹp profile (Profile Cleanup):\n']
  if (duplicates.length > 0) {
    lines.push('👥 Các profile trùng cùng tài khoản:')
    for (const d of duplicates) {
      lines.push(`   • ${d.type} (${d.value}): ${d.profiles.join(', ')}`)
    }
    lines.push('')
  }
  if (expiredTokens.length > 0) {
    lines.push('⌛ Profile có token đã hết hạn quá 7 ngày:')
    for (const exp of expiredTokens) {
      lines.push(`   • ${exp.name} (Hạn: ${new Date(exp.expiredAt).toLocaleDateString('vi-VN')})`)
    }
    lines.push('')
  }
  if (corruptFiles.length > 0) {
    lines.push('⚠️ File cấu hình bị hỏng:')
    for (const c of corruptFiles) {
      lines.push(`   • ${c}`)
    }
    lines.push('')
  }

  lines.push('Gợi ý: Dùng /profile delete <tên> để dọn dẹp các profile thừa hoặc hỏng.')
  return lines.join('\n')
}

export function cleanupProfiles(home, options = {}) {
  const analysis = analyzeProfilesForCleanup(home)
  if (!options.force) {
    return { ...analysis, cleaned: [] }
  }
  const cleaned = []
  for (const c of analysis.corruptFiles) {
    try {
      fs.unlinkSync(profilePath(home, c))
      cleaned.push(c)
    } catch {}
  }
  return { ...analysis, cleaned }
}

// ---------------------------------------------------------------- disabled profiles (auto-switch exclusion)

export function disabledProfilesFile(home = os.homedir()) {
  return path.join(profilesDir(home), '.disabled.json')
}

export function loadDisabledProfiles(home = os.homedir()) {
  const f = disabledProfilesFile(home)
  if (fs.existsSync(f)) {
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (Array.isArray(data)) return data
    } catch {}
  }
  return []
}

export function saveDisabledProfiles(home = os.homedir(), list) {
  const f = disabledProfilesFile(home)
  atomicWrite(f, JSON.stringify([...new Set(list)], null, 2))
}

export function disableProfile(home = os.homedir(), name) {
  const resolved = resolveProfileOrAlias(home, name)
  if (!profileExists(home, resolved)) {
    throw new SwapError(`Profile '${name}' không tồn tại.`)
  }
  const list = loadDisabledProfiles(home)
  if (!list.includes(resolved)) {
    list.push(resolved)
    saveDisabledProfiles(home, list)
  }
  return resolved
}

export function enableProfile(home = os.homedir(), name) {
  const resolved = resolveProfileOrAlias(home, name)
  const list = loadDisabledProfiles(home)
  const filtered = list.filter(p => p !== resolved)
  saveDisabledProfiles(home, filtered)
  return resolved
}

export function isProfileDisabled(home = os.homedir(), name) {
  const list = loadDisabledProfiles(home)
  return list.includes(name)
}

// ---------------------------------------------------------------- direct token / api key registration

export function addTokenProfile(home = os.homedir(), token, name = null, options = {}) {
  const trimmedToken = (token || '').trim()
  if (!trimmedToken) {
    throw new SwapError('Vui lòng cung cấp token hoặc API key.')
  }
  const isApiKey = trimmedToken.startsWith('sk-ant-api')
  let profileName = name ? name.trim() : ''
  if (!profileName) {
    const existing = listProfiles(home)
    let idx = 1
    const prefix = isApiKey ? 'api-key' : 'token'
    while (existing.includes(`${prefix}-${idx}`)) {
      idx++
    }
    profileName = `${prefix}-${idx}`
  }
  checkName(profileName)
  const target = profilePath(home, profileName)
  if (fs.existsSync(target) && !options.force) {
    throw new ProfileExists(`Profile '${profileName}' đã tồn tại. Dùng --force để ghi đè.`)
  }

  const email = options.email || (isApiKey ? `${profileName}@api.local` : `${profileName}@token.local`)
  const auth = {}
  let credentials = null

  if (isApiKey) {
    auth.primaryApiKey = trimmedToken
  } else {
    auth.oauthAccount = {
      emailAddress: email,
      accountUuid: `token-account-${Date.now()}`,
    }
    credentials = JSON.stringify({
      claudeAiOauth: {
        accessToken: trimmedToken,
        expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      },
    })
  }

  const profile = {
    claude_json: auth,
    credentials,
    tags: options.tag ? [options.tag] : [],
  }

  atomicWrite(target, JSON.stringify(profile, null, 2))
  return {
    name: profileName,
    type: isApiKey ? 'api_key' : 'oauth_token',
    email,
    path: target,
  }
}

// ---------------------------------------------------------------- isolated sessions (parallel execution)

export function sessionDir(home = os.homedir(), name) {
  const resolved = resolveProfileOrAlias(home, name)
  return path.join(profilesDir(home), '.sessions', resolved)
}

export function prepareSession(home = os.homedir(), name) {
  const resolved = resolveProfileOrAlias(home, name)
  if (!profileExists(home, resolved)) {
    throw new SwapError(`Profile '${name}' không tồn tại.`)
  }
  const sDir = sessionDir(home, resolved)
  fs.mkdirSync(path.join(sDir, '.claude'), { recursive: true, mode: 0o700 })

  const pData = JSON.parse(fs.readFileSync(profilePath(home, resolved), 'utf-8'))
  const cj = path.join(sDir, '.claude.json')
  const baseClaudeJson = fs.existsSync(claudeJson(home)) ? loadClaudeJson(home) : {}
  const sessionData = { ...baseClaudeJson, ...(pData.claude_json || {}) }
  atomicWrite(cj, JSON.stringify(sessionData, null, 2))

  if (pData.credentials) {
    const credFile = path.join(sDir, '.claude', '.credentials.json')
    atomicWrite(credFile, pData.credentials)
  }
  return sDir
}

export function syncSessionBack(home = os.homedir(), name, sDir) {
  const resolved = resolveProfileOrAlias(home, name)
  const target = profilePath(home, resolved)
  if (!fs.existsSync(target)) return

  try {
    const pData = JSON.parse(fs.readFileSync(target, 'utf-8'))
    const cj = path.join(sDir, '.claude.json')
    if (fs.existsSync(cj)) {
      const liveJson = JSON.parse(fs.readFileSync(cj, 'utf-8'))
      for (const k of AUTH_KEYS) {
        if (k in liveJson) {
          pData.claude_json = pData.claude_json || {}
          pData.claude_json[k] = liveJson[k]
        }
      }
    }
    const credFile = path.join(sDir, '.claude', '.credentials.json')
    if (fs.existsSync(credFile)) {
      pData.credentials = fs.readFileSync(credFile, 'utf-8')
    }
    atomicWrite(target, JSON.stringify(pData, null, 2))
  } catch {}
}

export function runSession(home = os.homedir(), name, cmdArgs = ['claude']) {
  const resolved = resolveProfileOrAlias(home, name)
  const sDir = prepareSession(home, resolved)
  const [bin, ...args] = cmdArgs && cmdArgs.length ? cmdArgs : ['claude']
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: sDir,
  }
  const res = child_process.spawnSync(bin, args, {
    env,
    stdio: 'inherit',
    cwd: process.cwd(),
  })
  syncSessionBack(home, resolved, sDir)
  return res.status ?? 0
}

// ---------------------------------------------------------------- cli

export function formatHelpReport(color = null, lang = 'vi') {
  const useColor = shouldColor(color)
  const bold = s => (useColor ? `\x1b[1;36m${s}\x1b[0m` : s)
  const cmd = s => (useColor ? `\x1b[1;33m${s}\x1b[0m` : s)

  if (lang === 'en') {
    return [
      `🔀 ${bold('claude-swap')} — Command Usage Guide:`,
      '',
      `📌 ${bold('Profile Management & Switching:')}`,
      `  ${cmd('/profile list')}              List profiles with quotas & usage bars`,
      `  ${cmd('/profile <name|alias>')}      Quick switch to profile or alias`,
      `  ${cmd('/profile pick')}              Interactive profile picker with arrow keys ↑ ↓`,
      `  ${cmd('/profile alias <name> <p>')}  Set short alias for profile`,
      `  ${cmd('/profile unalias <name>')}    Delete alias`,
      `  ${cmd('/profile aliases')}           List all aliases`,
      `  ${cmd('/profile current')}           Show currently active profile`,
      `  ${cmd('/profile new <name>')}        Create new profile from current login`,
      `  ${cmd('/profile save <name>')}       Save current credentials to profile`,
      `  ${cmd('/profile delete <name>')}     Delete profile`,
      `  ${cmd('/profile usage')}             Detailed 5h, 7d and per-model quotas`,
      `  ${cmd('/profile folder')}            Open profile config directory`,
      `  ${cmd('/profile lang [vi|en]')}      View or switch language (Vietnamese / English)`,
      `  ${cmd('/profile run <name> [-- cmd]')} Run isolated Claude Code session in parallel`,
      `  ${cmd('/profile add-token <tok> [n]')} Register profile from setup-token or API key`,
      `  ${cmd('/profile disable <name>')}     Exclude profile from auto-switch rotation`,
      `  ${cmd('/profile enable <name>')}      Re-enable profile in auto-switch rotation`,
      `  ${cmd('/profile disabled')}           List profiles excluded from auto-switch`,
      `  ${cmd('/profile list --json')}        Output profiles list in JSON format`,
      '',
      `🤖 ${bold('Auto-Switching & Quota:')}`,
      `  ${cmd('/profile auto')}              View auto-switch status`,
      `  ${cmd('/profile auto on|off')}       Enable / disable auto-switch on limit`,
      `  ${cmd('/profile auto threshold <%>')} Set token % threshold to swap (default: 95%)`,
      `  ${cmd('/profile auto order <list>')} Set swap priority order (e.g. p1,p2)`,
      `  ${cmd('/profile auto pool <tag>')}   Limit auto-switch to tagged pool`,
      `  ${cmd('/profile auto safeguard <%>')} 7-day safeguard threshold (default: 85%)`,
      `  ${cmd('/profile auto return on|off')} Auto return to primary profile when quota resets`,
      `  ${cmd('/profile auto primary <name>')} Set primary profile to return to`,
      `  ${cmd('/profile forecast')}          Burn rate & quota exhaustion forecast`,
      `  ${cmd('/profile cooldown')}          Quota reset countdown timers`,
      `  ${cmd('/profile doctor')}            Diagnostics for accounts, tokens and health`,
      `  ${cmd('/profile cleanup')}           Detect duplicate profiles and dead tokens`,
      '',
      `📁 ${bold('Projects, Git Branches & Tags:')}`,
      `  ${cmd('/profile bind [name]')}       Bind profile to current project directory`,
      `  ${cmd('/profile unbind')}            Unbind profile from current directory`,
      `  ${cmd('/profile bind-branch <pat>')} Bind profile to Git branch pattern (e.g. work-*, feat/*)`,
      `  ${cmd('/profile unbind-branch')}     Unbind Git branch`,
      `  ${cmd('/profile branch-bindings')}   List Git branch bindings`,
      `  ${cmd('/profile tag <name> <tag>')}  Assign tag to profile`,
      `  ${cmd('/profile untag <name> <tag>')} Remove tag from profile`,
      `  ${cmd('/profile tags')}              List tags and associated profiles`,
      '',
      `🧠 ${bold('Model Affinity:')}`,
      `  ${cmd('/profile affinity <m> <p>')}  Assign profile to model (e.g. opus, sonnet)`,
      `  ${cmd('/profile unaffinity <m>')}    Remove model affinity`,
      `  ${cmd('/profile affinities')}        List model affinities`,
      '',
      `⏳ ${bold('Temporary Swap & Utilities:')}`,
      `  ${cmd('/profile temp <name> [time]')} Temporary swap with auto-revert (e.g. 30m, 1h)`,
      `  ${cmd('/profile untemp')}            Cancel temporary swap and revert immediately`,
      `  ${cmd('/profile statusline')}        Status string for Shell prompt / Tmux`,
      `  ${cmd('/profile prompt <shell>')}    Config snippet for starship, zsh, bash, tmux`,
      `  ${cmd('/profile notify on|off')}     Toggle desktop notifications on profile swap`,
      `  ${cmd('/profile history [n]')}       View recent swap history`,
      `  ${cmd('/profile stats')}             Statistics on manual vs automatic swaps`,
      '',
      `🔐 ${bold('Backup & Remote Sync:')}`,
      `  ${cmd('/profile sync [push|pull]')}  Multi-device encrypted backup sync`,
      `  ${cmd('/profile export <file>')}     Export AES-256 encrypted backup`,
      `  ${cmd('/profile import-enc <file>')} Restore from encrypted file`,
      `  ${cmd('/profile import <folder>')}   Import profiles from config directory`,
    ].join('\n')
  }

  return [
    `🔀 ${bold('claude-swap')} — Hướng dẫn sử dụng các lệnh:`,
    '',
    `📌 ${bold('Quản lý & Chuyển đổi Profile:')}`,
    `  ${cmd('/profile list')}              Liệt kê danh sách profiles kèm quota & thanh usage`,
    `  ${cmd('/profile <tên|alias>')}       Chuyển nhanh sang profile hoặc bí danh (alias)`,
    `  ${cmd('/profile pick')}              Chọn profile tương tác bằng phím mũi tên ↑ ↓`,
    `  ${cmd('/profile alias <tên> <p>')}   Đặt bí danh viết tắt cho profile`,
    `  ${cmd('/profile unalias <tên>')}     Xóa bí danh`,
    `  ${cmd('/profile aliases')}           Xem danh sách các bí danh`,
    `  ${cmd('/profile current')}           Hiển thị tên profile đang active`,
    `  ${cmd('/profile new <tên>')}         Tạo profile mới từ tài khoản hiện tại`,
    `  ${cmd('/profile save <tên>')}        Lưu thông tin đăng nhập hiện tại vào profile`,
    `  ${cmd('/profile delete <tên>')}      Xóa profile`,
    `  ${cmd('/profile usage')}             Xem chi tiết quota 5h, 7d và từng model`,
    `  ${cmd('/profile folder')}            Mở thư mục chứa file cấu hình profile`,
    `  ${cmd('/profile lang [vi|en]')}      Xem hoặc đổi ngôn ngữ (Tiếng Việt / English)`,
    `  ${cmd('/profile run <tên> [-- cmd]')} Chạy session Claude Code độc lập song song`,
    `  ${cmd('/profile add-token <tok> [tên]')} Tạo profile từ setup-token hoặc API key`,
    `  ${cmd('/profile disable <tên>')}     Tạm dừng auto-switch đối với profile`,
    `  ${cmd('/profile enable <tên>')}      Bật lại auto-switch cho profile`,
    `  ${cmd('/profile disabled')}           Xem danh sách profile đang bị tạm dừng auto`,
    `  ${cmd('/profile list --json')}        Xuất danh sách profile dưới dạng JSON`,
    '',
    `🤖 ${bold('Tự động chuyển đổi & Quota:')}`,
    `  ${cmd('/profile auto')}              Xem trạng thái tự động chuyển profile`,
    `  ${cmd('/profile auto on|off')}       Bật / tắt tự động chuyển khi vượt ngưỡng`,
    `  ${cmd('/profile auto threshold <%>')} Cài đặt ngưỡng % token để chuyển (mặc định: 95%)`,
    `  ${cmd('/profile auto order <ds>')}   Cài đặt danh sách ưu tiên switch (vd: p1,p2)`,
    `  ${cmd('/profile auto pool <tag>')}   Giới hạn auto-switch trong nhóm có tag`,
    `  ${cmd('/profile auto safeguard <%>')} Bảo vệ hạn mức 7 ngày (mặc định: 85%)`,
    `  ${cmd('/profile auto return on|off')} Tự động quay về profile chính khi hồi token`,
    `  ${cmd('/profile auto primary <tên>')} Đặt profile chính để quay về`,
    `  ${cmd('/profile forecast')}          Dự báo tốc độ tiêu thụ & thời điểm cạn hạn mức`,
    `  ${cmd('/profile cooldown')}          Xem đồng hồ đếm ngược reset quota của các account`,
    `  ${cmd('/profile doctor')}            Quét chẩn đoán sức khỏe, token và lỗi các account`,
    `  ${cmd('/profile cleanup')}           Quét phát hiện profile trùng lặp, token cũ`,
    '',
    `📁 ${bold('Dự án, Nhánh Git & Thẻ nhãn:')}`,
    `  ${cmd('/profile bind [tên]')}        Gắn profile cho thư mục dự án hiện tại`,
    `  ${cmd('/profile unbind')}            Gỡ gắn kết profile khỏi thư mục hiện tại`,
    `  ${cmd('/profile bind-branch <pat>')} Gắn profile theo mẫu nhánh Git (vd: work-*, feat/*)`,
    `  ${cmd('/profile unbind-branch')}     Gỡ gắn kết nhánh Git`,
    `  ${cmd('/profile branch-bindings')}   Xem danh sách các liên kết nhánh Git`,
    `  ${cmd('/profile tag <tên> <tag>')}   Gắn tag phân loại cho profile`,
    `  ${cmd('/profile untag <tên> <tag>')} Gỡ tag khỏi profile`,
    `  ${cmd('/profile tags')}              Xem danh sách các tag và profile thuộc về`,
    '',
    `🧠 ${bold('Phân loại Model (Affinity):')}`,
    `  ${cmd('/profile affinity <m> <p>')}  Gán profile chuyên dụng cho model (vd: opus, sonnet)`,
    `  ${cmd('/profile unaffinity <m>')}    Gỡ gán model affinity`,
    `  ${cmd('/profile affinities')}        Xem danh sách model affinities`,
    '',
    `⏳ ${bold('Mượn tạm & Tiện ích:')}`,
    `  ${cmd('/profile temp <tên> [tg]')}   Mượn tạm profile (vd: 30m, 1h) rồi tự hoàn lại`,
    `  ${cmd('/profile untemp')}            Hủy mượn tạm và quay về profile gốc ngay`,
    `  ${cmd('/profile statusline')}        Chuỗi trạng thái cho Shell prompt / Tmux`,
    `  ${cmd('/profile prompt <shell>')}    Snippet cấu hình starship, zsh, bash, tmux`,
    `  ${cmd('/profile notify on|off')}     Bật / tắt thông báo desktop khi đổi profile`,
    `  ${cmd('/profile history [n]')}       Xem lịch sử các lần chuyển đổi gần nhất`,
    `  ${cmd('/profile stats')}             Thống kê số lần đổi thủ công, tự động`,
    '',
    `🔐 ${bold('Sao lưu & Đồng bộ (Sync):')}`,
    `  ${cmd('/profile sync [push|pull]')}  Đồng bộ bản sao lưu mã hóa đa thiết bị`,
    `  ${cmd('/profile export <file>')}     Xuất bản sao lưu mã hóa AES-256`,
    `  ${cmd('/profile import-enc <file>')} Khôi phục từ file mã hóa`,
    `  ${cmd('/profile import <folder>')}   Nhập profile từ thư mục cấu hình khác`,
  ].join('\n')
}

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

  const lang = loadLanguage(home)
  const cmd = filteredArgv[0]
  const color = !noColor && shouldColor()

  if (!cmd || cmd === 'help') {
    console.log(formatHelpReport(color, lang))
    return 0
  }

  try {
    switch (cmd) {
      case 'lang':
      case 'language': {
        const target = filteredArgv[1]
        if (!target) {
          if (lang === 'en') {
            console.log(`🌐 Current language: English (en). Switch with: /profile lang <vi|en>`)
          } else {
            console.log(`🌐 Ngôn ngữ hiện tại: Tiếng Việt (vi). Đổi bằng: /profile lang <vi|en>`)
          }
          return 0
        }
        const updated = setLanguage(home, target)
        if (updated === 'en') {
          console.log(`🌐 Language switched to: English (en).`)
        } else {
          console.log(`🌐 Đã chuyển ngôn ngữ sang: Tiếng Việt (vi).`)
        }
        return 0
      }
      case 'list': {
        if (filteredArgv.includes('--json')) {
          const profiles = listProfiles(home)
          const cur = currentProfile(home)
          const disabled = loadDisabledProfiles(home)
          const data = {
            active: cur,
            profiles: profiles.map(p => ({
              name: p,
              active: p === cur,
              email: profileEmail(home, p) || null,
              tags: getProfileTags(home, p),
              disabled: disabled.includes(p),
            })),
          }
          console.log(JSON.stringify(data, null, 2))
          return 0
        }
        const refresh = filteredArgv.includes('--refresh')
        try {
          await usageRows(home, fetchUsage, refresh)
        } catch {}
        console.log(profileListReport(home, color, lang))
        return 0
      }
      case 'current': {
        if (filteredArgv.includes('--json')) {
          const cur = currentProfile(home)
          console.log(
            JSON.stringify(
              {
                current: cur,
                email: cur ? profileEmail(home, cur) || null : null,
              },
              null,
              2
            )
          )
          return 0
        }
        console.log(currentProfile(home) || '')
        return 0
      }
      case 'disable': {
        const target = filteredArgv[1]
        if (!target) {
          throw new SwapError(lang === 'en' ? 'Usage: /profile disable <name>' : 'Cú pháp: /profile disable <tên>')
        }
        const dis = disableProfile(home, target)
        console.log(
          lang === 'en'
            ? `🚫 Disabled auto-switch for profile '${dis}'.`
            : `🚫 Đã tạm tắt tự động chuyển đối với profile '${dis}'.`
        )
        return 0
      }
      case 'enable': {
        const target = filteredArgv[1]
        if (!target) {
          throw new SwapError(lang === 'en' ? 'Usage: /profile enable <name>' : 'Cú pháp: /profile enable <tên>')
        }
        const en = enableProfile(home, target)
        console.log(
          lang === 'en'
            ? `✅ Enabled auto-switch for profile '${en}'.`
            : `✅ Đã bật lại tự động chuyển đối với profile '${en}'.`
        )
        return 0
      }
      case 'disabled': {
        const list = loadDisabledProfiles(home)
        if (filteredArgv.includes('--json')) {
          console.log(JSON.stringify(list, null, 2))
          return 0
        }
        if (list.length === 0) {
          console.log(
            lang === 'en'
              ? 'No profiles are currently disabled from auto-switch.'
              : 'Không có profile nào đang bị tắt tự động chuyển.'
          )
          return 0
        }
        console.log(
          lang === 'en'
            ? '🚫 Profiles excluded from auto-switch:'
            : '🚫 Danh sách profile đang tắt tự động chuyển:'
        )
        for (const p of list) {
          console.log(`  • ${p}`)
        }
        return 0
      }
      case 'add-token': {
        const token = filteredArgv[1]
        const pName = filteredArgv[2] && !filteredArgv[2].startsWith('--') ? filteredArgv[2] : null
        const emailIdx = filteredArgv.indexOf('--email')
        const email = emailIdx !== -1 ? filteredArgv[emailIdx + 1] : null
        const force = filteredArgv.includes('--force')
        const res = addTokenProfile(home, token, pName, { email, force })
        console.log(
          lang === 'en'
            ? `🔑 Successfully registered profile '${res.name}' (${res.type}).`
            : `🔑 Đã tạo thành công profile '${res.name}' (loại: ${res.type === 'api_key' ? 'API Key' : 'OAuth Token'}).`
        )
        return 0
      }
      case 'run': {
        const target = filteredArgv[1]
        if (!target) {
          throw new SwapError(
            lang === 'en'
              ? 'Usage: /profile run <name> [-- <command...>]'
              : 'Cú pháp: /profile run <tên> [-- <lệnh...>]'
          )
        }
        const dashDash = filteredArgv.indexOf('--')
        const cmdArgs = dashDash !== -1 ? filteredArgv.slice(dashDash + 1) : ['claude']
        const code = runSession(home, target, cmdArgs)
        return code
      }
      case 'usage': {
        const refresh = filteredArgv.includes('--refresh')
        console.log(await usageReport(home, fetchUsage, refresh, color, lang))
        return 0
      }
      case 'folder': {
        const d = profilesDir(home)
        try {
          openProfilesFolder(home)
          console.log(`📁 Đã mở: ${d}`)
        } catch {
          console.log(`⚠️ Không mở được trình quản lý file. Thư mục: ${d}`)
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
        console.log(`📦 Đã nhập: ${r.added.join(', ') || '(không có)'}`)
        if (r.exists.length > 0) {
          console.log(`⚠️ Trùng tên, bỏ qua (dùng --force để ghi đè): ${r.exists.join(', ')}`)
        }
        if (r.invalid.length > 0) {
          console.log(`❌ Không phải file profile: ${r.invalid.join(', ')}`)
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
        console.log(`✨ Đã ${verb}: ${saved}`)
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
          `🔀 Đã chuyển sang '${name}'. Không cần tắt session; Claude CLI dùng tài khoản mới ở lần ` +
            'kiểm tra đăng nhập kế tiếp (có thể chưa ngay prompt sau). Xem /status để chắc chắn.'
        )
        return 0
      }
      case 'delete': {
        const name = filteredArgv[1]
        if (!name) throw new SwapError('Thiếu tên profile.')
        deleteProfile(home, name)
        console.log(`🗑️ Đã xoá '${name}'.`)
        return 0
      }
      case 'auto': {
        const sub = filteredArgv[1]
        const cfg = loadAutoSwitchConfig(home)

        if (!sub || sub === 'status') {
          console.log(`🤖 Tự động chuyển profile: ${cfg.enabled ? '🟢 BẬT' : '⚪ TẮT'} (Ngưỡng: ${cfg.threshold}%)`)
          if (cfg.order && cfg.order.length > 0) {
            console.log(`📋 Thứ tự ưu tiên: ${cfg.order.join(' ➔ ')}`)
          } else {
            console.log('📋 Quy tắc chọn: Tự động (Ưu tiên còn nhiều token hơn, thời gian reset 5h ngắn hơn)')
          }
          if (cfg.pool) {
            console.log(`🏷️ Nhóm (pool): ${cfg.pool}`)
          }
          if (cfg.safeguardThreshold) {
            console.log(`🚨 Bảo vệ 7 ngày: ${cfg.safeguardThreshold}%`)
          }
          if (cfg.autoReturn) {
            console.log(`🔄 Tự động quay về profile chính: ${cfg.primaryProfile || '(chưa đặt)'}`)
          }
          return 0
        }

        if (sub === 'on') {
          cfg.enabled = true
          saveAutoSwitchConfig(home, cfg)
          console.log('🟢 Đã BẬT tự động chuyển profile.')
          return 0
        }

        if (sub === 'off') {
          cfg.enabled = false
          saveAutoSwitchConfig(home, cfg)
          console.log('⚪ Đã TẮT tự động chuyển profile.')
          return 0
        }

        if (sub === 'threshold') {
          const val = parseFloat(filteredArgv[2])
          if (isNaN(val) || val < 1 || val > 100) {
            console.error('❌ Ngưỡng không hợp lệ. Vui lòng nhập số từ 1 đến 100.')
            return 1
          }
          cfg.threshold = Math.round(val)
          saveAutoSwitchConfig(home, cfg)
          console.log(`⚙️ Đã đặt ngưỡng tự động chuyển sang profile khác: ${cfg.threshold}%.`)
          return 0
        }

        if (sub === 'order') {
          const val = filteredArgv[2]
          if (!val || val === 'default' || val === 'none') {
            cfg.order = []
            saveAutoSwitchConfig(home, cfg)
            console.log('📋 Đã chuyển về quy tắc chọn profile tự động (nhiều token hơn, reset sớm hơn).')
            return 0
          }
          const names = val.split(',').map(s => s.trim()).filter(Boolean)
          cfg.order = names
          saveAutoSwitchConfig(home, cfg)
          console.log(`📋 Đã đặt thứ tự chuyển profile: ${names.join(' ➔ ')}.`)
          return 0
        }

        if (sub === 'check') {
          const res = await autoCheckAndSwap(home)
          if (res.swapped) {
            console.log(`[auto-swap] 🔀 Đã tự động chuyển từ '${res.from}' sang '${res.to}' (mức dùng: ${res.util}% >= ngưỡng ${res.threshold}%).`)
          } else if (res.reason === 'no_candidate') {
            console.log(`[auto-swap] ⚠️ Profile '${res.current}' đạt mức ${res.util}% nhưng không có profile thay thế khả dụng.`)
          } else if (res.reason === 'disabled') {
            console.log('ℹ️ Tự động chuyển profile đang tắt.')
          } else {
            console.log(`✅ Không cần chuyển profile (mức dùng: ${res.util}%, ngưỡng: ${res.threshold}%).`)
          }
          return 0
        }

        if (sub === 'pool') {
          const val = filteredArgv[2]
          if (!val || val === 'all' || val === 'default' || val === 'none') {
            cfg.pool = null
            saveAutoSwitchConfig(home, cfg)
            console.log('🏷️ Đã mở auto-switch cho tất cả các profile (không giới hạn pool).')
            return 0
          }
          cfg.pool = val.trim()
          saveAutoSwitchConfig(home, cfg)
          console.log(`🏷️ Đã đặt nhóm (pool) cho auto-switch: '${cfg.pool}'.`)
          return 0
        }

        if (sub === 'return') {
          const state = filteredArgv[2]
          if (state === 'on') {
            cfg.autoReturn = true
            saveAutoSwitchConfig(home, cfg)
            console.log('🔄 Đã BẬT tự động quay về profile chính (auto-return).')
            return 0
          }
          if (state === 'off') {
            cfg.autoReturn = false
            saveAutoSwitchConfig(home, cfg)
            console.log('⚪ Đã TẮT tự động quay về profile chính (auto-return).')
            return 0
          }
          console.log(`🔄 Tự động quay về profile chính: ${cfg.autoReturn ? '🟢 BẬT' : '⚪ TẮT'}`)
          return 0
        }

        if (sub === 'primary') {
          const name = filteredArgv[2]
          if (!name) {
            console.log(`⭐ Profile chính hiện tại: ${cfg.primaryProfile || '(chưa đặt)'}`)
            return 0
          }
          if (!profileExists(home, name)) {
            throw new SwapError(`Profile '${name}' không tồn tại.`)
          }
          cfg.primaryProfile = name
          saveAutoSwitchConfig(home, cfg)
          console.log(`⭐ Đã đặt profile chính cho auto-return: '${name}'.`)
          return 0
        }

        if (sub === 'safeguard') {
          const val = filteredArgv[2]
          if (!val) {
            console.log(`🚨 Bảo vệ hạn mức 7 ngày: ${cfg.safeguardThreshold ? `🟢 BẬT (${cfg.safeguardThreshold}%)` : '⚪ TẮT'}`)
            return 0
          }
          if (val === 'on') {
            cfg.safeguardThreshold = 85
            saveAutoSwitchConfig(home, cfg)
            console.log('🚨 Đã BẬT bảo vệ hạn mức 7 ngày (ngưỡng: 85%).')
            return 0
          }
          if (val === 'off' || val === 'none') {
            cfg.safeguardThreshold = null
            saveAutoSwitchConfig(home, cfg)
            console.log('⚪ Đã TẮT bảo vệ hạn mức 7 ngày.')
            return 0
          }
          const num = parseInt(val, 10)
          if (isNaN(num) || num < 1 || num > 100) {
            throw new SwapError('Ngưỡng bảo vệ 7 ngày không hợp lệ. Vui lòng nhập số từ 1 đến 100.')
          }
          cfg.safeguardThreshold = num
          saveAutoSwitchConfig(home, cfg)
          console.log(`🚨 Đã đặt ngưỡng bảo vệ hạn mức 7 ngày: ${num}%.`)
          return 0
        }

        console.error(`❌ Lệnh auto không hợp lệ: ${sub}. Dùng: /profile auto [on|off|threshold <%>|order <ds>|pool <tag|all>|safeguard [on|off|<%>]|return [on|off]|primary <tên>|check]`)
        return 1
      }
      case 'bind': {
        const sub = filteredArgv[1]
        if (sub === 'get') {
          const targetDir = filteredArgv[2] || process.cwd()
          const branchBound = getBoundBranchProfile(home, targetDir)
          if (branchBound) {
            console.log(`🔗 Thư mục '${targetDir}' đang liên kết với profile: ${branchBound.profile} (branch: ${branchBound.branch})`)
            return 0
          }
          const bound = getBoundProfile(home, targetDir)
          if (bound) {
            console.log(`🔗 Thư mục '${targetDir}' đang liên kết với profile: ${bound.profile} (${bound.source})`)
          } else {
            console.log(`ℹ️ Thư mục '${targetDir}' chưa liên kết với profile nào.`)
          }
          return 0
        }
        const profileName = sub || currentProfile(home)
        const targetDir = filteredArgv[2] || process.cwd()
        if (!profileName) throw new SwapError('Thiếu tên profile để liên kết.')
        const res = bindProfile(home, targetDir, profileName)
        console.log(`🔗 Đã liên kết thư mục '${res.dir}' với profile '${res.profile}'.`)
        return 0
      }
      case 'unbind': {
        const targetDir = filteredArgv[1] || process.cwd()
        const res = unbindProfile(home, targetDir)
        console.log(`🔓 Đã gỡ liên kết profile cho thư mục '${res.dir}'.`)
        return 0
      }
      case 'notify': {
        const sub = filteredArgv[1]
        const cfg = loadNotificationConfig(home)
        if (!sub || sub === 'status') {
          console.log(`🔔 Thông báo hệ thống: ${cfg.enabled ? '🟢 BẬT' : '⚪ TẮT'}`)
          return 0
        }
        if (sub === 'on') {
          cfg.enabled = true
          saveNotificationConfig(home, cfg)
          console.log('🔔 Đã BẬT thông báo hệ thống.')
          return 0
        }
        if (sub === 'off') {
          cfg.enabled = false
          saveNotificationConfig(home, cfg)
          console.log('🔕 Đã TẮT thông báo hệ thống.')
          return 0
        }
        console.error(`❌ Lệnh notify không hợp lệ: ${sub}. Dùng: /profile notify [on|off]`)
        return 1
      }
      case 'tag': {
        const name = filteredArgv[1]
        const tag = filteredArgv[2]
        if (!name || !tag) throw new SwapError('Cú pháp: /profile tag <tên profile> <tag>')
        const tags = addProfileTag(home, name, tag)
        console.log(`🏷️ Đã gắn tag '${tag}' cho profile '${name}'. Tags hiện tại: ${tags.join(', ')}`)
        return 0
      }
      case 'untag': {
        const name = filteredArgv[1]
        const tag = filteredArgv[2]
        if (!name || !tag) throw new SwapError('Cú pháp: /profile untag <tên profile> <tag>')
        const tags = removeProfileTag(home, name, tag)
        console.log(`🏷️ Đã gỡ tag '${tag}' khỏi profile '${name}'. Tags hiện tại: ${tags.join(', ') || '(không có)'}`)
        return 0
      }
      case 'tags': {
        const map = listAllTags(home)
        const entries = Object.entries(map)
        if (entries.length === 0) {
          console.log('🏷️ Chưa có tag nào được tạo. Dùng: /profile tag <profile> <tag>')
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
        console.log(`🔐 Đã xuất ${res.count} profiles đã mã hóa ra: ${res.path}`)
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
        console.log(`📦 Đã nhập thành công: ${res.added.join(', ') || '(không có profile mới)'}`)
        if (res.exists.length > 0) {
          console.log(`⚠️ Bỏ qua profile đã tồn tại (dùng --force để ghi đè): ${res.exists.join(', ')}`)
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
      case 'cooldown': {
        console.log(formatCooldowns(home, null, lang))
        return 0
      }
      case 'doctor': {
        const diag = diagnoseProfiles(home)
        console.log(formatDiagnostics(diag, color, lang))
        return 0
      }
      case 'statusline': {
        console.log(getStatusline(home))
        return 0
      }
      case 'prompt': {
        const shell = filteredArgv[1] || 'starship'
        console.log(generatePromptSnippet(shell))
        return 0
      }
      case 'temp': {
        const name = filteredArgv[1]
        const dur = filteredArgv[2] || '1h'
        if (!name) {
          const state = loadTempProfile(home)
          if (state) {
            const remMin = Math.max(0, Math.round((state.expiresAt - Date.now()) / 60000))
            console.log(`⏳ Đang mượn tạm profile '${state.tempProfile}' (gốc: '${state.originalProfile}', còn ${remMin} phút).`)
          } else {
            console.log('ℹ️ Hiện không ở chế độ profile tạm thời. Dùng: /profile temp <tên> [thời_gian]')
          }
          return 0
        }
        const res = tempSwap(home, name, dur)
        const expTime = new Date(res.expiresAt).toLocaleTimeString('vi-VN')
        console.log(`⏳ Đã chuyển tạm thời sang '${res.tempProfile}' trong ${dur} (hết hạn lúc ${expTime}).`)
        return 0
      }
      case 'untemp': {
        const res = cancelTempSwap(home)
        console.log(`🔄 Đã hoàn tất profile tạm thời và quay về '${res.revertedTo}'.`)
        return 0
      }
      case 'alias': {
        const alias = filteredArgv[1]
        const profile = filteredArgv[2]
        if (!alias || !profile) {
          throw new SwapError('Cú pháp: /profile alias <tên_alias> <tên_profile>')
        }
        setAlias(home, alias, profile)
        console.log(`🔤 Đã gán alias '${alias}' ➔ '${profile}'.`)
        return 0
      }
      case 'unalias': {
        const alias = filteredArgv[1]
        if (!alias) throw new SwapError('Cú pháp: /profile unalias <tên_alias>')
        removeAlias(home, alias)
        console.log(`🔤 Đã xoá alias '${alias}'.`)
        return 0
      }
      case 'aliases': {
        const aliases = listAliases(home)
        const entries = Object.entries(aliases)
        if (entries.length === 0) {
          console.log('Chưa có alias nào. Dùng: /profile alias <tên> <profile>')
          return 0
        }
        console.log('🔤 Danh sách alias profile:')
        for (const [a, p] of entries) {
          console.log(`  • ${a} ➔ ${p}`)
        }
        return 0
      }
      case 'bind-branch': {
        const pattern = filteredArgv[1]
        if (pattern === 'get') {
          const targetDir = filteredArgv[2] || process.cwd()
          const bound = getBoundBranchProfile(home, targetDir)
          if (bound) {
            console.log(`🌿 Nhánh '${bound.branch}' đang liên kết với profile: ${bound.profile} (khớp pattern '${bound.pattern}')`)
          } else {
            console.log('🌿 Nhánh hiện tại chưa liên kết với profile nào.')
          }
          return 0
        }
        const profile = filteredArgv[2] || currentProfile(home)
        const dir = filteredArgv[3] || process.cwd()
        if (!pattern || !profile) {
          throw new SwapError('Cú pháp: /profile bind-branch <pattern> [tên_profile]')
        }
        const res = bindBranch(home, dir, pattern, profile)
        console.log(`🌿 Đã liên kết pattern nhánh '${res.pattern}' với profile '${res.profile}'.`)
        return 0
      }
      case 'unbind-branch': {
        const pattern = filteredArgv[1] || null
        const dir = filteredArgv[2] || process.cwd()
        const res = unbindBranch(home, dir, pattern)
        console.log(`🌿 Đã gỡ ${res.removed} liên kết nhánh trong '${res.dir}'.`)
        return 0
      }
      case 'branch-bindings': {
        const bindings = loadBranchBindings(home)
        const entries = Object.entries(bindings)
        if (entries.length === 0) {
          console.log('Chưa có liên kết nhánh nào. Dùng: /profile bind-branch <pattern> <profile>')
          return 0
        }
        console.log('🌿 Danh sách liên kết nhánh Git:')
        for (const [d, list] of entries) {
          console.log(`📁 ${d}:`)
          for (const item of list) {
            console.log(`   • ${item.pattern} ➔ ${item.profile}`)
          }
        }
        return 0
      }
      case 'forecast': {
        console.log(formatForecastReport(home, lang))
        return 0
      }
      case 'pick': {
        const res = await interactivePickProfile(home)
        if (res.selected) {
          console.log(`🎛️ Đã chọn profile: ${res.selected}`)
        }
        return 0
      }
      case 'sync': {
        const sub = filteredArgv[1]
        if (!sub || sub === 'status') {
          const cfg = loadSyncConfig(home)
          console.log('☁️ Trạng thái đồng bộ (Encrypted Sync):')
          console.log(`  • Đường dẫn đích: ${cfg.targetPath || '(chưa đặt)'}`)
          console.log(`  • Lần push gần nhất: ${cfg.lastPush ? new Date(cfg.lastPush).toLocaleString('vi-VN') : '(chưa có)'}`)
          console.log(`  • Lần pull gần nhất: ${cfg.lastPull ? new Date(cfg.lastPull).toLocaleString('vi-VN') : '(chưa có)'}`)
          return 0
        }
        if (sub === 'setup') {
          const target = filteredArgv[2]
          if (!target) throw new SwapError('Cú pháp: /profile sync setup <đường_dẫn_file> [--password <mật_khẩu>]')
          const passIndex = filteredArgv.indexOf('--password')
          const password = passIndex !== -1 ? filteredArgv[passIndex + 1] : ''
          const cfg = loadSyncConfig(home)
          cfg.targetPath = path.resolve(target)
          if (password) cfg.password = password
          saveSyncConfig(home, cfg)
          console.log(`☁️ Đã thiết lập đồng bộ với đường dẫn: ${cfg.targetPath}`)
          return 0
        }
        if (sub === 'push') {
          const passIndex = filteredArgv.indexOf('--password')
          const password = passIndex !== -1 ? filteredArgv[passIndex + 1] : ''
          const target = filteredArgv.slice(2).find(a => a !== '--password' && a !== password)
          const res = syncPush(home, target, password)
          console.log(`☁️ Đã đẩy bản sao lưu mã hóa (${res.count} profiles) lên: ${res.path}`)
          return 0
        }
        if (sub === 'pull') {
          const passIndex = filteredArgv.indexOf('--password')
          const password = passIndex !== -1 ? filteredArgv[passIndex + 1] : ''
          const force = filteredArgv.includes('--force')
          const target = filteredArgv.slice(2).find(a => a !== '--password' && a !== password && a !== '--force')
          const res = syncPull(home, target, password, force)
          console.log(`☁️ Đã tải thành công: ${res.added.join(', ') || '(không có profile mới)'}`)
          return 0
        }
        console.error(`❌ Lệnh sync không hợp lệ: ${sub}. Dùng: /profile sync [setup|push|pull|status]`)
        return 1
      }
      case 'affinity': {
        const sub = filteredArgv[1]
        if (sub === 'apply') {
          const model = filteredArgv[2]
          if (!model) throw new SwapError('Cú pháp: /profile affinity apply <tên_model>')
          const affinities = listModelAffinities(home)
          const target = affinities[model.toLowerCase()]
          if (!target) {
            console.log(`ℹ️ Không có profile nào được gán cho model '${model}'.`)
            return 0
          }
          swapProfile(home, target, { type: 'manual', reason: `Affinity for ${model}` })
          console.log(`🧠 Đã chuyển sang profile '${target}' theo affinity model '${model}'.`)
          return 0
        }
        const model = filteredArgv[1]
        const profile = filteredArgv[2]
        if (!model || !profile) {
          throw new SwapError('Cú pháp: /profile affinity <tên_model> <tên_profile>')
        }
        setModelAffinity(home, model, profile)
        console.log(`🧠 Đã gán model '${model}' ➔ profile '${profile}'.`)
        return 0
      }
      case 'unaffinity': {
        const model = filteredArgv[1]
        if (!model) throw new SwapError('Cú pháp: /profile unaffinity <tên_model>')
        removeModelAffinity(home, model)
        console.log(`🧠 Đã gỡ affinity cho model '${model}'.`)
        return 0
      }
      case 'affinities': {
        const map = listModelAffinities(home)
        const entries = Object.entries(map)
        if (entries.length === 0) {
          console.log('Chưa có cấu hình affinity model nào. Dùng: /profile affinity <model> <profile>')
          return 0
        }
        console.log('🧠 Danh sách model affinity:')
        for (const [m, p] of entries) {
          console.log(`  • ${m} ➔ ${p}`)
        }
        return 0
      }
      case 'cleanup': {
        const force = filteredArgv.includes('--force')
        if (force) {
          const res = cleanupProfiles(home, { force: true })
          console.log(`🧹 Đã dọn dẹp các profile bị hỏng: ${res.cleaned.join(', ') || '(không có)'}`)
          return 0
        }
        const analysis = analyzeProfilesForCleanup(home)
        console.log(formatCleanupReport(analysis, color, lang))
        return 0
      }
      default:
        console.error(lang === 'en' ? `❌ Invalid command: ${cmd}` : `❌ Lệnh không hợp lệ: ${cmd}`)
        return 1
    }
  } catch (err) {
    if (err instanceof SwapError) {
      console.error(lang === 'en' ? `❌ Error: ${err.message}` : `❌ Lỗi: ${err.message}`)
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
