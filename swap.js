#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import child_process from 'node:child_process'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

export const AUTH_KEYS = ['oauthAccount', 'primaryApiKey', 'customApiKeyResponses']
export const KEYCHAIN_SERVICE = 'Claude Code-credentials'
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
export const WARN_PCT = 80
export const USAGE_TTL = 300 // seconds
export const USAGE_BACKOFF = 600 // seconds
export const LABEL_5H = '5 giờ'
export const LABEL_7D = '7 ngày'
export const USAGE_LIMITS = [
  ['five_hour', LABEL_5H],
  ['seven_day', LABEL_7D],
  ['seven_day_opus', '7 ngày Opus'],
  ['seven_day_sonnet', '7 ngày Sonnet'],
]
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export class SwapError extends Error {}
export class ProfileExists extends SwapError {}

// ---------------------------------------------------------------- paths

// Claude Code's config home. With CLAUDE_CONFIG_DIR set it reads <dir>/.claude.json and <dir>/.credentials.json
// instead of ~/.claude.json and ~/.claude/.credentials.json. Honoured only for the real home: callers that pass
// another home (tests, sandboxes) must never be redirected into the user's actual config.
export function claudeConfigDir(home) {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir && home === os.homedir() ? dir : null
}

export function claudeJson(home) {
  return path.join(claudeConfigDir(home) || home, '.claude.json')
}

export function credentialsFile(home) {
  return path.join(claudeConfigDir(home) || path.join(home, '.claude'), '.credentials.json')
}

function dirHash(dir) {
  return crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)
}

// name of the profile whose `/profile run` session we are inside, else null
export function isolatedSession(home) {
  const dir = claudeConfigDir(home)
  if (!dir) return null
  const rel = path.relative(path.join(profilesDir(home), '.sessions'), path.resolve(dir))
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : null
}

const readyDirs = new Set()

export function profilesDir(home) {
  const d = path.join(home, '.config', 'claude-cli-profiles')
  if (readyDirs.has(d)) return d
  fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(d, 0o700)
  } catch {}
  readyDirs.add(d)
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

// Node's JSON.parse errors quote the input ("sk-ant-…" is not valid JSON): never echo them for secret files
function safeError(err) {
  return err instanceof SyntaxError ? 'JSON không hợp lệ' : err.message
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
    renameWithRetry(tmp, filePath)
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

// on Windows an antivirus/indexer can hold the target for a moment; retry like graceful-fs does
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to)
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

// fire-and-forget helper: a missing binary (no notify-send/xdg-open) emits 'error' asynchronously,
// which crashes the process when nobody listens
export function spawnDetached(cmd, args, options = {}) {
  try {
    const child = child_process.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options })
    child.on('error', () => {})
    child.unref()
    return child
  } catch {
    return null
  }
}

// npm installs `claude` as claude.cmd on Windows, which Node refuses to spawn without a shell
// ponytail: only whitespace/quotes are escaped for cmd.exe; args with & | ^ < > are not supported there
export function spawnClaudeSync(bin, args, options = {}) {
  if (process.platform !== 'win32') return child_process.spawnSync(bin, args, options)
  const quote = a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
  return child_process.spawnSync(quote(bin), args.map(quote), { ...options, shell: true })
}

export function backup(filePath) {
  if (fs.existsSync(filePath)) {
    // atomicWrite creates it 0600 from the start; copy+chmod left a window where it had the source's mode
    atomicWrite(`${filePath}.bak`, fs.readFileSync(filePath, 'utf-8'))
  }
}

// ---------------------------------------------------------------- credentials

export function useKeychain(home) {
  return process.platform === 'darwin' && !fs.existsSync(credentialsFile(home))
}

// same account name Claude Code uses, so `-U` updates its item instead of adding a second one
function keychainAccount() {
  let user
  try {
    user = process.env.USER || os.userInfo().username
  } catch {}
  return user && /^[A-Za-z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

function readKeychain(service) {
  try {
    const res = child_process.execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return res.trim() || null
  } catch {
    return null
  }
}

// `security -i` reads the command from stdin, so the token never appears in the process list (`ps`).
// Same command shape and length fallback as Claude Code's own Keychain writer.
export function keychainWriteCommand(service, account, data) {
  // the line is parsed by `security -i`: keep quoted fields free of quotes/backslashes/newlines
  if (/["\\\n]/.test(account + service)) throw new SwapError(`Tên Keychain không hợp lệ: ${service}`)
  const hex = Buffer.from(data, 'utf-8').toString('hex')
  return `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`
}

const SECURITY_STDIN_MAX = 4000 // `security -i` line buffer; longer payloads fall back to argv

function writeKeychain(service, data) {
  const account = keychainAccount()
  const line = keychainWriteCommand(service, account, data)
  const res =
    line.length <= SECURITY_STDIN_MAX
      ? child_process.spawnSync('security', ['-i'], { input: line, encoding: 'utf-8', timeout: 10000 })
      : child_process.spawnSync(
          'security',
          ['add-generic-password', '-U', '-a', account, '-s', service, '-X', Buffer.from(data, 'utf-8').toString('hex')],
          { encoding: 'utf-8', timeout: 10000 }
        )
  if (res.error || res.status !== 0) {
    const why = res.error?.message || `${res.stderr || res.stdout || ''}`.trim() || `exit ${res.status}`
    throw new SwapError(`Không ghi được Keychain: ${why}`)
  }
}

function deleteKeychain(service) {
  try {
    child_process.execFileSync('security', ['delete-generic-password', '-s', service], { stdio: 'ignore' })
  } catch {}
}

// with CLAUDE_CONFIG_DIR set, Claude Code on macOS keeps credentials under a per-dir Keychain item
export function sessionKeychainService(configDir) {
  return `${KEYCHAIN_SERVICE}-${dirHash(configDir)}`
}

function keychainService(home) {
  const dir = claudeConfigDir(home)
  return dir ? sessionKeychainService(dir) : KEYCHAIN_SERVICE
}

export function readCredentials(home) {
  if (useKeychain(home)) return readKeychain(keychainService(home))
  const f = credentialsFile(home)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null
}

export function writeCredentials(home, data) {
  if (useKeychain(home)) return writeKeychain(keychainService(home), data)
  const f = credentialsFile(home)
  backup(f)
  atomicWrite(f, data)
}

// `.credentials.json` also holds `mcpOAuth` (the MCP servers' own logins), which belong to the machine,
// not the account: keep the live ones so a swap does not hand back each profile's stale snapshot.
export function keepLiveMcpOAuth(liveRaw, targetRaw) {
  try {
    const live = JSON.parse(liveRaw)
    const target = JSON.parse(targetRaw)
    if (!live?.mcpOAuth || !target || typeof target !== 'object') return targetRaw
    return JSON.stringify({ ...target, mcpOAuth: live.mcpOAuth }, null, 2)
  } catch {
    return targetRaw
  }
}

export function clearCredentials(home) {
  if (useKeychain(home)) return deleteKeychain(keychainService(home))
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
    throw new SwapError(`${p} bị hỏng JSON: ${safeError(err)}`)
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

// which profile a config dir currently holds; one pointer per config dir (default home → `.current`)
export function currentFileFor(home, configDir = null) {
  return path.join(profilesDir(home), configDir ? `.current-${dirHash(configDir)}` : '.current')
}

export function readCurrent(home) {
  const dir = claudeConfigDir(home)
  // a user who set CLAUDE_CONFIG_DIR globally before pointers were per-dir still has it in `.current`
  const files = [currentFileFor(home, dir), ...(dir && !isolatedSession(home) ? [currentFileFor(home)] : [])]
  for (const f of files) {
    try {
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8').trim()
    } catch {}
  }
  return ''
}

export function currentProfile(home) {
  const name = readCurrent(home)
  if (!name) return null
  return fs.existsSync(profilePath(home, name)) ? name : null
}

export function setCurrent(home, name) {
  const f = currentFileFor(home, claudeConfigDir(home))
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
  const session = isolatedSession(home)
  if (session) {
    throw new SwapError(
      `Đang ở trong session cô lập của profile '${session}' (/profile run). Thoát session đó để đổi tài khoản.`
    )
  }
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
    throw new SwapError(`File profile '${resolved}' bị hỏng: ${safeError(err)}`)
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

  const liveCredentials = readCredentials(home)
  backup(cj)
  atomicWrite(cj, JSON.stringify(data, null, 2))

  if (profile.credentials) {
    writeCredentials(home, liveCredentials ? keepLiveMcpOAuth(liveCredentials, profile.credentials) : profile.credentials)
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

  trackWebhook(
    sendWebhookNotification(home, {
      event: 'swap',
      profile: resolved,
      previousProfile: cur || null,
      reason: options.reason || '',
      type: options.type || 'manual',
    })
  )
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

// swap counts by kind, and how often each profile was swapped to (`stats --json` prints this)
export function swapStats(home) {
  const stats = { total: 0, manual: 0, auto: 0, project: 0, byProfile: {} }
  for (const item of loadSwapHistory(home)) {
    stats.total++
    stats[item.type === 'auto' || item.type === 'project' ? item.type : 'manual']++
    if (item.to) stats.byProfile[item.to] = (stats.byProfile[item.to] || 0) + 1
  }
  return stats
}

export function formatSwapStats(home) {
  const stats = swapStats(home)
  if (stats.total === 0) {
    return 'Chưa có dữ liệu thống kê chuyển profile.'
  }
  const sortedProfiles = Object.entries(stats.byProfile).sort((a, b) => b[1] - a[1])
  const topStr = sortedProfiles.map(([name, count]) => `${name} (${count})`).join(', ')

  return [
    '📊 Thống kê chuyển đổi profile:',
    `- Tổng số lần chuyển: ${stats.total}`,
    `- Thủ công (manual): ${stats.manual}`,
    `- Tự động (auto): ${stats.auto}`,
    `- Theo dự án (project): ${stats.project}`,
    `- Profile được chuyển đến nhiều nhất: ${topStr || '(chưa có)'}`,
  ].join('\n')
}

export function deleteProfile(home, name) {
  const resolved = resolveProfileOrAlias(home, name)
  const f = profilePath(home, resolved)
  if (!fs.existsSync(f)) {
    throw new SwapError(`Không có profile '${name}'.`)
  }
  fs.unlinkSync(f)
  if (readCurrent(home) === resolved) {
    setCurrent(home, null)
  }
  try {
    enableProfile(home, resolved)
  } catch {}
  try {
    const sDir = sessionDir(home, resolved)
    if (fs.existsSync(sDir)) {
      fs.rmSync(sDir, { recursive: true, force: true })
      fs.rmSync(currentFileFor(home, sDir), { force: true })
      if (process.platform === 'darwin') deleteKeychain(sessionKeychainService(sDir))
    }
  } catch {}
}

// Runs `edit` over a state file's JSON and saves the result when it changed; a missing or corrupt file is left alone.
function editStateFile(file, edit) {
  try {
    if (!fs.existsSync(file)) return
    const before = fs.readFileSync(file, 'utf-8')
    const after = JSON.stringify(edit(JSON.parse(before)), null, 2)
    if (after !== JSON.stringify(JSON.parse(before), null, 2)) atomicWrite(file, after)
  } catch {}
}

// Every dotfile beside the profiles that is keyed by or points at a profile name must be handled here.
export function renameProfile(home, oldName, newName) {
  const from = resolveProfileOrAlias(home, oldName)
  const to = checkName(newName)
  const src = profilePath(home, from)
  if (!fs.existsSync(src)) throw new SwapError(`Không có profile '${oldName}'.`)
  if (from === to) throw new SwapError('Tên mới trùng tên cũ.')
  const target = profilePath(home, to)
  // "Work" -> "work" on a case-insensitive disk resolves to the very same file: that is a rename, not a clash
  const sameFile = () => fs.statSync(target).ino === fs.statSync(src).ino
  if (fs.existsSync(target) && !(from.toLowerCase() === to.toLowerCase() && sameFile())) {
    throw new SwapError(`Profile '${to}' đã tồn tại.`)
  }
  if (loadAliases(home)[to]) throw new SwapError(`'${to}' đang là alias của '${loadAliases(home)[to]}'. Xóa alias trước (/profile unalias ${to}).`)
  const session = isolatedSession(home)
  if (session === from) throw new SwapError(`Đang ở trong session cô lập của '${from}'. Thoát session đó rồi đổi tên.`)

  renameWithRetry(src, target)

  const dir = profilesDir(home)
  const swap = v => (v === from ? to : v)
  const swapKeys = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]))
  // pointers to the active profile (the default one and one per CLAUDE_CONFIG_DIR)
  for (const f of fs.readdirSync(dir).filter(f => f === '.current' || f.startsWith('.current-'))) {
    try {
      if (fs.readFileSync(path.join(dir, f), 'utf-8').trim() === from) atomicWrite(path.join(dir, f), to)
    } catch {}
  }
  const state = f => path.join(dir, f)
  editStateFile(state('.aliases.json'), a => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, swap(v)])))
  editStateFile(state('.model-affinity.json'), a => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, swap(v)])))
  editStateFile(state('.project-bindings.json'), b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, swap(v)])))
  editStateFile(state('.branch-bindings.json'), b =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => ({ ...x, profile: swap(x.profile) })) : v]))
  )
  editStateFile(state('.disabled.json'), l => (Array.isArray(l) ? l.map(swap) : l))
  editStateFile(state('.schedule.json'), sc => ({ ...sc, rules: (sc.rules || []).map(r => ({ ...r, profile: swap(r.profile) })) }))
  editStateFile(state('.auto-switch.json'), c => ({
    ...c,
    ...(Array.isArray(c.order) ? { order: c.order.map(swap) } : {}),
    ...(c.primaryProfile ? { primaryProfile: swap(c.primaryProfile) } : {}),
  }))
  editStateFile(state('.temp-profile.json'), t => ({ ...t, tempProfile: swap(t.tempProfile), originalProfile: swap(t.originalProfile) }))
  editStateFile(state('.swap-history.json'), h => (Array.isArray(h) ? h.map(e => ({ ...e, from: swap(e.from), to: swap(e.to) })) : h))
  editStateFile(state('.budget.json'), b => ({ ...b, ...(b.limits ? { limits: swapKeys(b.limits) } : {}) }))
  editStateFile(state('.usage-history.json'), swapKeys)
  editStateFile(state('.usage-cache.json'), c =>
    Object.fromEntries(Object.entries(c).map(([k, v]) => [k.startsWith(`${from}|`) ? `${to}|${k.slice(from.length + 1)}` : k, v]))
  )
  // the `.claude-profile` marker a project bind leaves in the project folder
  for (const [projectDir, bound] of Object.entries(loadProjectBindings(home))) {
    const marker = path.join(projectDir, '.claude-profile')
    try {
      if (bound === to && fs.readFileSync(marker, 'utf-8').trim() === from) fs.writeFileSync(marker, `${to}\n`, 'utf-8')
    } catch {}
  }
  // the isolated `run` session keeps its tokens under the old name: move it (its Keychain item is per directory)
  try {
    const oldDir = sessionDir(home, from)
    if (fs.existsSync(oldDir)) {
      const newDir = sessionDir(home, to)
      fs.rmSync(newDir, { recursive: true, force: true }) // a leftover of a profile that used to have this name
      fs.renameSync(oldDir, newDir)
      fs.rmSync(currentFileFor(home, oldDir), { force: true })
      atomicWrite(currentFileFor(home, newDir), to)
      if (process.platform === 'darwin') deleteKeychain(sessionKeychainService(oldDir))
    }
  } catch {}
  return { from, to }
}

export function openProfilesFolder(home) {
  const d = profilesDir(home)
  const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawnDetached(opener, [d])
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
      out.set(label, [label, Number(lim.utilization), fmtReset(lim.resets_at), lim.resets_at || null])
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
      out.set(label, [label, Number(lim.percent), fmtReset(lim.resets_at), lim.resets_at || null])
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
  const key = `${name}|${row.email}`
  const hit = cache[key] && typeof cache[key] === 'object' ? cache[key] : {}
  if (!token) {
    const note = 'không có token OAuth (API key không có quota gói)'
    cache[key] = { ...hit, note } // replaces an older note, which `list` would otherwise keep showing
    return { ...row, note }
  }

  const cached = Array.isArray(hit.limits) ? hit.limits : []
  const now = Date.now() / 1000

  if (typeof expires === 'number' && expires < Date.now()) {
    const note = `token đã hết hạn — chuyển sang profile này (swap ${name}) để CLI làm mới`
    cache[key] = { ...hit, note }
    return { ...row, note }
  }

  if (hit.retry_at && hit.retry_at > now) {
    return { ...row, limits: cached, note: rateLimitedNote(hit, cached.length > 0) }
  }
  // failures are cached too, so an offline machine does not refetch on every prompt
  if (!force && now - (hit.at || 0) < USAGE_TTL) {
    return { ...row, limits: cached, note: cached.length ? '' : hit.note || '' }
  }

  try {
    const data = await fetchFn(token)
    const limits = parseLimits(data)
    cache[key] = { limits, at: now }
    if (limits.length) {
      const entry = { limits }
      recordUsageSnapshot(home, name, limitPct(entry, LABEL_5H), limitPct(entry, LABEL_7D), active ? process.cwd() : null)
    }
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
    cache[key] = { ...hit, at: now, note }
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

// Refreshes the quota cache for just these profiles (an entry still inside USAGE_TTL is not refetched).
// The prompt path uses it so a check costs one request for the current profile, not one per profile.
export async function refreshUsage(home, names, fetchFn = fetchUsage) {
  const cur = currentProfile(home)
  const cache = loadUsageCache(home)
  await Promise.all(
    [...new Set(names)]
      .filter(n => n && profileExists(home, n))
      .map(n => profileUsage(home, n, n === cur, fetchFn, cache))
  )
  try {
    atomicWrite(usageCacheFile(home), JSON.stringify(cache, null, 2))
  } catch {}
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

function pctCode(pct) {
  if (pct >= 95) return '1;31'
  if (pct >= WARN_PCT) return '1;38;5;208'
  if (pct >= 50) return '1;33'
  return '1;32'
}

function pctColor(pct) {
  return `\x1b[${pctCode(pct)}m`
}

export function chartBar(pct, width = 8, color = false) {
  const filled = Math.round((Math.max(0, Math.min(pct, 100)) / 100) * width)
  const empty = width - filled
  if (!color) {
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
  }
  const c = pctColor(pct)
  return `\x1b[90m[\x1b[0m${c}${'█'.repeat(filled)}\x1b[0m\x1b[38;5;240m${'░'.repeat(empty)}\x1b[90m]\x1b[0m`
}

// time left until this limit resets as "2h15m", or '' when the cache has no (usable) reset time
function resetIn(hit, lim) {
  const at = lim ? parseResetTime(hit, lim) : NaN
  return Number.isFinite(at) && at !== Number.MAX_SAFE_INTEGER ? shortDuration(at - Date.now()) : ''
}

// 2h15m, 45m, 3d4h: the time left until a quota window resets
function shortDuration(ms) {
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60000)
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
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
  const disabledList = loadDisabledProfiles(home)
  const masking = isMaskingEnabled(home)
  const useColor = shouldColor(color)
  const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)

  // every quota cell is CELL_W columns wide, so the 5h and 7d columns line up row after row
  const CELL_W = 17
  const RESET_W = 8
  const cell = hit => (label) => {
    const lim = findLimit(hit, label)
    if (!lim) return { shown: paint('90', '—'.padEnd(CELL_W)) }
    const pct = Math.max(0, Math.min(Number(lim[1]) || 0, 100))
    const n = Math.round(pct)
    const num = `${String(n).padStart(3)}%`
    const warn = n >= WARN_PCT ? '🔥' : '  ' // an emoji is always 2 columns wide, unlike ⚠, so the next column never slips
    return { shown: `${chartBar(pct, 8, useColor)} ${useColor ? `${pctColor(n)}${num}\x1b[0m` : num}${warn}` }
  }

  const rows = profiles.map(n => {
    const email = maskEmail(profileEmail(home, n), masking) || ''
    const hit = cacheHit(home, cache, n)
    const limits = Array.isArray(hit.limits) ? hit.limits : []
    const at = cell(hit)
    const resetCell = label => (resetIn(hit, findLimit(hit, label)) || '—').padEnd(RESET_W)
    const quota = limits.length
      ? [at(LABEL_5H).shown, at(LABEL_7D).shown, paint('36', resetCell(LABEL_5H)), paint('36', resetCell(LABEL_7D).trimEnd())].join('  ')
      : hit.note
        ? paint('1;33', `(${hit.note})`)
        : paint('90', '—'.padEnd(CELL_W) + '  ' + '—'.padEnd(CELL_W) + '  ' + '—'.padEnd(RESET_W) + '  —')
    const badges = []
    const tags = getProfileTags(home, n)
    if (tags.length) badges.push(paint('36', `🏷️ ${tags.join(', ')}`))
    if (disabledList.includes(n)) badges.push(paint('1;33', '(disabled)'))
    // the numbers above are from before this failure (an expired token keeps the last good limits)
    if (limits.length && hit.note) badges.push(paint('1;33', `⚠ ${shortNote(hit.note)}`))
    return { n, email, quota, badges, active: n === cur }
  })

  const nameW = Math.max(7, ...rows.map(r => r.n.length))
  const emailW = Math.max(5, ...rows.map(r => r.email.length))
  const head = paint('1;36', `   ${'PROFILE'.padEnd(nameW)}  ${'EMAIL'.padEnd(emailW)}  ${'5H'.padEnd(CELL_W)}  ${'7D'.padEnd(CELL_W)}  ${'RESET 5H'.padEnd(RESET_W)}  RESET 7D`)
  const lines = rows.map(r => {
    const name = paint(r.active ? '1;32' : '1;37', r.n.padEnd(nameW))
    const email = r.email.padEnd(emailW)
    return `${r.active ? '🟢' : '⚪'} ${name}  ${email}  ${r.quota}${r.badges.length ? '  ' + r.badges.join('  ') : ''}`.trimEnd()
  })
  const rule = paint('90', '─'.repeat(3 + nameW + emailW + CELL_W * 2 + RESET_W + 8 + 10))
  return [head, rule, ...lines].join('\n')
}

const SPARK = '▁▂▃▄▅▆▇█'

// percentages (0–100) as one block character each: the recorded 5h usage at a glance
export function sparkline(values) {
  return values.map(v => SPARK[Math.min(SPARK.length - 1, Math.floor((Math.max(0, Math.min(Number(v) || 0, 100)) / 100) * SPARK.length))]).join('')
}

// the highest reading of `field` in each of the last `count` slots of `slotMs`, oldest first; '·' where none was taken
export function slotSparkline(entries, field, slotMs, count, now = Date.now()) {
  const slots = Array(count).fill(null)
  for (const e of entries) {
    const i = count - 1 - Math.floor((now - e.timestamp) / slotMs)
    if (i >= 0 && i < count && Number.isFinite(e[field])) slots[i] = Math.max(slots[i] ?? 0, e[field])
  }
  return slots.map(v => (v === null ? '·' : sparkline([v]))).join('')
}

export async function usageReport(home, fetchFn = fetchUsage, force = false, color = false, lang = null) {
  const currentLang = lang || loadLanguage(home)
  const rows = await usageRows(home, fetchFn, force)
  if (rows.length === 0) {
    return currentLang === 'en' ? 'No profiles found.' : 'Chưa có profile nào.'
  }
  const history = loadUsageHistory(home)
  const lines = []
  for (const r of rows) {
    const { name, active, email } = r
    if (color) {
      const icon = active ? '🟢' : '⚪'
      const nameColored = active ? `\x1b[1;32m${name} (Active)\x1b[0m` : `\x1b[1;37m${name}\x1b[0m`
      const emailColored = email ? `  👤 ${email}` : ''
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
        const c = pctColor(pctVal)
        const barColored = chartBar(pctVal, 20, true)
        const lblColored = `\x1b[1;36m${label.padEnd(12)}\x1b[0m`
        const pctColored = `${c}${String(pctInt).padStart(3)}%\x1b[0m`
        const warnColored = pctInt >= WARN_PCT ? '\x1b[1;31m ⚠\x1b[0m' : ''
        const resetColored = reset ? `  \x1b[90mreset ${reset}\x1b[0m` : ''
        lines.push(`  ${icon} ${lblColored} ${barColored} ${pctColored}${warnColored}${resetColored}`)
      } else {
        lines.push(`  ${icon} ${label.padEnd(12)}${bar(pct)} ${String(pctInt).padStart(3)}%${warn}${resetStr}`)
      }
    }

    if (r.note) {
      const noteStr = color ? `  \x1b[1;33m⚠ ${r.note}\x1b[0m` : `  ${r.note}`
      lines.push(noteStr)
    }

    const past = Array.isArray(history[name]) ? history[name] : []
    if (past.length >= 2) {
      const rows = [
        ['24h', slotSparkline(past, 'util5h', 3600000, 24), currentLang === 'en' ? '5h, hourly' : '5h, theo giờ'],
        ['7d ', slotSparkline(past, 'util7d', 86400000, 7), currentLang === 'en' ? '7d, daily' : '7d, theo ngày'],
      ]
      for (const [span, spark, label] of rows) {
        lines.push(color ? `  📈 \x1b[1;36m${span}\x1b[0m ${spark}  \x1b[90m(${label})\x1b[0m` : `  📈 ${span} ${spark}  (${label})`)
      }
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

function cacheHit(home, cache, name) {
  const hit = cache[`${name}|${profileEmail(home, name)}`]
  return hit && typeof hit === 'object' ? hit : {}
}

function findLimit(hit, label) {
  return Array.isArray(hit.limits) ? hit.limits.find(l => l[0] === label) : undefined
}

// the usage API already reports utilization as a 0–100 percentage
function limitPct(hit, label) {
  const lim = findLimit(hit, label)
  return lim ? Number(lim[1]) || 0 : 0
}

function isRateLimited(hit) {
  return Boolean(hit.retry_at && hit.retry_at > Date.now() / 1000)
}

// cached quota for one profile, for callers outside the auto-switch logic (dashboard, balancing)
export function quotaSnapshot(home, cache, name) {
  const hit = cacheHit(home, cache, name)
  const lim5h = findLimit(hit, LABEL_5H)
  const resetAt = parseResetTime(hit, lim5h)
  return {
    util5h: lim5h ? limitPct(hit, LABEL_5H) : null,
    util7d: findLimit(hit, LABEL_7D) ? limitPct(hit, LABEL_7D) : null,
    resetAt: resetAt === Number.MAX_SAFE_INTEGER ? null : resetAt,
    rateLimited: isRateLimited(hit),
  }
}

function parseResetTime(hit, lim) {
  for (const raw of [lim?.[3], hit?.resets_at_epoch, hit?.resets_at]) {
    const t = raw ? new Date(typeof raw === 'string' ? raw : Number(raw)).getTime() : NaN
    if (!isNaN(t)) return t
  }
  // caches written before the raw timestamp was kept only have "DD/MM HH:MM"
  const match = lim?.[2] && String(lim[2]).match(/(?:(\d{1,2})\/(\d{1,2})\s+)?(\d{1,2}):(\d{2})/)
  if (match) {
    const d = new Date()
    if (match[1]) d.setMonth(Number(match[2]) - 1, Number(match[1]))
    d.setHours(Number(match[3]), Number(match[4]), 0, 0)
    if (d.getTime() < Date.now() - 180 * 86400000) d.setFullYear(d.getFullYear() + 1) // "01/01" seen on 31/12
    return d.getTime()
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
    const hit = cacheHit(home, c, name)
    const util = Math.round(limitPct(hit, LABEL_5H))
    const resetTime = parseResetTime(hit, findLimit(hit, LABEL_5H))

    let timeDesc = ''
    if (isRateLimited(hit)) {
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
      report.issues.push(`File cấu hình bị hỏng hoặc không đúng chuẩn: ${safeError(err)}`)
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
        const mcp = Object.values(creds.mcpOAuth || {})
        if (mcp.length) {
          // an expired access token with a refresh token renews itself; without one the server needs a new login
          const dead = mcp.filter(m => m?.expiresAt && m.expiresAt <= Date.now() && !m.refreshToken).length
          report.mcp = { total: mcp.length, expired: dead }
          if (dead) {
            if (report.status === 'ok') report.status = 'warn'
            report.warnings.push(`${dead} MCP hết hạn đăng nhập và không có refresh token (cần đăng nhập lại trong /mcp).`)
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
    for (const [label, field, text] of [
      [LABEL_5H, 'quota5h', '5h'],
      [LABEL_7D, 'quota7d', '7 ngày'],
    ]) {
      if (!findLimit(hit, label)) continue
      const u = Math.round(limitPct(hit, label))
      report[field] = u
      if (u >= 95) {
        if (report.status === 'ok') report.status = 'warn'
        report.warnings.push(`Quota ${text} đã chạm ngưỡng cạn kiệt (${u}%).`)
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
    if (p.mcp) lines.push(`   • MCP: ${p.mcp.total} đăng nhập${p.mcp.expired ? `, ${p.mcp.expired} hết hạn` : ''}`)
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
  const hit = cacheHit(home, loadUsageCache(home), cur)

  if (isRateLimited(hit)) {
    return `[Claude: ⏳ ${cur} (429)]`
  }

  if (findLimit(hit, LABEL_5H)) {
    const util = Math.round(limitPct(hit, LABEL_5H))
    const icon = util >= 95 ? '🔴' : util >= 80 ? '🟡' : '🟢'
    return `[Claude: ${icon} ${cur} (${util}%)]`
  }

  return `[Claude: 🟢 ${cur}]`
}

export function statuslineConfigFile(home) {
  return path.join(profilesDir(home), '.statusline.json')
}

// the in-session status line is detailed by default; `statusline off` hides it
function loadStatuslineConfig(home) {
  try {
    const c = JSON.parse(fs.readFileSync(statuslineConfigFile(home), 'utf-8'))
    return { enabled: c.enabled !== false, mode: c.mode === 'line' ? 'line' : 'band' }
  } catch {
    return { enabled: true, mode: 'band' }
  }
}

export function isStatuslineEnabled(home) {
  return loadStatuslineConfig(home).enabled
}

// `band` (default): a coloured band drawn above the prompt by the hook;
// `line`: plain text pinned under the prompt. The host strips the ESC byte of a pinned line, so it cannot be coloured.
export function statuslineMode(home) {
  return loadStatuslineConfig(home).mode
}

export function setStatuslineEnabled(home, enabled) {
  atomicWrite(statuslineConfigFile(home), JSON.stringify({ ...loadStatuslineConfig(home), enabled: Boolean(enabled) }))
}

export function setStatuslineMode(home, mode) {
  if (mode !== 'line' && mode !== 'band') throw new SwapError('Chế độ không hợp lệ. Dùng: line | band')
  atomicWrite(statuslineConfigFile(home), JSON.stringify({ enabled: true, mode }))
}

// The same line as statusLineText, coloured with the palette of `/profile list` (only SGR codes the host is known to draw).
export function statusLineAnsi(d) {
  const c = (code, text) => `\x1b[${code}m${text}\x1b[0m`
  const sep = c('90', ' │ ')
  const parts = [c('1;32', `● ${d.profile}`)]
  if (d.rateLimited) parts.push(c('1;33', '⏳ 429'))
  for (const w of d.windows) {
    parts.push(
      `${c('1;36', w.name)} ${chartBar(w.pct, 8, true)} ${c(pctCode(w.pct), `${w.pct}%`)}${w.pct >= WARN_PCT ? '🔥' : ''}` +
        (w.left ? ` ${c('36', `⏳${w.left}`)}` : '')
    )
  }
  for (const note of [d.warn, d.pace, d.models, d.stale, d.suggest]) if (note) parts.push(c('1;33', note))
  return parts.join(sep)
}

// a status-line minute count past which cached quota is called stale (the hook refetches every USAGE_TTL)
const STALE_STATUS_MIN = 2 * (USAGE_TTL / 60)

// "lỗi HTTP 401 (token hết hạn…)" → "lỗi HTTP 401": a cache note short enough for the status line or a list badge
export function shortNote(note) {
  return String(note).split(/\s*[:(—]/)[0].trim()
}

// Why the numbers may be wrong: the last fetch failed (the cache keeps the old limits next to its note), or no
// fetch has run for a while. '' when they are current.
function staleNote(hit, lang) {
  if (!Array.isArray(hit.limits) || !hit.limits.length) return '' // no numbers shown (an API key, never fetched)
  if (hit.note) return `⚠ ${shortNote(hit.note)}`
  const min = Math.floor((Date.now() / 1000 - hit.at) / 60)
  return min > STALE_STATUS_MIN ? `⚠ ${lang === 'en' ? 'stale' : 'cũ'} ${shortDuration(min * 60000)}` : ''
}

// Other profiles whose window was at or past WARN_PCT and has reset since: usable again. Read from the cache alone
// (a reset time in the past says enough), so no fetch is needed.
export function recoveredProfiles(home, cache, cur) {
  const disabled = loadDisabledProfiles(home)
  return listProfiles(home).filter(n => {
    if (n === cur || disabled.includes(n)) return false
    const hit = cacheHit(home, cache, n)
    if (hit.note) return false // its last refresh failed (expired token...): those numbers will not move
    return [LABEL_5H, LABEL_7D].some(label => {
      const lim = findLimit(hit, label)
      return lim && limitPct(hit, label) >= WARN_PCT && parseResetTime(hit, lim) <= Date.now()
    })
  })
}

// A model's own 7-day limit (Fable, Opus…) at or past WARN_PCT, with the working profile that has the most of it left:
// "Fable 7d 85% → minhvong 13%". '' when no model limit is hot.
function modelNote(home, cache, hit, cur) {
  const hot = (Array.isArray(hit.limits) ? hit.limits : []).filter(l => String(l[0]).startsWith(`${LABEL_7D} `) && Number(l[1]) >= WARN_PCT)
  if (!hot.length) return ''
  const disabled = loadDisabledProfiles(home)
  const others = listProfiles(home).filter(n => n !== cur && !disabled.includes(n) && loginState(home, n) === 'ok')
  return hot
    .map(l => {
      const model = l[0].slice(LABEL_7D.length + 1)
      const best = others
        .filter(n => findLimit(cacheHit(home, cache, n), l[0]))
        .map(n => [n, limitPct(cacheHit(home, cache, n), l[0])])
        .sort((a, b) => a[1] - b[1])[0]
      return `${model} 7d ${Math.round(Number(l[1]))}%${best && best[1] < WARN_PCT ? ` → ${best[0]} ${Math.round(best[1])}%` : ''}`
    })
    .join(' · ')
}

// the fullest window at or past WARN_PCT, or undefined
export function hotWindow(windows) {
  return windows.filter(w => w.pct >= WARN_PCT).sort((a, b) => b.pct - a.pct)[0]
}

// With auto-switch off nothing moves you off a profile that is running out: name the one auto-switch would pick.
// Only looked up for a hot window, since findNextProfile reads every profile file.
function suggestNext(home, cache, windows) {
  const hot = hotWindow(windows)
  const config = hot && loadAutoSwitchConfig(home)
  if (!hot || config.enabled) return null
  const next = findNextProfile(home, { cache, config })
  if (!next) return null
  const pct = Math.round(limitPct(cacheHit(home, cache, next), hot.name === '5h' ? LABEL_5H : LABEL_7D))
  return { next, text: `→ ${next} ${hot.name} ${pct}%` }
}

// [{ name: '5h' | '7d', pct 0–100, left: '2h10m' }] from one cache entry; none while the usage endpoint answers 429
function quotaWindows(hit) {
  if (isRateLimited(hit)) return []
  return [[LABEL_5H, '5h'], [LABEL_7D, '7d']].flatMap(([label, name]) => {
    const lim = findLimit(hit, label)
    return lim ? [{ name, pct: Math.round(Math.max(0, Math.min(Number(lim[1]) || 0, 100))), left: resetIn(hit, lim) }] : []
  })
}

// Everything the in-session status line shows, as data: the hook draws it in colour, `statusline text` flattens it.
// null when there is nothing to show (no profile, or `/profile statusline off`).
export function statusLineData(home) {
  const cur = currentProfile(home)
  if (!cur || !isStatuslineEnabled(home)) return null
  const cache = loadUsageCache(home)
  const hit = cacheHit(home, cache, cur)
  const windows = quotaWindows(hit)
  const suggestion = suggestNext(home, cache, windows)
  const hot7d = windows.find(w => w.name === '7d' && w.pct >= WARN_PCT)
  const data = {
    profile: cur,
    rateLimited: isRateLimited(hit),
    windows,
    warn: forecastWarning(home),
    stale: staleNote(hit, loadLanguage(home)),
    suggest: suggestion?.text || '',
    next: suggestion?.next || '',
    pace: hot7d ? paceNote(weeklyPace(home, cur, cache)) : '',
    recovered: recoveredProfiles(home, cache, cur),
    models: isRateLimited(hit) ? '' : modelNote(home, cache, hit, cur),
    mode: statuslineMode(home),
  }
  return { ...data, text: statusLineText(home, data), ansi: statusLineAnsi(data) }
}

// "● work │ 5h [███░░░░░] 34% ⏳4h40m │ 7d [██████░░] 73% ⏳3d4h │ ⚠ 5h ~12p"; ⏳ has a fixed width, unlike ↻
export function statusLineText(home, data = null) {
  const d = data || statusLineData(home)
  if (!d) return ''
  const parts = [`● ${d.profile}`]
  if (d.rateLimited) parts.push('⏳ 429')
  for (const w of d.windows) {
    parts.push(`${w.name} ${chartBar(w.pct, 8)} ${w.pct}%${w.pct >= WARN_PCT ? '🔥' : ''}${w.left ? ` ⏳${w.left}` : ''}`)
  }
  for (const note of [d.warn, d.pace, d.models, d.stale, d.suggest]) if (note) parts.push(note)
  return parts.join(' │ ')
}

export function generatePromptSnippet(shell = 'starship') {
  const s = String(shell).toLowerCase()
  if (s === 'starship') {
    return [
      '# Thêm đoạn sau vào ~/.config/starship.toml:',
      '[custom.claude_profile]',
      `command = "node ${SCRIPT_PATH} statusline"`,
      'when = true',
      'format = "[$output]($style) "',
      'style = "bold cyan"',
    ].join('\n')
  }
  if (s === 'zsh') {
    return [
      '# Thêm hàm sau vào ~/.zshrc:',
      'claude_profile_prompt() {',
      `  node "${SCRIPT_PATH}" statusline 2>/dev/null`,
      '}',
      '# Gắn vào RPROMPT hoặc PROMPT:',
      'RPROMPT=\'$(claude_profile_prompt) \'${RPROMPT:-}',
    ].join('\n')
  }
  if (s === 'bash') {
    return [
      '# Thêm hàm sau vào ~/.bashrc:',
      'claude_profile_prompt() {',
      `  node "${SCRIPT_PATH}" statusline 2>/dev/null`,
      '}',
      '# Thêm $(claude_profile_prompt) vào biến PS1',
    ].join('\n')
  }
  if (s === 'tmux') {
    return [
      '# Thêm dòng sau vào ~/.tmux.conf:',
      `set -g status-right "#(node '${SCRIPT_PATH}' statusline) %H:%M %d-%b-%y"`,
    ].join('\n')
  }
  if (s === 'powershell' || s === 'pwsh') {
    return [
      '# Thêm vào file $PROFILE (mở bằng: notepad $PROFILE):',
      'function prompt {',
      `  $claude = node '${SCRIPT_PATH.replace(/'/g, "''")}' statusline 2>$null`,
      '  "$claude PS $($executionContext.SessionState.Path.CurrentLocation)$(\'>\' * ($nestedPromptLevel + 1)) "',
      '}',
    ].join('\n')
  }
  throw new SwapError(`Shell '${shell}' không được hỗ trợ. Các shell hỗ trợ: starship, zsh, bash, tmux, powershell`)
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

export function tempSwap(home, nameOrAlias, durationStr) {
  const name = resolveProfileOrAlias(home, nameOrAlias)
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
    // only hand the account back if it is still the borrowed one: a manual swap or undo since then wins
    const stillBorrowed = currentProfile(home) === state.tempProfile
    if (stillBorrowed && orig && profileExists(home, orig)) {
      swapProfile(home, orig, {
        type: 'auto',
        reason: 'Hết hạn profile tạm thời',
      })
      sendNotification(home, 'claude-swap', `Đã tự động quay về profile gốc '${orig}' do hết hạn mượn tạm.`)
    }
    try {
      fs.unlinkSync(tempProfileFile(home))
    } catch {}
    return { expired: true, revertedTo: stillBorrowed ? orig : null }
  }
  return { expired: false, remainingMs: state.expiresAt - Date.now(), state }
}

export function findNextProfile(home, options = {}) {
  const config = options.config || loadAutoSwitchConfig(home)
  const allProfiles = listProfiles(home)
  const cur = currentProfile(home)
  const cache = options.cache || loadUsageCache(home)
  const disabled = loadDisabledProfiles(home)
  const balance = options.balance || loadBalanceConfig(home)
  const pools = [config.pool, balance.enabled ? balance.pool : null].filter(p => p && p !== 'all')

  const candidates = []
  for (const name of allProfiles) {
    if (name === cur) continue
    if (disabled.includes(name)) continue

    const hit = cacheHit(home, cache, name)

    try {
      const profile = JSON.parse(fs.readFileSync(profilePath(home, name), 'utf-8'))
      const tags = Array.isArray(profile.tags) ? profile.tags : []
      if (!pools.every(p => tags.includes(p))) continue
      const hasApiKey = Boolean(profile.claude_json?.primaryApiKey)
      const oauth = JSON.parse(profile.credentials || '{}').claudeAiOauth || {}
      if (!oauth.accessToken && !hasApiKey) continue
      if (!hasApiKey && typeof oauth.expiresAt === 'number' && oauth.expiresAt / 1000 < Date.now() / 1000) {
        continue
      }
    } catch {
      continue
    }

    if (isExhausted(hit, config)) continue

    const util = limitPct(hit, LABEL_5H)
    const resetTime = parseResetTime(hit, findLimit(hit, LABEL_5H))
    candidates.push({ name, util, resetTime })
  }

  if (candidates.length === 0) {
    return null
  }

  // load balancing, when on, decides instead of `order`; least-used is the default sort below
  if (balance.enabled && balance.mode === 'round-robin') {
    // stateless rotation: the first eligible profile after the current one, in name order
    return (candidates.find(c => c.name > (cur || '')) || candidates[0]).name
  }

  if (!balance.enabled && config.order && config.order.length > 0) {
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

function isExhausted(hit, config) {
  return (
    limitPct(hit, LABEL_5H) >= config.threshold ||
    Boolean(config.safeguardThreshold && limitPct(hit, LABEL_7D) >= config.safeguardThreshold)
  )
}

export function scheduleFile(home) {
  return path.join(profilesDir(home), '.schedule.json')
}

// { rules: [{ from: 'HH:MM', to: 'HH:MM', profile }], applied: '<day>|<index>' of the last window acted on }
export function loadSchedule(home) {
  try {
    const d = JSON.parse(fs.readFileSync(scheduleFile(home), 'utf-8'))
    return { rules: Array.isArray(d.rules) ? d.rules : [], applied: d.applied || '' }
  } catch {
    return { rules: [], applied: '' }
  }
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/
const minutesOf = hhmm => {
  const [, h, m] = hhmm.match(HHMM)
  return Number(h) * 60 + Number(m)
}

export function addScheduleRule(home, range, name) {
  const [from, to] = String(range || '').split('-')
  if (!HHMM.test(from || '') || !HHMM.test(to || '') || from === to) {
    throw new SwapError('Khung giờ không hợp lệ. Dùng: HH:MM-HH:MM (vd: 09:00-18:00, 22:00-06:00)')
  }
  const profile = resolveProfileOrAlias(home, name)
  if (!profileExists(home, profile)) throw new SwapError(`Profile '${name}' không tồn tại.`)
  const sched = loadSchedule(home)
  sched.rules.push({ from, to, profile })
  atomicWrite(scheduleFile(home), JSON.stringify(sched, null, 2))
  return sched.rules
}

export function removeScheduleRule(home, which) {
  const sched = loadSchedule(home)
  if (which === 'all') sched.rules = []
  else {
    const i = Number(which) - 1
    if (!Number.isInteger(i) || i < 0 || i >= sched.rules.length) throw new SwapError(`Không có lịch số ${which}. Xem: /profile schedule`)
    sched.rules.splice(i, 1)
  }
  atomicWrite(scheduleFile(home), JSON.stringify(sched, null, 2))
  return sched.rules
}

// The rule whose window holds `now` (the first one listed wins), with a key naming that one window: the day it
// started (yesterday for the tail of an overnight window) and the rule's index.
export function activeScheduleRule(rules, now = new Date()) {
  const m = now.getHours() * 60 + now.getMinutes()
  for (const [i, r] of rules.entries()) {
    if (!HHMM.test(r.from || '') || !HHMM.test(r.to || '')) continue
    const from = minutesOf(r.from)
    const to = minutesOf(r.to)
    const inside = from < to ? m >= from && m < to : m >= from || m < to
    if (!inside) continue
    const started = from > to && m < to ? now.getTime() - 86400000 : now.getTime()
    return { rule: r, key: `${localDay(started)}|${i}` }
  }
  return null
}

// Swaps once on entering a scheduled window, so a manual swap inside it is not undone on the next prompt.
// An exhausted or missing scheduled profile is skipped for that window.
export function checkSchedule(home, config = loadAutoSwitchConfig(home), cache = loadUsageCache(home), now = new Date()) {
  const sched = loadSchedule(home)
  const active = activeScheduleRule(sched.rules, now)
  if (!active || sched.applied === active.key) return null
  atomicWrite(scheduleFile(home), JSON.stringify({ ...sched, applied: active.key }, null, 2))
  const cur = currentProfile(home)
  const target = active.rule.profile
  const hit = cacheHit(home, cache, target)
  if (target === cur || !profileExists(home, target) || isRateLimited(hit) || isExhausted(hit, config)) return null
  swapProfile(home, target, { type: 'auto', reason: `Lịch ${active.rule.from}-${active.rule.to}` })
  return { from: cur, to: target }
}

export function formatSchedule(home, lang = 'vi') {
  const { rules } = loadSchedule(home)
  if (!rules.length) {
    return lang === 'en'
      ? '🗓️ No schedule. Add one: /profile schedule 09:00-18:00 <profile>'
      : '🗓️ Chưa có lịch. Thêm: /profile schedule 09:00-18:00 <profile>'
  }
  const active = activeScheduleRule(rules)
  return [
    lang === 'en' ? '🗓️ Profile schedule (swaps once when a window starts):' : '🗓️ Lịch đổi profile (đổi một lần khi tới giờ):',
    ...rules.map((r, i) => `  ${i + 1}. ${r.from}-${r.to}  ➜ '${r.profile}'${active?.rule === r ? (lang === 'en' ? '  ← now' : '  ← đang tới giờ') : ''}`),
  ].join('\n')
}

export async function autoCheckAndSwap(home, options = {}) {
  // Check if temp profile expired
  const tempRes = checkTempExpiry(home)
  if (tempRes.expired && tempRes.revertedTo) {
    return {
      swapped: true,
      from: options.currentProfile || currentProfile(home),
      to: tempRes.revertedTo,
      isTempRevert: true,
    }
  }

  const config = options.config || loadAutoSwitchConfig(home)
  const cur = currentProfile(home)

  // Refresh quota (cached for USAGE_TTL) so a decision is not made on stale numbers, but only for the profiles
  // that decision looks at: the current one first, the others only once a branch/primary/swap check needs them.
  // The current one is refreshed even with auto-switch off: the status line printed after the check reads it.
  let cache = options.cache || loadUsageCache(home)
  const refresh = async names => {
    if (options.cache) return
    try {
      await refreshUsage(home, names, options.fetchFn || fetchUsage)
    } catch {}
    cache = loadUsageCache(home)
  }
  if (cur) await refresh([cur])

  if (!options.cache) {
    const scheduled = checkSchedule(home, config, cache)
    if (scheduled) return { swapped: true, ...scheduled, isSchedule: true }
  }

  if (!config.enabled) {
    return { swapped: false, reason: 'disabled' }
  }
  if (!cur) {
    return { swapped: false, reason: 'no_current' }
  }

  // Check branch binding; skip an exhausted bound profile, or we would swap back and forth every prompt
  const branchBound = getBoundBranchProfile(home, process.cwd())
  if (branchBound && branchBound.profile !== cur) await refresh([branchBound.profile])
  const boundHit = branchBound ? cacheHit(home, cache, branchBound.profile) : {}
  if (
    branchBound &&
    branchBound.profile !== cur &&
    !isRateLimited(boundHit) &&
    !isExhausted(boundHit, config)
  ) {
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

  // Check auto-return to primary profile
  if (
    config.autoReturn &&
    config.primaryProfile &&
    cur !== config.primaryProfile &&
    profileExists(home, config.primaryProfile)
  ) {
    await refresh([config.primaryProfile])
    const priHit = cacheHit(home, cache, config.primaryProfile)
    const priUtil = limitPct(priHit, LABEL_5H)

    if (!isRateLimited(priHit) && !isExhausted(priHit, config)) {
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

  const hit = cacheHit(home, cache, cur)
  const util = limitPct(hit, LABEL_5H)
  const util7d = limitPct(hit, LABEL_7D)
  const isSafeguardTriggered = Boolean(config.safeguardThreshold && util7d >= config.safeguardThreshold)

  // retry_at is a 429 from the usage endpoint (polling limit), not the account's quota: judge by the last known numbers
  if (util >= config.threshold || isSafeguardTriggered) {
    await refresh(listProfiles(home)) // choosing a replacement needs everyone's numbers
    const next = findNextProfile(home, { config, cache })
    if (next && next !== cur) {
      const reasonText = isSafeguardTriggered
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
        reason: reasonText,
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
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : { enabled: false }
  } catch {
    return { enabled: false }
  }
}

export function saveNotificationConfig(home, config) {
  const f = notificationConfigFile(home)
  atomicWrite(f, JSON.stringify(config, null, 2))
}

// test runs set these; a path heuristic (home containing "test-" or tmpdir) would silence real users too
function silenced() {
  return process.env.NODE_ENV === 'test' || process.env.CLAUDE_SWAP_SILENT === '1'
}

export function sendNotification(home, title, message) {
  if (silenced()) return
  const config = loadNotificationConfig(home)
  if (!config.enabled) return

  if (process.platform === 'darwin') {
    const q = t => `"${t.replace(/[\\"]/g, '\\$&')}"`
    spawnDetached('osascript', ['-e', `display notification ${q(message)} with title ${q(title)}`])
  } else if (process.platform === 'win32') {
    // a tray balloon, not a modal MessageBox that steals focus on every auto-swap
    const q = t => `'${t.replace(/'/g, "''")}'`
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; ' +
      '$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; ' +
      `$n.ShowBalloonTip(5000, ${q(title)}, ${q(message)}, 'Info'); Start-Sleep -Seconds 6; $n.Dispose()`
    spawnDetached('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
  } else {
    spawnDetached('notify-send', [title, message])
  }
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
  atomicWrite(resolved, JSON.stringify(container, null, 2))
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
    throw new SwapError(`File sao lưu không hợp lệ: ${safeError(err)}`)
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
      .execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
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
  if (Object.keys(bindings).length === 0) return null
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

// every reading this recent is kept (the forecast reads them); older ones are thinned to the last of each hour
const HISTORY_RAW_MS = 6 * 3600000
const HISTORY_KEEP_MS = 7 * 86400000

export function thinHistory(entries, now = Date.now()) {
  const out = []
  for (const e of entries) {
    if (e.timestamp < now - HISTORY_KEEP_MS) continue
    const prev = out[out.length - 1]
    const sameOldHour = prev && e.timestamp < now - HISTORY_RAW_MS && Math.floor(prev.timestamp / 3600000) === Math.floor(e.timestamp / 3600000)
    if (sameOldHour) out[out.length - 1] = e
    else out.push(e)
  }
  return out
}

// `project`: the working directory of the session that fetched, when the profile is the one in use there.
// The 5h usage gained since the previous reading is put down to it (an estimate: parallel sessions share one account).
export function recordUsageSnapshot(home, profileName, util5h, util7d = null, project = null) {
  if (!profileName) return
  const f = usageHistoryFile(home)
  const history = loadUsageHistory(home)
  if (!Array.isArray(history[profileName])) {
    history[profileName] = []
  }
  const prev = history[profileName][history[profileName].length - 1]
  const now = Number(util5h)
  if (project && prev && Number.isFinite(prev.util5h)) {
    addProjectUsage(home, project, now >= prev.util5h ? now - prev.util5h : now) // lower: the window reset in between
  }
  history[profileName].push({
    timestamp: Date.now(),
    util5h: now,
    util7d: util7d !== null ? Number(util7d) : null,
  })
  history[profileName] = thinHistory(history[profileName])
  atomicWrite(f, JSON.stringify(history))
}

export function projectUsageFile(home) {
  return path.join(profilesDir(home), '.project-usage.json')
}

export function loadProjectUsage(home) {
  try {
    return JSON.parse(fs.readFileSync(projectUsageFile(home), 'utf-8'))
  } catch {
    return {}
  }
}

const localDay = (t = Date.now()) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10)

// { [dir]: { 'YYYY-MM-DD': 5h percentage points } }, days older than 30 dropped
function addProjectUsage(home, project, pct) {
  if (!(pct > 0)) return
  const usage = loadProjectUsage(home)
  const day = localDay()
  const oldest = localDay(Date.now() - 30 * 86400000)
  usage[project] = { ...usage[project], [day]: Math.round(((usage[project]?.[day] || 0) + pct) * 10) / 10 }
  for (const dir of Object.keys(usage)) {
    for (const d of Object.keys(usage[dir])) if (d < oldest) delete usage[dir][d]
    if (!Object.keys(usage[dir]).length) delete usage[dir]
  }
  atomicWrite(projectUsageFile(home), JSON.stringify(usage, null, 2))
}

// [{ dir, pct }] over the last `days` days, largest first
export function projectUsageTotals(home, days = 7) {
  const since = localDay(Date.now() - (days - 1) * 86400000)
  return Object.entries(loadProjectUsage(home))
    .map(([dir, byDay]) => ({ dir, pct: Math.round(Object.entries(byDay).reduce((sum, [d, v]) => (d >= since ? sum + v : sum), 0) * 10) / 10 }))
    .filter(p => p.pct > 0)
    .sort((a, b) => b.pct - a.pct)
}

export function formatProjectUsage(home, days = 7, lang = 'vi') {
  const totals = projectUsageTotals(home, days).map(p => [p.dir, p.pct])
  const title = lang === 'en'
    ? `📁 Usage by project (last ${days} days, estimated from 5h % gained):`
    : `📁 Usage theo dự án (${days} ngày qua, ước tính từ % 5h tăng thêm):`
  if (!totals.length) return `${title}\n- ${lang === 'en' ? '(no data yet)' : '(chưa có dữ liệu)'}`
  const width = Math.max(...totals.map(([dir]) => path.basename(dir).length))
  return [title, ...totals.slice(0, 15).map(([dir, total]) => `- ${path.basename(dir).padEnd(width)}  ${String(Math.round(total)).padStart(4)}%  ${dir}`)].join('\n')
}

// a measurement older than this says nothing about the present (the cache refreshes every 5 minutes while you work)
const STALE_FORECAST_MIN = 20

export function calculateForecast(home, profileName, threshold = 95, history = loadUsageHistory(home)) {
  const entries = history[profileName] || []
  if (entries.length < 2) {
    return {
      profile: profileName,
      hasData: false,
      message: 'Chưa đủ dữ liệu lịch sử (cần ít nhất 2 lần đo quota).',
    }
  }

  // the rising run that ends at the last reading, at most one 5h window long (history keeps a week of readings),
  // started at the last reading of a flat stretch so hours of an idle 0% do not dilute a burst
  const last = entries[entries.length - 1]
  let start = entries.length - 1
  while (start > 0 && entries[start - 1].util5h <= entries[start].util5h && last.timestamp - entries[start - 1].timestamp <= 5 * 3600000) start--
  while (start < entries.length - 2 && entries[start + 1].util5h === entries[start].util5h) start++
  const first = entries[start]
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
  // counted from the moment of the last measurement, not from now: a reading that is an hour old has already used up an hour
  const ageMin = Math.max(0, (Date.now() - last.timestamp) / 60000)
  const minutesUntilThreshold = Math.max(0, Math.round(hoursUntilThreshold * 60 - ageMin))
  const estimatedTimestamp = Date.now() + minutesUntilThreshold * 60 * 1000

  return {
    profile: profileName,
    hasData: true,
    currentUtil,
    burnRatePerHour: Math.round(burnRatePerHour * 10) / 10,
    trend: 'increasing',
    minutesUntilThreshold,
    estimatedTimestamp,
    stale: ageMin > STALE_FORECAST_MIN,
    message:
      `Mức dùng: ${Math.round(currentUtil)}% | Tốc độ tăng: +${Math.round(burnRatePerHour * 10) / 10}%/giờ. ` +
      `Dự kiến chạm ngưỡng ${threshold}% sau ~${minutesUntilThreshold} phút ` +
      `(${new Date(estimatedTimestamp).toLocaleTimeString('vi-VN')}).` +
      (ageMin > STALE_FORECAST_MIN ? ` Số liệu đã cũ ${Math.round(ageMin)} phút, chỉ tham khảo.` : ''),
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
    const pace = weeklyPace(home, n)
    if (pace) {
      const left = shortDuration(pace.hoursLeft * 3600000)
      const now = pace.rate === null ? '' : currentLang === 'en' ? `, recent pace ${perHour(pace.rate)}` : `, đang dùng ${perHour(pace.rate)}`
      lines.push(
        currentLang === 'en'
          ? `   📅 7 days: ${Math.round(100 - pace.pct)}% left for ${left} → ≈${perHour(pace.budget)}${now}`
          : `   📅 7 ngày: còn ${Math.round(100 - pace.pct)}% cho ${left} → ≈${perHour(pace.budget)}${now}`
      )
    }
  }
  return lines.join('\n')
}

// The 7-day quota left per hour until its reset, and the pace of the last 3 hours of readings (null: too few).
export function weeklyPace(home, name, cache = loadUsageCache(home), history = loadUsageHistory(home)) {
  const hit = cacheHit(home, cache, name)
  const lim = findLimit(hit, LABEL_7D)
  const resetAt = lim ? parseResetTime(hit, lim) : NaN
  const hoursLeft = (resetAt - Date.now()) / 3600000
  if (!Number.isFinite(resetAt) || resetAt === Number.MAX_SAFE_INTEGER || hoursLeft <= 0) return null
  const pct = limitPct(hit, LABEL_7D)
  const recent = (history[name] || []).filter(e => e.timestamp >= Date.now() - 3 * 3600000 && Number.isFinite(e.util7d))
  let rate = null
  if (recent.length >= 2) {
    const first = recent[0]
    const last = recent[recent.length - 1]
    const hours = (last.timestamp - first.timestamp) / 3600000
    if (hours >= 0.25 && last.util7d >= first.util7d) rate = (last.util7d - first.util7d) / hours
  }
  return { pct, hoursLeft, budget: Math.max(0, 100 - pct) / hoursLeft, rate }
}

const perHour = n => `${n < 10 ? Math.round(n * 10) / 10 : Math.round(n)}%/h`

// "7d ≈0.7%/h", or "⚠ 7d 1.2%/h > 0.7%/h" when the recent pace would run out before the reset
function paceNote(pace) {
  if (!pace) return ''
  return pace.rate !== null && pace.rate > pace.budget
    ? `⚠ 7d ${perHour(pace.rate)} > ${perHour(pace.budget)}`
    : `7d ≈${perHour(pace.budget)}`
}

// short text for the status line when the current profile is about to hit the auto-switch threshold; '' otherwise
export function forecastWarning(home, withinMinutes = 30) {
  const cur = currentProfile(home)
  if (!cur) return ''
  const f = calculateForecast(home, cur, loadAutoSwitchConfig(home).threshold)
  return f.hasData && f.trend === 'increasing' && !f.stale && f.minutesUntilThreshold <= withinMinutes
    ? `⚠ 5h ~${Math.max(f.minutesUntilThreshold, 0)}p`
    : ''
}

// go back to the profile before the last swap (history is newest first); a second undo returns again
export function undoSwap(home) {
  const cur = currentProfile(home)
  const last = loadSwapHistory(home).find(h => h.from && h.from !== '(none)' && profileExists(home, h.from))
  if (!last) throw new SwapError('Không có lần chuyển nào để hoàn tác.')
  if (last.from === cur) throw new SwapError(`Đang ở '${cur}' rồi, không có gì để hoàn tác.`)
  swapProfile(home, last.from, { type: 'manual', reason: 'undo' })
  return { from: cur, to: last.from }
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
  // the backup password is never stored; this also scrubs one saved by older versions
  const { password, ...rest } = config
  atomicWrite(f, JSON.stringify(rest, null, 2))
}

const PASSWORD_HINT = '--password-stdin, biến môi trường CLAUDE_SWAP_PASSWORD hoặc --password <mật_khẩu>'

// --password-stdin > --password <pw> > $CLAUDE_SWAP_PASSWORD. Only the first keeps it out of shell history
// and the process list; the env var keeps it out of the history/transcript.
export function readPasswordArg(argv, readStdin = () => fs.readFileSync(0, 'utf-8')) {
  if (argv.includes('--password-stdin')) return readStdin().replace(/\r?\n$/, '')
  const i = passwordValueIndex(argv)
  return i !== -1 ? argv[i] : process.env.CLAUDE_SWAP_PASSWORD || ''
}

// index of the value after `--password`, or -1; a following `--flag` is not a value
function passwordValueIndex(argv) {
  const i = argv.indexOf('--password')
  return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? i + 1 : -1
}

// positional args after the subcommand, minus flags and the --password value
export function positionalArgs(argv, from) {
  const skip = passwordValueIndex(argv)
  return argv.slice(from).filter((a, idx) => !a.startsWith('--') && idx + from !== skip)
}

export function syncPush(home, targetPath, password) {
  const config = loadSyncConfig(home)
  const dest = targetPath || config.targetPath
  if (!dest) {
    throw new SwapError('Chưa cấu hình đường dẫn đích đồng bộ. Dùng: /profile sync setup <đường_dẫn_file>')
  }
  const pass = password || config.password // config.password: legacy, removed by the save below
  if (!pass) {
    throw new SwapError(`Vui lòng cung cấp mật khẩu mã hóa qua ${PASSWORD_HINT}.`)
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
  const pass = password || config.password // config.password: legacy, removed by the save below
  if (!pass) {
    throw new SwapError(`Vui lòng cung cấp mật khẩu giải mã qua ${PASSWORD_HINT}.`)
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
  if (filtered.length !== list.length) saveDisabledProfiles(home, filtered)
  return resolved
}

export function isProfileDisabled(home = os.homedir(), name) {
  const list = loadDisabledProfiles(home)
  return list.includes(name)
}

// ---------------------------------------------------------------- direct token / api key registration

export function addTokenProfile(home = os.homedir(), token, name = null, options = {}) {
  let trimmedToken = (token || '').trim()
  if (trimmedToken === '-') {
    try {
      trimmedToken = fs.readFileSync(0, 'utf-8').trim()
    } catch (err) {
      throw new SwapError(`Không đọc được token từ stdin: ${err.message}`)
    }
  }
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

// what a `run` session shares with the real config dir; credentials and .claude.json stay per profile
const SHARED_CONFIG = [
  'skills', 'agents', 'commands', 'plugins', 'hooks', 'rules', 'output-styles', 'projects',
  'CLAUDE.md', 'settings.json', 'settings.local.json', 'keybindings.json',
]

function linkSharedConfig(home, sDir) {
  const src = claudeConfigDir(home) || path.join(home, '.claude')
  for (const item of SHARED_CONFIG) {
    const from = path.join(src, item)
    const to = path.join(sDir, item)
    try {
      if (!fs.existsSync(from)) continue
      if (fs.lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(to)
      // a real file/dir already there (from an older run) is left alone rather than deleted
      if (!fs.existsSync(to)) fs.symlinkSync(from, to, fs.statSync(from).isDirectory() ? 'junction' : 'file')
    } catch {} // e.g. Windows without symlink rights: the session just stays isolated
  }
}

export function prepareSession(home = os.homedir(), name) {
  const resolved = resolveProfileOrAlias(home, name)
  if (!profileExists(home, resolved)) {
    throw new SwapError(`Profile '${name}' không tồn tại.`)
  }
  const sDir = sessionDir(home, resolved)
  fs.mkdirSync(sDir, { recursive: true, mode: 0o700 })
  atomicWrite(currentFileFor(home, sDir), resolved)

  const pData = JSON.parse(fs.readFileSync(profilePath(home, resolved), 'utf-8'))
  const cj = path.join(sDir, '.claude.json')
  const baseClaudeJson = fs.existsSync(claudeJson(home)) ? loadClaudeJson(home) : {}
  const sessionData = { ...baseClaudeJson }
  for (const k of AUTH_KEYS) {
    delete sessionData[k]
  }
  for (const k of AUTH_KEYS) {
    if (pData.claude_json && k in pData.claude_json) {
      sessionData[k] = pData.claude_json[k]
    }
  }
  atomicWrite(cj, JSON.stringify(sessionData, null, 2))

  // CLAUDE_CONFIG_DIR *is* the ~/.claude equivalent: credentials sit directly in it
  const credFile = path.join(sDir, '.credentials.json')
  fs.rmSync(path.join(sDir, '.claude', '.credentials.json'), { force: true }) // pre-0.2.1 location, never read
  linkSharedConfig(home, sDir)
  if (pData.credentials) {
    const liveCredentials = readCredentials(home)
    const credentials = liveCredentials ? keepLiveMcpOAuth(liveCredentials, pData.credentials) : pData.credentials
    atomicWrite(credFile, credentials)
    // macOS reads the per-dir Keychain item first; overwrite it so a stale token there cannot win.
    // A locked/missing login keychain (SSH) must not abort `run`: the file above is the fallback.
    if (process.platform === 'darwin') {
      try {
        writeKeychain(sessionKeychainService(sDir), credentials)
      } catch {}
    }
  } else {
    fs.rmSync(credFile, { force: true })
    if (process.platform === 'darwin') deleteKeychain(sessionKeychainService(sDir))
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
      // the user may have logged into another account inside the session: don't overwrite this profile with it
      const liveId = accountId(liveJson.oauthAccount)
      const savedId = accountId(pData.claude_json?.oauthAccount)
      if (liveId && savedId && liveId !== savedId) return
      for (const k of AUTH_KEYS) {
        if (k in liveJson) {
          pData.claude_json = pData.claude_json || {}
          pData.claude_json[k] = liveJson[k]
        }
      }
    }
    const credFile = path.join(sDir, '.credentials.json')
    const live =
      (process.platform === 'darwin' && readKeychain(sessionKeychainService(sDir))) ||
      (fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf-8') : null)
    if (live) pData.credentials = live
    atomicWrite(target, JSON.stringify(pData, null, 2))
  } catch {}
}

// 'ok', 'expired' (an access token past its expiry that the refresh token can renew) or 'no_token' (needs a new login)
export function loginState(home, name) {
  try {
    const p = JSON.parse(fs.readFileSync(profilePath(home, name), 'utf-8'))
    if (p.claude_json?.primaryApiKey) return 'ok'
    const oauth = JSON.parse(p.credentials || '{}').claudeAiOauth || {}
    if (!oauth.accessToken) return 'no_token'
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return oauth.refreshToken ? 'expired' : 'no_token'
    return 'ok'
  } catch {
    return 'no_token'
  }
}

// profiles other than the current one (Claude Code renews that one itself) whose saved login no longer works
export function brokenProfiles(home) {
  const cur = currentProfile(home)
  return listProfiles(home).filter(n => n !== cur && loginState(home, n) !== 'ok')
}

// Renews an expired login without swapping to it. One tiny request in an isolated session (as `run` does) makes
// Claude Code refresh the token, and syncSessionBack saves it into the profile; `claude auth status` does not refresh.
// True when a `run`/`repair` session dir holds a token that still works: read where Claude Code writes it,
// the per-dir Keychain item on macOS, else the file (as syncSessionBack reads it).
function sessionHasLiveToken(sDir) {
  try {
    const raw =
      (process.platform === 'darwin' && readKeychain(sessionKeychainService(sDir))) ||
      fs.readFileSync(path.join(sDir, '.credentials.json'), 'utf-8')
    const oauth = JSON.parse(raw).claudeAiOauth || {}
    return Boolean(oauth.accessToken) && !(typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now())
  } catch {
    return false
  }
}

export async function repairProfile(home, name, spawn = spawnClaudeSync) {
  const resolved = resolveProfileOrAlias(home, name)
  if (!profileExists(home, resolved)) throw new SwapError(`Profile '${name}' không tồn tại.`)
  if (resolved === currentProfile(home)) return { name: resolved, state: 'current' }
  const state = loginState(home, resolved)
  if (state !== 'expired') return { name: resolved, state }
  // an earlier run cut short after the refresh (a killed process) left the renewed token in the session dir:
  // take it back before prepareSession overwrites it with the profile's spent one
  const prior = sessionDir(home, resolved)
  if (fs.existsSync(prior) && sessionHasLiveToken(prior)) {
    syncSessionBack(home, resolved, prior)
    if (loginState(home, resolved) === 'ok') return { name: resolved, state: 'repaired' }
  }
  const sDir = prepareSession(home, resolved)
  const res = spawn('claude', ['-p', 'Reply with: ok', '--model', 'haiku'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: sDir },
    encoding: 'utf-8',
    timeout: 120000,
    cwd: os.tmpdir(),
  })
  // copy back only a session that ended with a working token: a failed refresh must not overwrite the profile's
  // refresh token (a later, manual try may still succeed with it)
  const renewed = sessionHasLiveToken(sDir)
  if (renewed) syncSessionBack(home, resolved, sDir)
  if (!renewed || loginState(home, resolved) !== 'ok') {
    const detail = String(res?.error?.message || res?.stderr || res?.stdout || '').trim().split('\n')[0].slice(0, 160)
    return { name: resolved, state: 'failed', detail }
  }
  try {
    await refreshUsage(home, [resolved]) // replaces the "token expired" note with real numbers
  } catch {}
  return { name: resolved, state: 'repaired' }
}

export function repairConfigFile(home) {
  return path.join(profilesDir(home), '.repair.json')
}

export function loadRepairConfig(home) {
  try {
    return { auto: false, lastRun: 0, ...JSON.parse(fs.readFileSync(repairConfigFile(home), 'utf-8')) }
  } catch {
    return { auto: false, lastRun: 0 }
  }
}

export function setAutoRepair(home, auto) {
  atomicWrite(repairConfigFile(home), JSON.stringify({ ...loadRepairConfig(home), auto: Boolean(auto) }))
}

const AUTO_REPAIR_MS = 6 * 3600000

// From the hook's minute tick, while `repair auto` is on: at most every AUTO_REPAIR_MS, a background `repair` (each
// `claude -p` takes seconds, too long for the tick) when some profile's token has expired. True when one started.
export function maybeAutoRepair(home, spawn = spawnDetached) {
  const cfg = loadRepairConfig(home)
  if (!cfg.auto || Date.now() - cfg.lastRun < AUTO_REPAIR_MS || isolatedSession(home)) return false
  atomicWrite(repairConfigFile(home), JSON.stringify({ ...cfg, lastRun: Date.now() }))
  if (!brokenProfiles(home).some(n => loginState(home, n) === 'expired')) return false
  spawn(process.execPath, [SCRIPT_PATH, 'repair'])
  return true
}

export function formatRepair(r, lang = 'vi') {
  const n = r.name
  const en = lang === 'en'
  switch (r.state) {
    case 'repaired':
      return en ? `✅ '${n}': token renewed.` : `✅ '${n}': đã làm mới token.`
    case 'ok':
      return en ? `✅ '${n}': login still valid, nothing to do.` : `✅ '${n}': đăng nhập vẫn tốt, không cần sửa.`
    case 'current':
      return en ? `ℹ️ '${n}' is in use: Claude Code renews its token itself.` : `ℹ️ '${n}' đang dùng: Claude Code tự làm mới token của nó.`
    case 'no_token':
      return en
        ? `⚠️ '${n}': no token left to renew. Log in again: /profile ${n}, then /login, then /profile save ${n}`
        : `⚠️ '${n}': không còn token để làm mới. Đăng nhập lại: /profile ${n}, rồi /login, rồi /profile save ${n}`
    default:
      return en
        ? `❌ '${n}': could not renew the token${r.detail ? ` (${r.detail})` : ''}. Try: /profile run ${n}`
        : `❌ '${n}': chưa làm mới được token${r.detail ? ` (${r.detail})` : ''}. Thử: /profile run ${n}`
  }
}

export function runSession(home = os.homedir(), name, cmdArgs = ['claude']) {
  const resolved = resolveProfileOrAlias(home, name)
  const sDir = prepareSession(home, resolved)
  const [bin, ...args] = cmdArgs && cmdArgs.length ? cmdArgs : ['claude']
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: sDir,
  }
  const res = spawnClaudeSync(bin, args, {
    env,
    stdio: 'inherit',
    cwd: process.cwd(),
  })
  syncSessionBack(home, resolved, sDir)
  if (res.error) {
    throw new SwapError(`Không chạy được lệnh '${bin}': ${res.error.message}`)
  }
  return res.status ?? 0
}

// ---------------------------------------------------------------- smart load balancing

export function balanceConfigFile(home) {
  return path.join(profilesDir(home), '.balance.json')
}

export function loadBalanceConfig(home = os.homedir()) {
  const f = balanceConfigFile(home)
  try {
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      if (data && typeof data === 'object') {
        return {
          enabled: Boolean(data.enabled),
          mode: data.mode === 'round-robin' ? 'round-robin' : 'least-used',
          pool: data.pool || 'all',
        }
      }
    }
  } catch {}
  return {
    enabled: false,
    mode: 'least-used',
    pool: 'all',
  }
}

export function saveBalanceConfig(home = os.homedir(), config) {
  const f = balanceConfigFile(home)
  const current = loadBalanceConfig(home)
  const merged = { ...current, ...config, updatedAt: new Date().toISOString() }
  atomicWrite(f, JSON.stringify(merged, null, 2))
  return merged
}

// `balance next`: same eligibility rules as auto-switch (quota, expiry, disabled, pools), chosen by balance mode
export function getNextBalancedProfile(home = os.homedir()) {
  return findNextProfile(home, { balance: { ...loadBalanceConfig(home), enabled: true } })
}

export function balanceSwap(home = os.homedir()) {
  const next = getNextBalancedProfile(home)
  if (!next) {
    throw new SwapError('Không tìm thấy profile khả dụng để cân bằng tải.')
  }
  swapProfile(home, next, {
    type: 'auto',
    reason: 'Smart load balance',
  })
  return next
}

// ---------------------------------------------------------------- webhooks

export function webhookConfigFile(home) {
  return path.join(profilesDir(home), '.webhook.json')
}

export function loadWebhookConfig(home = os.homedir()) {
  const f = webhookConfigFile(home)
  try {
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      if (data && typeof data === 'object') {
        return {
          telegram: data.telegram || null,
          discord: data.discord || null,
          slack: data.slack || null,
          generic: data.generic || null,
        }
      }
    }
  } catch {}
  return {
    telegram: null,
    discord: null,
    slack: null,
    generic: null,
  }
}

export function saveWebhookConfig(home = os.homedir(), config) {
  const f = webhookConfigFile(home)
  const current = loadWebhookConfig(home)
  const merged = { ...current, ...config, updatedAt: new Date().toISOString() }
  atomicWrite(f, JSON.stringify(merged, null, 2))
  return merged
}

export async function postHttpJson(targetUrl, payload) {
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  })
  return { status: res.status }
}

// a CLI swap exits right after returning; pending webhook posts are awaited by flushWebhooks() first
const pendingWebhooks = new Set()

function trackWebhook(promise) {
  const p = promise.catch(() => {}).finally(() => pendingWebhooks.delete(p))
  pendingWebhooks.add(p)
}

export function flushWebhooks() {
  return Promise.allSettled([...pendingWebhooks])
}

// webhook URLs embed secrets (Telegram bot token, Discord/Slack keys): show only the host
export function maskUrl(url) {
  try {
    return `${new URL(url).origin}/…`
  } catch {
    return '***'
  }
}

export async function sendWebhookNotification(home = os.homedir(), payload) {
  if (payload?.event !== 'test' && silenced()) return // an explicit `webhook test` still sends
  const cfg = loadWebhookConfig(home)
  const text = payload.text || `[claude-swap] ${payload.event || 'Swap Alert'}: ${payload.profile || 'Profile'} (${payload.reason || 'No reason'})`
  const discord = {
    embeds: [{ title: '🔀 claude-swap Notification', description: text, color: 0x3b82f6, timestamp: new Date().toISOString() }],
  }
  const targets = [
    [cfg.telegram, { text }],
    [cfg.discord, discord],
    [cfg.slack, { text }],
    [cfg.generic, payload],
  ].filter(([url]) => url)
  await Promise.allSettled(targets.map(([url, body]) => postHttpJson(url, body)))
}

// the text of the Monday webhook summary: each profile's quota now, the hungriest projects, last week's swaps
export function weeklyReport(home, cache = loadUsageCache(home)) {
  const weekAgo = Date.now() - 7 * 86400000
  const swaps = loadSwapHistory(home).filter(h => new Date(h.timestamp).getTime() >= weekAgo)
  const projects = projectUsageTotals(home, 7).slice(0, 5)
  return [
    '📊 [claude-swap] Báo cáo tuần',
    ...listProfiles(home).map(n => {
      const hit = cacheHit(home, cache, n)
      return `• ${n}: 5h ${Math.round(limitPct(hit, LABEL_5H))}% · 7d ${Math.round(limitPct(hit, LABEL_7D))}%`
    }),
    projects.length ? `Dự án tốn quota nhất: ${projects.map(p => `${path.basename(p.dir)} ${Math.round(p.pct)}%`).join(', ')}` : '',
    `Chuyển profile 7 ngày qua: ${swaps.length} lần (${swaps.filter(h => h.type === 'auto').length} tự động)`,
  ].filter(Boolean).join('\n')
}

export function alertsSentFile(home) {
  return path.join(profilesDir(home), '.alerts-sent.json')
}

// Webhook alerts for what the status line cannot tell you while you are away: a 7-day pace that would run out
// before the reset, and another profile whose full window has reset. Each goes out once per window, keyed by email
// and reset time (not by profile name, so a rename needs no migration).
export function sendQuotaAlerts(home, cache = loadUsageCache(home)) {
  if (silenced() || !Object.values(loadWebhookConfig(home)).some(Boolean)) return
  const cur = currentProfile(home)
  const resetKey = (hit, labels) => labels.map(l => findLimit(hit, l)).filter(Boolean).map(l => l[3] || l[2]).join(',')
  const alerts = []
  const pace = cur ? weeklyPace(home, cur, cache) : null
  if (pace && pace.pct >= WARN_PCT && pace.rate !== null && pace.rate > pace.budget) {
    alerts.push({
      key: `${profileEmail(home, cur)}|pace|${resetKey(cacheHit(home, cache, cur), [LABEL_7D])}`,
      event: 'quota_pace',
      profile: cur,
      text: `⚠ [claude-swap] ${cur}: 7 ngày đang dùng ${perHour(pace.rate)}, vượt mức ${perHour(pace.budget)} để đủ tới lúc reset (còn ${Math.round(100 - pace.pct)}% cho ${shortDuration(pace.hoursLeft * 3600000)}).`,
    })
  }
  for (const n of recoveredProfiles(home, cache, cur)) {
    alerts.push({
      key: `${profileEmail(home, n)}|recovered|${resetKey(cacheHit(home, cache, n), [LABEL_5H, LABEL_7D])}`,
      event: 'quota_recovered',
      profile: n,
      text: `✅ [claude-swap] ${n} đã hồi quota, dùng lại được: /profile ${n}`,
    })
  }
  // Monday 08:00 or later: one summary of the week (keyed by that Monday)
  const now = new Date()
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7), 8)
  if (now >= monday) alerts.push({ key: `report|${localDay(monday.getTime())}`, event: 'weekly_report', profile: cur || '', text: () => weeklyReport(home, cache) })
  let sent = {}
  try {
    sent = JSON.parse(fs.readFileSync(alertsSentFile(home), 'utf-8'))
  } catch {}
  const fresh = alerts.filter(a => !sent[a.key])
  if (!fresh.length) return
  const weekAgo = Date.now() - 8 * 86400000
  sent = Object.fromEntries(Object.entries(sent).filter(([, t]) => t > weekAgo))
  for (const a of fresh) {
    sent[a.key] = Date.now()
    const text = typeof a.text === 'function' ? a.text() : a.text // the report is built only when it goes out
    trackWebhook(sendWebhookNotification(home, { event: a.event, profile: a.profile, reason: a.event, text }))
  }
  atomicWrite(alertsSentFile(home), JSON.stringify(sent, null, 2))
}

export async function testWebhook(home = os.homedir(), type = null) {
  const cfg = loadWebhookConfig(home)
  const lang = loadLanguage(home)
  const testMsg = lang === 'en'
    ? '🔔 [claude-swap] Test alert: Webhook connection verified successfully!'
    : '🔔 [claude-swap] Cảnh báo thử nghiệm: Kết nối Webhook hoạt động thành công!'

  const targets = type ? [type] : Object.keys(cfg).filter(k => cfg[k])
  if (targets.length === 0 || !targets.some(k => cfg[k])) {
    throw new SwapError(lang === 'en' ? 'No webhooks configured yet.' : 'Chưa có webhook nào được cấu hình.')
  }

  await sendWebhookNotification(home, {
    event: 'test',
    text: testMsg,
    profile: currentProfile(home) || 'default',
    reason: 'manual-test',
  })
  return targets.filter(k => cfg[k])
}

// ---------------------------------------------------------------- budget tracker

export function budgetConfigFile(home) {
  return path.join(profilesDir(home), '.budget.json')
}

export function loadBudgetConfig(home = os.homedir()) {
  const f = budgetConfigFile(home)
  try {
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      if (data && typeof data === 'object') {
        return {
          limits: data.limits || {},
          currency: data.currency || 'USD',
          updatedAt: data.updatedAt || null,
        }
      }
    }
  } catch {}
  return {
    limits: {},
    currency: 'USD',
    updatedAt: null,
  }
}

export function saveBudgetConfig(home = os.homedir(), config) {
  const f = budgetConfigFile(home)
  const current = loadBudgetConfig(home)
  const merged = { ...current, ...config, updatedAt: new Date().toISOString() }
  atomicWrite(f, JSON.stringify(merged, null, 2))
  return merged
}

export function setBudgetLimit(home = os.homedir(), profile, amount) {
  const resolved = resolveProfileOrAlias(home, profile)
  const num = parseFloat(amount)
  if (isNaN(num) || num <= 0) {
    throw new SwapError('Hạn mức ngân sách phải là số dương lớn hơn 0.')
  }
  const cfg = loadBudgetConfig(home)
  cfg.limits[resolved] = num
  saveBudgetConfig(home, cfg)
  return { profile: resolved, limit: num, currency: cfg.currency }
}

export function removeBudgetLimit(home = os.homedir(), profile) {
  const resolved = resolveProfileOrAlias(home, profile)
  const cfg = loadBudgetConfig(home)
  delete cfg.limits[resolved]
  saveBudgetConfig(home, cfg)
  return resolved
}

export function formatBudgetReport(home = os.homedir(), lang = 'vi') {
  const cfg = loadBudgetConfig(home)
  const entries = Object.entries(cfg.limits)
  if (entries.length === 0) {
    return lang === 'en'
      ? 'No budget limits configured. Use: /profile budget set <profile> <amount>'
      : 'Chưa có hạn mức ngân sách nào. Dùng: /profile budget set <tên> <hạn_mức>'
  }
  const lines = [
    lang === 'en'
      ? `💰 Profile Budget Limits (${cfg.currency}):`
      : `💰 Danh sách Hạn mức Ngân sách (${cfg.currency}):`,
  ]
  for (const [p, limit] of entries) {
    lines.push(`  • ${p}: ${limit.toFixed(2)} ${cfg.currency}/tháng`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- masking & safe share

export function maskConfigFile(home) {
  return path.join(profilesDir(home), '.mask.json')
}

export function isMaskingEnabled(home = os.homedir()) {
  const f = maskConfigFile(home)
  try {
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      return Boolean(data && data.enabled)
    }
  } catch {}
  return false
}

export function setMasking(home = os.homedir(), enabled = true) {
  const f = maskConfigFile(home)
  atomicWrite(f, JSON.stringify({ enabled: Boolean(enabled), updatedAt: new Date().toISOString() }, null, 2))
  return Boolean(enabled)
}

export function maskEmail(email, enabled = true) {
  if (!enabled || !email || typeof email !== 'string') return email
  const atIdx = email.indexOf('@')
  if (atIdx <= 1) return '***@' + (email.slice(atIdx + 1) || '')
  const name = email.slice(0, atIdx)
  const domain = email.slice(atIdx + 1)
  const visible = name.slice(0, 2)
  return `${visible}***@${domain}`
}

export function exportSafeShare(home = os.homedir(), outputPath = null) {
  const profiles = listProfiles(home)
  const safeProfiles = {}
  for (const name of profiles) {
    safeProfiles[name] = {
      tags: getProfileTags(home, name),
      email: maskEmail(profileEmail(home, name), true),
    }
  }

  const payload = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    profiles: safeProfiles,
    aliases: loadAliases(home),
    branchBindings: loadBranchBindings(home),
    affinities: listModelAffinities(home),
    autoConfig: loadAutoSwitchConfig(home),
    balanceConfig: loadBalanceConfig(home),
    budgetConfig: loadBudgetConfig(home),
  }

  const jsonStr = JSON.stringify(payload, null, 2)
  if (outputPath) {
    const full = path.resolve(outputPath)
    atomicWrite(full, jsonStr, 0o644)
    return { path: full, payload }
  }
  return { path: null, json: jsonStr, payload }
}

// ---------------------------------------------------------------- shell completion

export function generateCompletion(shell = 'bash') {
  const subcommands = [
    'list', 'swap', 'new', 'save', 'delete', 'usage', 'auto', 'run', 'add-token',
    'rename', 'disable', 'enable', 'disabled', 'upgrade', 'web', 'dashboard', 'balance',
    'webhook', 'budget', 'cost', 'mask', 'share', 'completion', 'alias', 'unalias',
    'aliases', 'bind', 'unbind', 'bind-branch', 'unbind-branch', 'branch-bindings',
    'tag', 'untag', 'tags', 'affinity', 'unaffinity', 'affinities', 'temp', 'untemp',
    'statusline', 'prompt', 'notify', 'history', 'undo', 'stats', 'cooldown', 'doctor',
    'cleanup', 'lang', 'sync', 'forecast', 'pick', 'version', 'repair', 'schedule', 'unschedule', 'settings',
  ].join(' ')

  if (shell === 'zsh') {
    return `#compdef swap.js claude-swap

_claude_swap() {
  local -a commands
  commands=(${subcommands})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  fi
}

compdef _claude_swap swap.js
compdef _claude_swap claude-swap
`
  }

  if (shell === 'fish') {
    return `complete -c swap.js -f -a "${subcommands}"
complete -c claude-swap -f -a "${subcommands}"
`
  }

  return `_claude_swap_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${subcommands}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi
}
complete -F _claude_swap_completions swap.js
complete -F _claude_swap_completions claude-swap
`
}

// ---------------------------------------------------------------- self-upgrade

export const MARKETPLACE = 'claude-swap'
export const PLUGIN_ID = `profile-swap@${MARKETPLACE}`

// the plugin manager owns the install (a versioned cache dir, not a git checkout), so upgrade goes through it
export function upgradePlugin(run = spawnClaudeSync) {
  const outputs = []
  for (const args of [
    ['plugin', 'marketplace', 'update', MARKETPLACE],
    ['plugin', 'update', PLUGIN_ID],
  ]) {
    const cmdline = `claude ${args.join(' ')}`
    const res = run('claude', args, { encoding: 'utf-8', timeout: 120000 })
    if (res.error) throw new SwapError(`Không chạy được '${cmdline}': ${res.error.message}`)
    const out = `${res.stdout || ''}${res.stderr || ''}`.trim()
    if (res.status !== 0) throw new SwapError(`'${cmdline}' thất bại (mã ${res.status})${out ? `:\n${out}` : ''}`)
    if (out) outputs.push(out)
  }
  return outputs.join('\n')
}

// ---------------------------------------------------------------- cli

// `help <keyword>`: only the commands whose line mentions it, under their section titles
export function formatHelpReport(color = null, lang = 'vi', keyword = '') {
  const full = helpText(color, lang)
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return full
  const plain = line => line.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase()
  const out = []
  let title = null
  for (const line of full.split('\n').slice(1)) {
    if (!line.startsWith('  ')) {
      title = line.trim() ? line : null
    } else if (plain(line).includes(kw)) {
      if (title) out.push(title)
      title = null
      out.push(line)
    }
  }
  if (!out.length) return lang === 'en' ? `No command matches '${keyword}'. /profile help lists them all.` : `Không có lệnh nào khớp '${keyword}'. Gõ /profile help để xem tất cả.`
  return [full.split('\n')[0], '', ...out].join('\n')
}

function helpText(color, lang) {
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
      `  ${cmd('/profile rename <old> <new>')} Rename a profile (aliases, bindings, history follow)`,
      `  ${cmd('/profile delete <name>')}     Delete profile`,
      `  ${cmd('/profile usage')}             Detailed 5h, 7d and per-model quotas`,
      `  ${cmd('/profile folder')}            Open profile config directory`,
      `  ${cmd('/profile lang [vi|en]')}      View or switch language (Vietnamese / English)`,
      `  ${cmd('/profile run <name> [-- cmd]')} Run isolated Claude Code session in parallel`,
      `  ${cmd('/profile add-token <tok> [n]')} Register profile from setup-token or API key`,
      `  ${cmd('/profile upgrade')}            Update plugin to the latest release (auto-reloads; else /reload-plugins)`,
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
      `  ${cmd('/profile repair [name]')}     Renew a profile's expired token (without swapping)`,
      `  ${cmd('/profile repair auto on|off')} Renew expired tokens in the background, every 6h`,
      `  ${cmd('/profile schedule <time> <p>')} Swap on a schedule (e.g. 09:00-18:00 work)`,
      `  ${cmd('/profile unschedule <n|all>')} Remove a schedule entry`,
      `  ${cmd('/profile help <keyword>')}    Only the commands mentioning that keyword`,
      `  ${cmd('/profile settings')}          View & edit every setting in one table`,
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
      `  ${cmd('/profile web [--port <p>]')}   Open interactive Web Dashboard UI`,
      `  ${cmd('/profile balance [mode]')}     Smart Quota load balancing (least-used, round-robin)`,
      `  ${cmd('/profile webhook [set|test]')} Setup external alerts (Telegram, Discord, Slack)`,
      `  ${cmd('/profile budget [set]')}       Monthly budget and cost tracker`,
      `  ${cmd('/profile mask [on|off]')}      Mask account emails in list & dashboard`,
      `  ${cmd('/profile share [file]')}       Export safe configuration bundle (no tokens)`,
      `  ${cmd('/profile completion [sh]')}    Generate shell autocompletion (bash, zsh, fish)`,
      `  ${cmd('/profile temp <name> [time]')} Temporary swap with auto-revert (e.g. 30m, 1h)`,
      `  ${cmd('/profile untemp')}            Cancel temporary swap and revert immediately`,
      `  ${cmd('/profile statusline')}        Detailed usage status line (on|off|band|line; plain: shell prompt string)`,
      `  ${cmd('/profile prompt <shell>')}    Config snippet for starship, zsh, bash, tmux, powershell`,
      `  ${cmd('/profile notify on|off')}     Toggle desktop notifications on profile swap`,
      `  ${cmd('/profile history [n]')}       View recent swap history`,
      `  ${cmd('/profile undo')}              Switch back to the profile before the last swap`,
      `  ${cmd('/profile stats')}             Swap counts and usage per project (--project)`,
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
    `  ${cmd('/profile rename <cũ> <mới>')} Đổi tên profile (alias, liên kết, lịch sử đi theo)`,
    `  ${cmd('/profile delete <tên>')}      Xóa profile`,
    `  ${cmd('/profile usage')}             Xem chi tiết quota 5h, 7d và từng model`,
    `  ${cmd('/profile folder')}            Mở thư mục chứa file cấu hình profile`,
    `  ${cmd('/profile lang [vi|en]')}      Xem hoặc đổi ngôn ngữ (Tiếng Việt / English)`,
    `  ${cmd('/profile run <tên> [-- cmd]')} Chạy session Claude Code độc lập song song`,
    `  ${cmd('/profile add-token <tok> [tên]')} Tạo profile từ setup-token hoặc API key`,
    `  ${cmd('/profile upgrade')}            Cập nhật plugin lên bản mới nhất (tự nạp lại; không thì /reload-plugins)`,
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
    `  ${cmd('/profile repair [tên]')}      Làm mới token hết hạn của profile (không cần chuyển sang)`,
    `  ${cmd('/profile repair auto on|off')} Tự làm mới token hết hạn ở nền, 6 giờ một lần`,
    `  ${cmd('/profile schedule <giờ> <p>')} Đổi profile theo lịch (vd: 09:00-18:00 work)`,
    `  ${cmd('/profile unschedule <n|all>')} Xóa lịch đổi profile`,
    `  ${cmd('/profile help <từ khóa>')}    Chỉ hiện các lệnh có từ khóa đó`,
    `  ${cmd('/profile settings')}          Xem & sửa mọi cài đặt trong một bảng`,
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
    `⏳ ${bold('Mượn tạm, Giao diện & Tiện ích:')}`,
    `  ${cmd('/profile web [--port <p>]')}  Mở Web Dashboard trực quan cấu hình đa tài khoản`,
    `  ${cmd('/profile balance [mode]')}    Cân bằng tải Quota thông minh (least-used, round-robin)`,
    `  ${cmd('/profile webhook [set|test]')} Cấu hình cảnh báo Telegram, Discord, Slack`,
    `  ${cmd('/profile budget [set|unset]')} Quản lý hạn mức chi tiêu hàng tháng`,
    `  ${cmd('/profile mask [on|off]')}     Che mờ email tài khoản (list & dashboard)`,
    `  ${cmd('/profile share [file]')}      Xuất cấu hình an toàn không chứa token`,
    `  ${cmd('/profile completion [sh]')}   Sinh mã autocomplete cho Bash, Zsh, Fish`,
    `  ${cmd('/profile temp <tên> [tg]')}   Mượn tạm profile (vd: 30m, 1h) rồi tự hoàn lại`,
    `  ${cmd('/profile untemp')}            Hủy mượn tạm và quay về profile gốc ngay`,
    `  ${cmd('/profile statusline')}        Status line chi tiết usage (on|off|band|line; trần: chuỗi cho Shell prompt)`,
    `  ${cmd('/profile prompt <shell>')}    Snippet cấu hình starship, zsh, bash, tmux, powershell`,
    `  ${cmd('/profile notify on|off')}     Bật / tắt thông báo desktop khi đổi profile`,
    `  ${cmd('/profile history [n]')}       Xem lịch sử các lần chuyển đổi gần nhất`,
    `  ${cmd('/profile undo')}              Quay lại profile trước lần chuyển gần nhất`,
    `  ${cmd('/profile stats')}             Thống kê lần đổi & usage theo dự án (--project)`,
    '',
    `🔐 ${bold('Sao lưu & Đồng bộ (Sync):')}`,
    `  ${cmd('/profile sync [push|pull]')}  Đồng bộ bản sao lưu mã hóa đa thiết bị`,
    `  ${cmd('/profile export <file>')}     Xuất bản sao lưu mã hóa AES-256`,
    `  ${cmd('/profile import-enc <file>')} Khôi phục từ file mã hóa`,
    `  ${cmd('/profile import <folder>')}   Nhập profile từ thư mục cấu hình khác`,
  ].join('\n')
}

// ---------------------------------------------------------------- settings: every option in one place

function onOff(v) {
  const t = String(v).trim().toLowerCase()
  if (['on', 'true', '1', 'bật', 'yes'].includes(t)) return true
  if (['off', 'false', '0', 'tắt', 'no'].includes(t)) return false
  throw new SwapError(`Giá trị '${v}' không hợp lệ. Dùng: on | off`)
}

function pctSetting(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1 || n > 100) throw new SwapError(`Giá trị '${v}' không hợp lệ. Dùng một số từ 1 đến 100.`)
  return n
}

const patchAuto = (home, patch) => saveAutoSwitchConfig(home, { ...loadAutoSwitchConfig(home), ...patch })

function profileSetting(home, v) {
  const t = String(v ?? '').trim()
  if (!t || t === 'none') return null
  const name = resolveProfileOrAlias(home, t)
  if (!profileExists(home, name)) throw new SwapError(`Profile '${t}' không tồn tại.`)
  return name
}

// key, kind ('bool' | 'number' | 'choice' | 'text'), what it does, and how it is read and written; each setter
// validates and goes through the same helper its own subcommand uses
const SETTINGS = [
  ['auto.enabled', 'bool', 'Tự động chuyển profile khi vượt ngưỡng', h => loadAutoSwitchConfig(h).enabled, (h, v) => patchAuto(h, { enabled: onOff(v) })],
  ['auto.threshold', 'number', 'Ngưỡng % quota 5h để tự chuyển', h => loadAutoSwitchConfig(h).threshold, (h, v) => patchAuto(h, { threshold: pctSetting(v) })],
  ['auto.safeguard', 'number', 'Né profile có 7 ngày ≥ % này (0 = tắt)', h => loadAutoSwitchConfig(h).safeguardThreshold ?? 0,
    (h, v) => patchAuto(h, { safeguardThreshold: Number(v) === 0 || v === 'off' ? null : pctSetting(v) })],
  ['auto.return', 'bool', 'Tự quay về profile chính khi nó hồi quota', h => loadAutoSwitchConfig(h).autoReturn, (h, v) => patchAuto(h, { autoReturn: onOff(v) })],
  ['auto.primary', 'profile', 'Profile chính để quay về', h => loadAutoSwitchConfig(h).primaryProfile || '', (h, v) => patchAuto(h, { primaryProfile: profileSetting(h, v) })],
  ['auto.pool', 'text', 'Chỉ chuyển trong nhóm có tag này (trống = tất cả)', h => loadAutoSwitchConfig(h).pool || '',
    (h, v) => patchAuto(h, { pool: String(v ?? '').trim() && v !== 'all' ? String(v).trim() : null })],
  ['auto.order', 'text', 'Thứ tự ưu tiên khi chuyển, cách nhau dấu phẩy', h => loadAutoSwitchConfig(h).order.join(','),
    (h, v) => patchAuto(h, { order: String(v ?? '').split(',').map(x => x.trim()).filter(Boolean).map(x => profileSetting(h, x)) })],
  ['balance', 'choice:off,least-used,round-robin', 'Cân bằng tải giữa các profile', h => {
    const b = loadBalanceConfig(h)
    return b.enabled ? b.mode : 'off'
  }, (h, v) => {
    if (!['off', 'least-used', 'round-robin'].includes(v)) throw new SwapError('Dùng: off | least-used | round-robin')
    saveBalanceConfig(h, { ...loadBalanceConfig(h), enabled: v !== 'off', ...(v !== 'off' ? { mode: v } : {}) })
  }],
  ['statusline', 'choice:band,line,off', 'Status line: dải màu, dòng chữ, hoặc tắt', h => (isStatuslineEnabled(h) ? statuslineMode(h) : 'off'),
    (h, v) => (v === 'off' ? setStatuslineEnabled(h, false) : setStatuslineMode(h, v))],
  ['notify', 'bool', 'Thông báo desktop khi đổi profile', h => Boolean(loadNotificationConfig(h).enabled),
    (h, v) => saveNotificationConfig(h, { ...loadNotificationConfig(h), enabled: onOff(v) })],
  ['mask', 'bool', 'Che email trong list và dashboard', h => isMaskingEnabled(h), (h, v) => setMasking(h, onOff(v))],
  ['repair.auto', 'bool', 'Tự làm mới token hết hạn ở nền, 6 giờ một lần', h => loadRepairConfig(h).auto, (h, v) => setAutoRepair(h, onOff(v))],
  ['lang', 'choice:vi,en', 'Ngôn ngữ', h => loadLanguage(h), (h, v) => setLanguage(h, v)],
]

// [{ key, type, choices?, value, desc }]: what `/profile settings` shows and its editor draws
export function settingsList(home) {
  return SETTINGS.map(([key, kind, desc, get]) => {
    const [type, list] = kind.split(':')
    const choices = type === 'profile' ? ['', ...listProfiles(home)] : list ? list.split(',') : undefined
    return { key, type: type === 'profile' ? 'choice' : type, ...(choices ? { choices } : {}), value: get(home), desc }
  })
}

export function setSetting(home, key, value) {
  const entry = SETTINGS.find(([k]) => k === key)
  if (!entry) throw new SwapError(`Không có cài đặt '${key}'. Xem: /profile settings`)
  entry[4](home, value)
  return entry[3](home)
}

export function formatSettings(home) {
  const rows = settingsList(home)
  const w = Math.max(...rows.map(r => r.key.length))
  const shown = v => (v === true ? 'on' : v === false ? 'off' : v === '' ? '—' : String(v))
  return [
    '⚙️ Cài đặt claude-swap:',
    ...rows.map(r => `  ${r.key.padEnd(w)}  ${shown(r.value).padEnd(12)}  ${r.desc}`),
    '',
    'Đổi: /profile settings set <key> <giá trị>   (vd: /profile settings set auto.threshold 90)',
  ].join('\n')
}

// Bare `/profile`: the live profile, its quota and every setting, above the command list.
// Single-codepoint emoji only: a VS16 one (⚙️, ↩️, 🏷️) is drawn one cell wide by some terminals and breaks the columns.
const SETTING_ICONS = {
  'auto.enabled': '🤖', 'auto.threshold': '🎯', 'auto.safeguard': '🚧', 'auto.return': '🔁', 'auto.primary': '⭐',
  'auto.pool': '👥', 'auto.order': '🔢', balance: '🔄', statusline: '📊', notify: '🔔', mask: '🙈', 'repair.auto': '🔧', lang: '🌐',
}

export function overviewData(home) {
  const cur = currentProfile(home)
  const hit = cur ? cacheHit(home, loadUsageCache(home), cur) : {}
  return {
    profile: cur || '',
    email: cur ? maskEmail(profileEmail(home, cur), isMaskingEnabled(home)) : '',
    profiles: listProfiles(home).length,
    disabled: loadDisabledProfiles(home).length,
    rateLimited: Boolean(cur) && isRateLimited(hit),
    stale: cur ? staleNote(hit, loadLanguage(home)) : '',
    windows: cur ? quotaWindows(hit) : [],
    settings: settingsList(home).map(r => ({ ...r, icon: SETTING_ICONS[r.key] || '•' })),
  }
}

export function formatOverview(home, color = null, lang = 'vi') {
  const d = overviewData(home)
  const en = lang === 'en'
  const c = shouldColor(color) ? (code, t) => `\x1b[${code}m${t}\x1b[0m` : (_, t) => t
  const w = Math.max(...d.settings.map(r => r.key.length))
  const value = v => (v === true ? c('1;32', en ? '● on ' : '● bật') : v === false ? c('90', en ? '○ off' : '○ tắt') : v === '' || v === 'off' ? c('90', v || '—') : c('1;36', String(v)))
  const pad = (v, n) => v + ' '.repeat(Math.max(0, n - String(v).replace(/\x1b\[[0-9;]*m/g, '').length))
  const out = [`🔀 ${c('1;36', 'claude-swap')} · ${en ? 'Overview' : 'Tổng quan'}`, '']
  if (d.profile) {
    const count = `📦 ${d.profiles} profile${d.disabled ? ` · 🚫 ${d.disabled} ${en ? 'disabled' : 'tắt'}` : ''}`
    out.push(`  👤 ${c('1;32', d.profile)}${d.email ? ` ${c('90', d.email)}` : ''}   ${count}`)
    for (const win of d.windows) {
      const code = pctCode(win.pct)
      const label = win.name === '5h' ? (en ? '5 hours' : '5 giờ  ') : (en ? '7 days ' : '7 ngày ')
      out.push(`  ${win.name === '5h' ? '⌛' : '📅'} ${c('1;36', label)} ${c('90', '[')}${c(code, bar(win.pct, 16))}${c('90', ']')} ${c(code, `${String(win.pct).padStart(3)}%`)}${win.pct >= WARN_PCT ? ' 🔥' : ''}${win.left ? `  ${c('36', `⏳ ${win.left}`)}` : ''}`)
    }
    if (d.rateLimited) out.push(`  ${c('1;33', en ? '⏳ usage endpoint busy (429), quota shows again soon' : '⏳ máy chủ usage đang bận (429), quota sẽ hiện lại sau')}`)
    if (d.stale) out.push(`  ${c('1;33', d.stale)}`)
  } else {
    out.push(`  ${c('1;33', en ? '⚠ No active profile. Create one: /profile new <name>' : '⚠ Chưa có profile nào active. Tạo bằng: /profile new <tên>')}`)
  }
  out.push('', `🧰 ${c('1;36', en ? 'Settings' : 'Cài đặt')} ${c('90', en ? '(edit: /profile settings)' : '(sửa: /profile settings)')}`)
  for (const r of d.settings) out.push(`  ${r.icon} ${pad(r.key, w)}  ${pad(value(r.value), 14)}${c('90', r.desc)}`)
  return out.join('\n')
}

// ---------------------------------------------------------------- colourised output

const ESC = '\x1b'
// commands whose output is for people only; the others (current, bind get, auto check, statusline, export...) are parsed by the hook or shells
const PRETTY_CMDS = new Set([
  'swap', 'undo', 'save', 'new', 'rename', 'delete', 'tag', 'untag', 'tags', 'history', 'stats', 'cooldown', 'forecast',
  'auto', 'balance', 'disable', 'enable', 'disabled', 'alias', 'unalias', 'aliases', 'notify', 'mask', 'cleanup',
  'temp', 'untemp', 'budget', 'cost', 'upgrade', 'affinity', 'unaffinity', 'affinities', 'unbind', 'bind-branch',
  'unbind-branch', 'branch-bindings', 'lang', 'language', 'webhook', 'sync', 'import', 'add-token', 'run', 'repair', 'schedule', 'unschedule', 'settings',
])

// Wraps `text` in an SGR code and re-opens it after every reset inside, so nested highlights do not cut it short.
function sgr(code, text) {
  return `${ESC}[${code}m${text.split(`${ESC}[0m`).join(`${ESC}[0m${ESC}[${code}m`)}${ESC}[0m`
}

// Gives one plain line colour by what it says: failures red, successes green, titles cyan, 'names' yellow, % by load.
export function colorizeLine(line) {
  if (!line || line.includes(ESC)) return line
  let out = line
    .replace(/(^|[\s(])'([^'\s]{1,60})'(?=$|[\s.,;:)])/g, (_, pre, n) => `${pre}${sgr('1;33', `'${n}'`)}`) // 'profile-name', not an apostrophe in prose
    .replace(/\b(\d{1,3})%/g, (m, n) => sgr(pctCode(Number(n)), m))
    .replace(/ (➔|➜|→) /g, (_, a) => ` ${sgr('1;36', a)} `)
    .replace(/\b(BẬT|ON|bật)\b/g, m => sgr('1;32', m))
    .replace(/\b(TẮT|OFF|off|tắt)\b/g, m => sgr('1;31', m))
    .replace(/(\[(?:auto-swap|manual|auto|project|branch)\])/g, m => sgr('36', m))
  const lead = line.trimStart()
  if (/^(❌|🚫.*lỗi)/.test(lead)) return sgr('1;31', out)
  if (/^(✨|✅|🎉)/.test(lead)) return sgr('1;32', out)
  if (/^(⚠️|🚨|⏳)/.test(lead)) return sgr('1;33', out)
  if (/^(ℹ️|💡)/.test(lead)) return sgr('90', out)
  if (!/^\s/.test(line) && /^\p{Extended_Pictographic}/u.test(lead) && /[:：]$/.test(lead)) return sgr('1;36', out) // a title
  if (!/^\s/.test(line) && /^(🔀|↩️|🔤|🏷️|🧹|📟|🔔|🛡️|⚖️|🤖|🧠|⬆️|📈|📊|📜|⏱️|🔑)/u.test(lead)) return sgr('1;36', out)
  return out
}

export function colorizeOutput(text) {
  return String(text).split('\n').map(colorizeLine).join('\n')
}

export async function runCli(argv, home = os.homedir()) {
  const words = argv.filter(a => !a.startsWith('--'))
  const pretty =
    shouldColor() && !argv.includes('--no-color') && !argv.includes('--json') &&
    PRETTY_CMDS.has(words[0]) && !(words[0] === 'auto' && words[1] === 'check')
  const colour = shouldColor() && !argv.includes('--no-color')
  const origLog = console.log
  const origError = console.error
  const tint = fn => (...args) => fn(...args.map(a => (typeof a === 'string' ? colorizeOutput(a) : a)))
  // ponytail: patches the global console for the length of one CLI run; two overlapping runCli calls in one process would restore in the wrong order
  if (colour) console.error = tint(origError) // errors are for people whatever the command is
  if (pretty) console.log = tint(origLog)
  try {
    return await runCliInner(argv, home)
  } finally {
    console.log = origLog
    console.error = origError
  }
}

async function runCliInner(argv, home) {
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

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const keyword = filteredArgv.slice(1).join(' ')
    if (!keyword) console.log(`${formatOverview(home, color, lang)}\n`)
    console.log(formatHelpReport(color, lang, keyword))
    return 0
  }

  if (cmd === 'overview') {
    console.log(argv.includes('--json') ? JSON.stringify(overviewData(home)) : formatOverview(home, color, lang))
    return 0
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(SCRIPT_PATH), 'package.json'), 'utf-8'))
    console.log(`claude-swap v${version}`)
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
      case 'upgrade': {
        const out = upgradePlugin()
        if (out) console.log(out)
        console.log(
          lang === 'en'
            ? '⬆️ Plugin updated. Run /reload-plugins (or restart Claude Code) to load the new version.'
            : '⬆️ Đã cập nhật plugin. Chạy /reload-plugins (hoặc khởi động lại Claude Code) để nạp bản mới.'
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
      case 'settings': {
        if (filteredArgv.includes('--json')) {
          console.log(JSON.stringify(settingsList(home)))
          return 0
        }
        if (filteredArgv[1] === 'set') {
          const key = filteredArgv[2]
          if (!key) throw new SwapError('Cú pháp: /profile settings set <key> <giá trị>')
          const value = setSetting(home, key, filteredArgv.slice(3).join(' '))
          console.log(`✅ ${key} = ${value === true ? 'on' : value === false ? 'off' : value === '' ? '—' : value}`)
          return 0
        }
        console.log(formatSettings(home))
        return 0
      }
      case 'schedule': {
        if (filteredArgv[1]) addScheduleRule(home, filteredArgv[1], filteredArgv[2])
        console.log(formatSchedule(home, lang))
        return 0
      }
      case 'unschedule': {
        removeScheduleRule(home, filteredArgv[1] || 'all')
        console.log(formatSchedule(home, lang))
        return 0
      }
      case 'repair': {
        if (filteredArgv[1] === 'auto') {
          const v = filteredArgv[2]
          if (v === 'on' || v === 'off') setAutoRepair(home, v === 'on')
          const on = loadRepairConfig(home).auto
          console.log(
            lang === 'en'
              ? `🔧 Auto repair: ${on ? 'ON (every 6h, renews expired tokens in the background)' : 'OFF'}`
              : `🔧 Tự sửa token: ${on ? 'BẬT (6 giờ một lần, làm mới token hết hạn ở nền)' : 'TẮT'}`
          )
          return 0
        }
        const names = filteredArgv[1] ? [filteredArgv[1]] : brokenProfiles(home)
        if (!names.length) {
          console.log(lang === 'en' ? '✅ Every saved login works.' : '✅ Mọi profile đều đăng nhập tốt, không cần sửa.')
          return 0
        }
        let failed = 0
        for (const n of names) {
          const r = await repairProfile(home, n)
          if (r.state === 'failed') failed++
          console.log(formatRepair(r, lang))
        }
        return failed ? 1 : 0
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
        console.log(`🔀 Đã chuyển sang '${currentProfile(home) || name}'`)
        console.log('ℹ️ Không cần thoát session: Claude dùng tài khoản mới ở lần kiểm tra đăng nhập kế tiếp (xem /status).')
        return 0
      }
      case 'rename': {
        if (!filteredArgv[1] || !filteredArgv[2]) throw new SwapError('Cú pháp: /profile rename <tên_cũ> <tên_mới>')
        const res = renameProfile(home, filteredArgv[1], filteredArgv[2])
        console.log(`✏️ Đã đổi tên profile '${res.from}' ➔ '${res.to}'`)
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
          const bal = loadBalanceConfig(home)
          if (bal.enabled) {
            console.log(`⚖️ Chọn profile kế tiếp theo cân bằng tải: ${bal.mode}${bal.pool !== 'all' ? ` (pool: ${bal.pool})` : ''}`)
          } else if (cfg.order && cfg.order.length > 0) {
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
          if (isolatedSession(home)) {
            console.log('ℹ️ Bỏ qua auto-switch trong session cô lập (/profile run).')
            return 0
          }
          const res = await autoCheckAndSwap(home)
          if (res.swapped) {
            const why = res.isTempRevert
              ? 'hết hạn mượn tạm'
              : res.isSchedule
              ? 'theo lịch'
              : res.isBranchBinding
              ? 'theo nhánh Git'
              : res.isAutoReturn
              ? 'quay về profile chính'
              : res.reason
            console.log(`[auto-swap] 🔀 Đã tự động chuyển từ '${res.from}' sang '${res.to}' (${why}).`)
          } else if (res.reason === 'no_candidate') {
            console.log(`[auto-swap] ⚠️ Profile '${res.current}' đạt mức ${res.util}% nhưng không có profile thay thế khả dụng.`)
          } else if (res.reason === 'disabled') {
            console.log('ℹ️ Tự động chuyển profile đang tắt.')
          } else {
            console.log(`✅ Không cần chuyển profile (mức dùng: ${res.util}%, ngưỡng: ${res.threshold}%).`)
          }
          console.log(`[status] ${JSON.stringify(statusLineData(home))}`) // the hook draws this line (`null` = hide)
          try {
            sendQuotaAlerts(home)
          } catch {}
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
        const targetPath = positionalArgs(filteredArgv, 1)[0]
        if (!targetPath) throw new SwapError(`Cú pháp: /profile export <đường dẫn file> (mật khẩu qua ${PASSWORD_HINT})`)
        const password = readPasswordArg(filteredArgv)
        if (!password) throw new SwapError(`Vui lòng cung cấp mật khẩu qua ${PASSWORD_HINT}.`)
        const res = exportEncryptedProfiles(home, targetPath, password)
        console.log(`🔐 Đã xuất ${res.count} profiles đã mã hóa ra: ${res.path}`)
        return 0
      }
      case 'import-enc': {
        const sourcePath = positionalArgs(filteredArgv, 1)[0]
        if (!sourcePath) throw new SwapError(`Cú pháp: /profile import-enc <đường dẫn file> [--force] (mật khẩu qua ${PASSWORD_HINT})`)
        const password = readPasswordArg(filteredArgv)
        if (!password) throw new SwapError(`Vui lòng cung cấp mật khẩu qua ${PASSWORD_HINT}.`)
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
        if (filteredArgv.includes('--json')) {
          console.log(JSON.stringify({ swaps: swapStats(home), projectDays: 7, projects: projectUsageTotals(home, 7) }, null, 2))
          return 0
        }
        console.log(filteredArgv.includes('--project') ? formatProjectUsage(home, 7, lang) : `${formatSwapStats(home)}\n\n${formatProjectUsage(home, 7, lang)}`)
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
        const sub = filteredArgv[1]
        if (sub === 'line' || sub === 'band') {
          setStatuslineMode(home, sub)
          console.log(
            lang === 'en'
              ? `📟 Status line: ON, shown as ${sub === 'line' ? 'a plain line under the prompt' : 'a coloured band above the prompt'}`
              : `📟 Status line: BẬT, hiện ${sub === 'line' ? 'thành dòng chữ thường dưới khung nhập' : 'thành dải màu trên khung nhập'}`
          )
          return 0
        }
        if (sub === 'on' || sub === 'off' || sub === 'toggle') {
          const enabled = sub === 'toggle' ? !isStatuslineEnabled(home) : sub === 'on'
          setStatuslineEnabled(home, enabled)
          console.log(
            lang === 'en'
              ? `📟 Status line: ${enabled ? 'ON (usage details)' : 'OFF'}`
              : `📟 Status line: ${enabled ? 'BẬT (hiện chi tiết usage)' : 'TẮT'}`
          )
          return 0
        }
        // the hook polls `statusline json`, so it brings the current profile's quota up to date (USAGE_TTL-cached)
        if (sub === 'json') {
          try {
            await refreshUsage(home, [currentProfile(home)])
            // a suggestion compares the other profiles: bring them up to date while the current one is running out
            const d = statusLineData(home)
            if (d && hotWindow(d.windows) && !loadAutoSwitchConfig(home).enabled) await refreshUsage(home, listProfiles(home))
            sendQuotaAlerts(home)
            maybeAutoRepair(home)
          } catch {}
        }
        console.log(
          sub === 'text'
            ? statusLineText(home)
            : sub === 'ansi'
            ? statusLineData(home)?.ansi || ''
            : sub === 'json'
            ? JSON.stringify(statusLineData(home))
            : getStatusline(home)
        )
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
      case 'undo': {
        const res = undoSwap(home)
        console.log(
          lang === 'en'
            ? `↩️ Switched back from '${res.from}' to '${res.to}'.`
            : `↩️ Đã quay lại từ '${res.from}' về '${res.to}'.`
        )
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
          if (!target) throw new SwapError('Cú pháp: /profile sync setup <đường_dẫn_file>')
          const cfg = loadSyncConfig(home)
          cfg.targetPath = path.resolve(target)
          saveSyncConfig(home, cfg)
          console.log(`☁️ Đã thiết lập đồng bộ với đường dẫn: ${cfg.targetPath}`)
          if (filteredArgv.some(a => a.startsWith('--password'))) {
            console.log(`🔑 Đã bỏ qua mật khẩu: mật khẩu không còn được lưu. Khi push/pull hãy dùng ${PASSWORD_HINT}.`)
          }
          return 0
        }
        if (sub === 'push') {
          const password = readPasswordArg(filteredArgv)
          const target = positionalArgs(filteredArgv, 2)[0]
          const res = syncPush(home, target, password)
          console.log(`☁️ Đã đẩy bản sao lưu mã hóa (${res.count} profiles) lên: ${res.path}`)
          return 0
        }
        if (sub === 'pull') {
          const password = readPasswordArg(filteredArgv)
          const force = filteredArgv.includes('--force')
          const target = positionalArgs(filteredArgv, 2)[0]
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
      case 'web':
      case 'dashboard': {
        const sub = filteredArgv[1]
        const { startWebDashboard, stopWebDashboard, runningDashboard, openBrowser, dashboardUrl } = await import('./web.js')
        if (sub === 'stop') {
          const stopped = stopWebDashboard(home)
          console.log(stopped
            ? (lang === 'en' ? '🛑 Stopped Web Dashboard.' : '🛑 Đã dừng Web Dashboard.')
            : (lang === 'en' ? 'ℹ️ Web Dashboard is not running.' : 'ℹ️ Web Dashboard không chạy.'))
          return 0
        }
        const portArg = filteredArgv.indexOf('--port')
        const port = portArg !== -1 ? Number(filteredArgv[portArg + 1]) : 3737
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new SwapError(lang === 'en' ? 'Invalid port. Example: --port 3737' : 'Port không hợp lệ. Ví dụ: --port 3737')
        }
        const isDaemon = filteredArgv.includes('--daemon')
        const noOpen = filteredArgv.includes('--no-open')
        const announce = state =>
          console.log(lang === 'en'
            ? `🌐 Web Dashboard running in background at: ${dashboardUrl(state)}`
            : `🌐 Web Dashboard đang chạy ngầm tại: ${dashboardUrl(state)}`)

        const running = runningDashboard(home)
        if (running && !filteredArgv.includes('--server')) {
          announce({ port, ...running })
          if (!noOpen) openBrowser(dashboardUrl({ port, ...running }))
          return 0
        }

        if (isDaemon) {
          const child = spawnDetached(process.execPath, [
            SCRIPT_PATH, 'web', '--server', '--port', String(port), ...(noOpen ? ['--no-open'] : []),
          ])
          // the server moves to the next port when this one is taken: wait briefly for its real port
          let state = null
          for (let i = 0; i < 30 && !(state?.pid === child?.pid); i++) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
            state = runningDashboard(home)
          }
          announce({ port, ...state })
          return 0
        }

        // the background child opens the browser itself once it knows its port
        const serverInst = await startWebDashboard(home, { port, open: !noOpen })
        console.log(lang === 'en'
          ? `🌐 Web Dashboard active at: ${dashboardUrl(serverInst)}\n(Press Ctrl+C to stop)`
          : `🌐 Web Dashboard đang hoạt động tại: ${dashboardUrl(serverInst)}\n(Nhấn Ctrl+C để dừng)`)
        return new Promise(() => {})
      }
      case 'balance': {
        const sub = filteredArgv[1]
        if (!sub || sub === 'status') {
          const cfg = loadBalanceConfig(home)
          console.log(lang === 'en' ? '⚖️ Smart Load Balancing Status:' : '⚖️ Trạng thái Cân Bằng Tải Quota:')
          console.log(`  • ${lang === 'en' ? 'Enabled' : 'Trạng thái'}: ${cfg.enabled ? '✅ on' : '❌ off'}`)
          console.log(`  • ${lang === 'en' ? 'Mode' : 'Thuật toán'}: ${cfg.mode}`)
          console.log(`  • ${lang === 'en' ? 'Pool' : 'Nhóm (pool)'}: ${cfg.pool}`)
          return 0
        }
        if (sub === 'on' || sub === 'off') {
          saveBalanceConfig(home, { enabled: sub === 'on' })
          console.log(sub === 'on'
            ? (lang === 'en' ? '✅ Smart Load Balancing enabled: auto-switch now picks the next profile by the balance mode.' : '✅ Đã bật Cân Bằng Tải Quota: auto-switch sẽ chọn profile kế tiếp theo thuật toán cân bằng.')
            : (lang === 'en' ? '❌ Smart Load Balancing disabled.' : '❌ Đã tắt Cân Bằng Tải Quota.'))
          return 0
        }
        if (sub === 'mode') {
          const mode = filteredArgv[2]
          if (!mode || !['least-used', 'round-robin'].includes(mode)) {
            throw new SwapError(lang === 'en' ? 'Usage: /profile balance mode <least-used|round-robin>' : 'Cú pháp: /profile balance mode <least-used|round-robin>')
          }
          saveBalanceConfig(home, { mode, enabled: true })
          console.log(lang === 'en' ? `⚖️ Load balancing mode set to: ${mode}` : `⚖️ Đã đổi thuật toán cân bằng tải sang: ${mode}`)
          return 0
        }
        if (sub === 'pool') {
          const pool = filteredArgv[2] || 'all'
          saveBalanceConfig(home, { pool })
          console.log(lang === 'en' ? `⚖️ Balance pool set to: ${pool}` : `⚖️ Đã đặt nhóm áp dụng cân bằng tải: ${pool}`)
          return 0
        }
        if (sub === 'next') {
          const next = balanceSwap(home)
          console.log(lang === 'en' ? `⚖️ Swapped to balanced profile: ${next}` : `⚖️ Đã chuyển sang profile cân bằng: ${next}`)
          return 0
        }
        throw new SwapError(lang === 'en' ? 'Usage: /profile balance [on|off|mode <m>|pool <p>|next]' : 'Cú pháp: /profile balance [on|off|mode <m>|pool <p>|next]')
      }
      case 'webhook': {
        const sub = filteredArgv[1]
        if (!sub || sub === 'status') {
          const cfg = loadWebhookConfig(home)
          console.log(lang === 'en' ? '🔔 Webhook Notifications Status:' : '🔔 Trạng thái Webhook Cảnh Báo:')
          const show = u => (u ? maskUrl(u) : lang === 'en' ? '(not set)' : '(chưa đặt)')
          console.log(`  • Telegram: ${show(cfg.telegram)}`)
          console.log(`  • Discord:  ${show(cfg.discord)}`)
          console.log(`  • Slack:    ${show(cfg.slack)}`)
          console.log(`  • Generic:  ${show(cfg.generic)}`)
          return 0
        }
        if (sub === 'set') {
          const type = filteredArgv[2]
          const url = filteredArgv[3]
          if (!type || !url || !['telegram', 'discord', 'slack', 'generic'].includes(type.toLowerCase())) {
            throw new SwapError(lang === 'en' ? 'Usage: /profile webhook set <telegram|discord|slack|generic> <url>' : 'Cú pháp: /profile webhook set <telegram|discord|slack|generic> <url>')
          }
          const cfg = loadWebhookConfig(home)
          cfg[type.toLowerCase()] = url
          saveWebhookConfig(home, cfg)
          console.log(lang === 'en' ? `🔔 Webhook '${type}' configured.` : `🔔 Đã lưu webhook '${type}'.`)
          return 0
        }
        if (sub === 'unset') {
          const type = filteredArgv[2]
          if (!type) throw new SwapError(lang === 'en' ? 'Usage: /profile webhook unset <type>' : 'Cú pháp: /profile webhook unset <type>')
          saveWebhookConfig(home, { [type.toLowerCase()]: null })
          console.log(lang === 'en' ? `🔔 Webhook '${type}' removed.` : `🔔 Đã gỡ webhook '${type}'.`)
          return 0
        }
        if (sub === 'test') {
          const type = filteredArgv[2] || null
          console.log(lang === 'en' ? '🔔 Sending test notification...' : '🔔 Đang gửi thông báo thử nghiệm...')
          const targets = await testWebhook(home, type)
          console.log(lang === 'en' ? `✅ Test notification sent to: ${targets.join(', ')}` : `✅ Đã gửi thông báo thử nghiệm tới: ${targets.join(', ')}`)
          return 0
        }
        throw new SwapError(lang === 'en' ? 'Usage: /profile webhook [set|unset|test|status]' : 'Cú pháp: /profile webhook [set|unset|test|status]')
      }
      case 'budget':
      case 'cost': {
        const sub = filteredArgv[1]
        if (!sub || sub === 'status') {
          console.log(formatBudgetReport(home, lang))
          return 0
        }
        if (sub === 'set') {
          const profile = filteredArgv[2]
          const amount = filteredArgv[3]
          if (!profile || !amount) {
            throw new SwapError(lang === 'en' ? 'Usage: /profile budget set <profile> <amount>' : 'Cú pháp: /profile budget set <tên> <hạn_mức>')
          }
          const res = setBudgetLimit(home, profile, amount)
          console.log(lang === 'en'
            ? `💰 Set budget limit for '${res.profile}': ${res.limit.toFixed(2)} ${res.currency}/mo`
            : `💰 Đã đặt hạn mức cho '${res.profile}': ${res.limit.toFixed(2)} ${res.currency}/tháng`)
          return 0
        }
        if (sub === 'unset') {
          const profile = filteredArgv[2]
          if (!profile) throw new SwapError(lang === 'en' ? 'Usage: /profile budget unset <profile>' : 'Cú pháp: /profile budget unset <tên>')
          const res = removeBudgetLimit(home, profile)
          console.log(lang === 'en' ? `💰 Removed budget limit for '${res}'.` : `💰 Đã xóa hạn mức ngân sách cho '${res}'.`)
          return 0
        }
        throw new SwapError(lang === 'en' ? 'Usage: /profile budget [set|unset|status]' : 'Cú pháp: /profile budget [set|unset|status]')
      }
      case 'mask': {
        const sub = filteredArgv[1]
        if (!sub || sub === 'status') {
          const cur = isMaskingEnabled(home)
          console.log(lang === 'en'
            ? `🛡️ Profile masking is currently: ${cur ? '✅ ON' : '❌ OFF'}`
            : `🛡️ Chế độ che mờ bảo mật hiện tại: ${cur ? '✅ BẬT' : '❌ TẮT'}`)
          return 0
        }
        if (sub === 'on' || sub === 'off') {
          const enabled = setMasking(home, sub === 'on')
          console.log(enabled
            ? (lang === 'en' ? '🛡️ Profile masking enabled.' : '🛡️ Đã bật che mờ email.')
            : (lang === 'en' ? '🛡️ Profile masking disabled.' : '🛡️ Đã tắt che mờ email.'))
          return 0
        }
        throw new SwapError(lang === 'en' ? 'Usage: /profile mask [on|off|status]' : 'Cú pháp: /profile mask [on|off|status]')
      }
      case 'share': {
        const file = filteredArgv[1] || null
        const res = exportSafeShare(home, file)
        if (res.path) {
          console.log(lang === 'en'
            ? `🛡️ Safe configuration bundle exported to: ${res.path}`
            : `🛡️ Đã xuất bản cấu hình an toàn (không token) ra: ${res.path}`)
        } else {
          console.log(res.json)
        }
        return 0
      }
      case 'completion': {
        const shell = filteredArgv[1] || 'bash'
        console.log(generateCompletion(shell))
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
// no top-level await: web.js imports this module, and a pending top-level await here would
// deadlock `await import('./web.js')` (the module graph never finishes evaluating)
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runCli(process.argv.slice(2)).then(async code => {
    await flushWebhooks()
    process.exit(code)
  })
}
