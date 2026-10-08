import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  saveProfile,
  swapProfile,
  deleteProfile,
  listProfiles,
  currentProfile,
  setCurrent,
  profileEmail,
  importProfiles,
  parseLimits,
  profileUsage,
  usageRows,
  profileListReport,
  runCli,
  SwapError,
  ProfileExists,
  loadSwapHistory,
  formatCooldowns,
  autoCheckAndSwap,
  diagnoseProfiles,
  getStatusline,
  generatePromptSnippet,
  parseDuration,
  tempSwap,
  checkTempExpiry,
  cancelTempSwap,
  loadTempProfile,
  formatHelpReport,
  addProfileTag,
  setAlias,
  loadAliases,
  removeAlias,
  resolveProfileOrAlias,
  bindBranch,
  unbindBranch,
  getBoundBranchProfile,
  matchBranchPattern,
  recordUsageSnapshot,
  calculateForecast,
  formatForecastReport,
  interactivePickProfile,
  syncPush,
  syncPull,
  saveSyncConfig,
  loadSyncConfig,
  setModelAffinity,
  loadModelAffinity,
  removeModelAffinity,
  analyzeProfilesForCleanup,
  formatCleanupReport,
  cleanupProfiles,
  loadLanguage,
  setLanguage,
  languageFile,
  disableProfile,
  enableProfile,
  isProfileDisabled,
  loadDisabledProfiles,
  addTokenProfile,
  prepareSession,
  syncSessionBack,
  sessionDir,
  profilePath,
  upgradePlugin,
  loadBalanceConfig,
  saveBalanceConfig,
  getNextBalancedProfile,
  balanceSwap,
  loadWebhookConfig,
  saveWebhookConfig,
  testWebhook,
  loadBudgetConfig,
  saveBudgetConfig,
  setBudgetLimit,
  removeBudgetLimit,
  formatBudgetReport,
  isMaskingEnabled,
  setMasking,
  maskEmail,
  maskToken,
  exportSafeShare,
  generateCompletion,
} from '../swap.js'
import { startWebDashboard, getDashboardData, stopWebDashboard } from '../web.js'

function login(home, account, token, extra = {}) {
  const data = {
    oauthAccount: { emailAddress: `${account}@example.com`, accountUuid: `uuid-${account}` },
    projects: { '/p': { history: [1, 2] } },
    numStartups: 7,
    ...extra,
  }
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(data, null, 2))
  const credDir = path.join(home, '.claude')
  fs.mkdirSync(credDir, { recursive: true })
  fs.writeFileSync(
    path.join(credDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token } }, null, 2)
  )
}

// `auto check` refetches entries older than USAGE_TTL, so fixtures must look freshly fetched
function writeFreshCache(file, data) {
  const at = Date.now() / 1000
  const fresh = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { at, ...v }]))
  fs.writeFileSync(file, JSON.stringify(fresh))
}

function readClaudeJson(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'))
}

function readToken(home) {
  return JSON.parse(
    fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf-8')
  ).claudeAiOauth.accessToken
}

describe('swap.js core functionality', () => {
  let tmpHome

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-swap-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {}
  })

  test('missing claude.json throws SwapError', () => {
    assert.throws(() => saveProfile(tmpHome, 'a'), /login/)
  })

  test('save stores auth only and marks active', () => {
    login(tmpHome, 'a', 'tok-a')
    const savedPath = saveProfile(tmpHome, 'work')
    const saved = JSON.parse(fs.readFileSync(savedPath, 'utf-8'))
    assert.deepEqual(saved.claude_json, {
      oauthAccount: { emailAddress: 'a@example.com', accountUuid: 'uuid-a' },
    })
    assert.equal(JSON.parse(saved.credentials).claudeAiOauth.accessToken, 'tok-a')
    assert.equal(currentProfile(tmpHome), 'work')
  })

  test('save existing profile requires force', () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'work')
    assert.throws(() => saveProfile(tmpHome, 'work'), ProfileExists)

    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'work', true)
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.config', 'claude-cli-profiles', 'work.json'), 'utf-8')
    )
    assert.equal(JSON.parse(saved.credentials).claudeAiOauth.accessToken, 'tok-b')
  })

  test('swap switches auth, keeps session state, and creates backups', () => {
    login(tmpHome, 'a', 'tok-a', { primaryApiKey: 'sk-a' })
    saveProfile(tmpHome, 'A')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'B')

    // Simulate session writing state
    const d = readClaudeJson(tmpHome)
    d.numStartups = 99
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify(d, null, 2))

    // Swap back to A
    swapProfile(tmpHome, 'A')
    const swapped = readClaudeJson(tmpHome)
    assert.equal(swapped.oauthAccount.emailAddress, 'a@example.com')
    assert.equal(swapped.primaryApiKey, 'sk-a')
    assert.equal(swapped.numStartups, 99)
    assert.deepEqual(swapped.projects, { '/p': { history: [1, 2] } })
    assert.equal(readToken(tmpHome), 'tok-a')
    assert.equal(currentProfile(tmpHome), 'A')
    assert.ok(fs.existsSync(path.join(tmpHome, '.claude.json.bak')))

    // Swap to B (which had no primaryApiKey) -> primaryApiKey must be removed
    swapProfile(tmpHome, 'B')
    const swappedB = readClaudeJson(tmpHome)
    assert.equal(swappedB.primaryApiKey, undefined)
    assert.equal(readToken(tmpHome), 'tok-b')
  })

  test('swap auto-resaves refreshed token of active profile if same account', () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'A')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'B')
    swapProfile(tmpHome, 'A')

    // Claude refreshed A's token
    login(tmpHome, 'a', 'tok-a-refreshed')
    swapProfile(tmpHome, 'B')
    swapProfile(tmpHome, 'A')
    assert.equal(readToken(tmpHome), 'tok-a-refreshed')

    // Manual login to different account while A is active: should not overwrite A
    login(tmpHome, 'c', 'tok-c')
    swapProfile(tmpHome, 'B')
    const savedA = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.config', 'claude-cli-profiles', 'A.json'), 'utf-8')
    )
    assert.equal(JSON.parse(savedA.credentials).claudeAiOauth.accessToken, 'tok-a-refreshed')
  })

  test('delete removes profile and clears current if active', () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'A')
    saveProfile(tmpHome, 'B', true)
    deleteProfile(tmpHome, 'A')
    assert.equal(currentProfile(tmpHome), 'B')
    deleteProfile(tmpHome, 'B')
    assert.deepEqual(listProfiles(tmpHome), [])
    assert.equal(currentProfile(tmpHome), null)
  })

  test('rejects invalid profile names', () => {
    login(tmpHome, 'a', 'tok-a')
    for (const bad of ['', '../x', 'a/b', '.hidden', 'x'.repeat(65), 'có dấu']) {
      assert.throws(() => saveProfile(tmpHome, bad), /không hợp lệ/)
    }
  })

  test('import profiles from directory and other claude config', () => {
    const importSource = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-'))
    try {
      // Create a valid profile file
      fs.writeFileSync(
        path.join(importSource, 'imported-one.json'),
        JSON.stringify({
          claude_json: { oauthAccount: { emailAddress: 'imp1@example.com' } },
          credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'tok-imp1' } }),
        })
      )
      // Create an invalid file
      fs.writeFileSync(path.join(importSource, 'junk.json'), 'not-json')

      login(tmpHome, 'a', 'tok-a')
      saveProfile(tmpHome, 'existing')

      const res = importProfiles(tmpHome, importSource)
      assert.deepEqual(res.added, ['imported-one'])
      assert.deepEqual(res.invalid, ['junk.json'])
      assert.ok(listProfiles(tmpHome).includes('imported-one'))
    } finally {
      fs.rmSync(importSource, { recursive: true, force: true })
    }
  })

  test('parseLimits extracts 5h, 7d and model quotas', () => {
    const raw = {
      five_hour: { utilization: 0.42, resets_at: '2026-10-08T20:00:00Z' },
      seven_day: { utilization: 0.85, resets_at: '2026-10-15T00:00:00Z' },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 0.15,
          resets_at: '2026-10-15T00:00:00Z',
          scope: { model: { display_name: 'Opus' } },
        },
      ],
    }
    const parsed = parseLimits(raw)
    assert.equal(parsed.length, 3)
    assert.equal(parsed[0][0], '5 giờ')
    assert.equal(parsed[0][1], 0.42)
    assert.equal(parsed[1][0], '7 ngày')
    assert.equal(parsed[1][1], 0.85)
    assert.equal(parsed[2][0], '7 ngày Opus')
    assert.equal(parsed[2][1], 0.15)
  })

  test('profileListReport formats active and inactive indicators and tag badges', () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'work')
    addProfileTag(tmpHome, 'work', 'office')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'personal')

    const out = profileListReport(tmpHome, false)
    assert.ok(out.includes('⚪ work'))
    assert.ok(out.includes('🟢 personal (Active)'))
    assert.ok(out.includes('👤 b@example.com'))
    assert.ok(out.includes('🏷️ office'))
  })

  test('CLI runs commands successfully', async () => {
    login(tmpHome, 'a', 'tok-a')
    assert.equal(await runCli(['save', 'work'], tmpHome), 0)
    assert.equal(await runCli(['save', 'work'], tmpHome), 1) // already exists
    assert.equal(await runCli(['new', 'personal'], tmpHome), 0)
    assert.equal(await runCli(['current'], tmpHome), 0)
    assert.equal(await runCli(['list', '--no-color'], tmpHome), 0)
    assert.equal(await runCli(['swap', 'work'], tmpHome), 0)
    assert.equal(currentProfile(tmpHome), 'work')
    assert.equal(await runCli(['delete', 'personal'], tmpHome), 0)
  })

  test('auto-switch config load, save and CLI commands', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'p1')

    // Default config
    assert.equal(await runCli(['auto'], tmpHome), 0)

    // Set threshold
    assert.equal(await runCli(['auto', 'threshold', '85'], tmpHome), 0)
    assert.equal(await runCli(['auto', 'threshold', 'invalid'], tmpHome), 1)

    // Set order
    assert.equal(await runCli(['auto', 'order', 'p1,p2,p3'], tmpHome), 0)

    // Reset order
    assert.equal(await runCli(['auto', 'order', 'default'], tmpHome), 0)

    // Toggle on/off
    assert.equal(await runCli(['auto', 'off'], tmpHome), 0)
    assert.equal(await runCli(['auto', 'on'], tmpHome), 0)
  })

  test('auto-switch selects profile by custom order', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'current')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'candidate1')
    login(tmpHome, 'c', 'tok-c')
    saveProfile(tmpHome, 'candidate2')
    swapProfile(tmpHome, 'current')

    const mockUsageData = {
      'current|a@example.com': { limits: [['5 giờ', 96, '20:00']], resets_at_epoch: 1000 },
      'candidate1|b@example.com': { limits: [['5 giờ', 60, '20:00']], resets_at_epoch: 2000 },
      'candidate2|c@example.com': { limits: [['5 giờ', 30, '20:00']], resets_at_epoch: 3000 },
    }
    // Save cache
    const cacheFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json')
    writeFreshCache(cacheFile, mockUsageData)

    // Set order: candidate1 first, even though candidate2 has lower usage
    const configFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.auto-switch.json')
    fs.writeFileSync(configFile, JSON.stringify({ enabled: true, threshold: 90, order: ['candidate1', 'candidate2'] }))

    const res = await runCli(['auto', 'check'], tmpHome)
    assert.equal(res, 0)
    assert.equal(currentProfile(tmpHome), 'candidate1')
  })

  test('auto-switch selects profile by rule: lower utilization, then earlier reset', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'current')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'acc_high_util')
    login(tmpHome, 'c', 'tok-c')
    saveProfile(tmpHome, 'acc_same_util_reset_later')
    login(tmpHome, 'd', 'tok-d')
    saveProfile(tmpHome, 'acc_same_util_reset_earlier')
    swapProfile(tmpHome, 'current')

    const mockUsageData = {
      'current|a@example.com': { limits: [['5 giờ', 98, '20:00']], resets_at: '2026-10-08T20:00:00Z' },
      'acc_high_util|b@example.com': { limits: [['5 giờ', 70, '20:00']], resets_at: '2026-10-08T19:30:00Z' },
      'acc_same_util_reset_later|c@example.com': { limits: [['5 giờ', 40, '22:00']], resets_at: '2026-10-08T22:00:00Z' },
      'acc_same_util_reset_earlier|d@example.com': { limits: [['5 giờ', 40, '20:00']], resets_at: '2026-10-08T20:00:00Z' },
    }
    const cacheFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json')
    writeFreshCache(cacheFile, mockUsageData)

    // No custom order -> rule-based
    const configFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.auto-switch.json')
    fs.writeFileSync(configFile, JSON.stringify({ enabled: true, threshold: 90, order: [] }))

    const res = await runCli(['auto', 'check'], tmpHome)
    assert.equal(res, 0)
    // acc_same_util_reset_earlier has 40% and earlier reset than acc_same_util_reset_later
    assert.equal(currentProfile(tmpHome), 'acc_same_util_reset_earlier')
  })

  test('project profile binding: bind, unbind, getBoundProfile and CLI', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'work')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'personal')

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proj-'))
    const subDir = path.join(projectDir, 'src', 'deep')
    fs.mkdirSync(subDir, { recursive: true })

    try {
      // Bind projectDir to 'work'
      assert.equal(await runCli(['bind', 'work', projectDir], tmpHome), 0)

      // Subdirectory detects parent project binding
      assert.equal(await runCli(['bind', 'get', subDir], tmpHome), 0)

      // Unbind
      assert.equal(await runCli(['unbind', projectDir], tmpHome), 0)
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('notification config toggle and CLI', async () => {
    assert.equal(await runCli(['notify'], tmpHome), 0)
    assert.equal(await runCli(['notify', 'off'], tmpHome), 0)
    assert.equal(await runCli(['notify', 'on'], tmpHome), 0)
  })

  test('profile tagging, untagging and pool filtering in auto-switch', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'p_work')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'p_personal')
    login(tmpHome, 'c', 'tok-c')
    saveProfile(tmpHome, 'p_other_work')

    // Tag profiles
    assert.equal(await runCli(['tag', 'p_work', 'company'], tmpHome), 0)
    assert.equal(await runCli(['tag', 'p_other_work', 'company'], tmpHome), 0)
    assert.equal(await runCli(['tags'], tmpHome), 0)

    // Set auto pool to 'company'
    assert.equal(await runCli(['auto', 'pool', 'company'], tmpHome), 0)

    swapProfile(tmpHome, 'p_work')

    // p_personal has 20% usage, p_other_work has 50% usage
    const mockUsageData = {
      'p_work|a@example.com': { limits: [['5 giờ', 99, '20:00']] },
      'p_personal|b@example.com': { limits: [['5 giờ', 20, '20:00']] },
      'p_other_work|c@example.com': { limits: [['5 giờ', 50, '20:00']] },
    }
    const cacheFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json')
    writeFreshCache(cacheFile, mockUsageData)

    // Check: should pick p_other_work because of pool=company, even though p_personal has lower usage
    const res = await runCli(['auto', 'check'], tmpHome)
    assert.equal(res, 0)
    assert.equal(currentProfile(tmpHome), 'p_other_work')

    // Untag
    assert.equal(await runCli(['untag', 'p_other_work', 'company'], tmpHome), 0)
    assert.equal(await runCli(['auto', 'pool', 'all'], tmpHome), 0)
  })

  test('encrypted export and import with AES-256-GCM', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'work')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'personal')

    const exportFile = path.join(os.tmpdir(), `backup-${Date.now()}.enc`)
    const newHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-new-home-'))

    try {
      // Export with password
      assert.equal(await runCli(['export', exportFile, '--password', 'secret123'], tmpHome), 0)
      assert.ok(fs.existsSync(exportFile))

      // Import with wrong password should fail
      assert.equal(await runCli(['import-enc', exportFile, '--password', 'wrong_pass'], newHome), 1)

      // Import with correct password into newHome
      assert.equal(await runCli(['import-enc', exportFile, '--password', 'secret123'], newHome), 0)
      assert.deepEqual(listProfiles(newHome), ['personal', 'work'])
    } finally {
      try { fs.unlinkSync(exportFile) } catch {}
      try { fs.rmSync(newHome, { recursive: true, force: true }) } catch {}
    }
  })

  test('swap history and analytics tracking', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'work')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'personal')

    // Perform manual swap
    assert.equal(await runCli(['swap', 'work'], tmpHome), 0)

    const history = loadSwapHistory(tmpHome)
    assert.equal(history.length, 1)
    assert.equal(history[0].from, 'personal')
    assert.equal(history[0].to, 'work')
    assert.equal(history[0].type, 'manual')

    // History and stats commands should succeed
    assert.equal(await runCli(['history'], tmpHome), 0)
    assert.equal(await runCli(['stats'], tmpHome), 0)
  })

  test('cooldown watcher and auto-return to primary profile', async () => {
    login(tmpHome, 'p1', 'tok-1')
    saveProfile(tmpHome, 'primary')
    login(tmpHome, 'p2', 'tok-2')
    saveProfile(tmpHome, 'secondary')

    const cache = {
      'primary|p1@example.com': {
        limits: [['5 giờ', 20, '20:00']],
        resets_at_epoch: Date.now() + 1800000, // 30 mins later
      },
      'secondary|p2@example.com': {
        limits: [['5 giờ', 95, '22:00']],
        resets_at_epoch: Date.now() + 7200000,
      },
    }

    const report = formatCooldowns(tmpHome, cache)
    assert.match(report, /primary/)
    assert.match(report, /secondary/)

    // Test CLI cooldown command
    assert.equal(await runCli(['cooldown'], tmpHome), 0)

    // Setup auto-return config
    assert.equal(await runCli(['auto', 'primary', 'primary'], tmpHome), 0)
    assert.equal(await runCli(['auto', 'return', 'on'], tmpHome), 0)

    // Current is secondary, but primary has recovered (util 20% < 90%)
    const res = await autoCheckAndSwap(tmpHome, {
      cache,
      config: { enabled: true, threshold: 90, autoReturn: true, primaryProfile: 'primary' },
    })
    assert.equal(res.swapped, true)
    assert.equal(res.to, 'primary')
  })

  test('profile doctor diagnostics and health check', async () => {
    login(tmpHome, 'good', 'tok-good')
    saveProfile(tmpHome, 'good_profile')

    // Create a corrupt profile file
    fs.writeFileSync(path.join(tmpHome, '.config', 'claude-cli-profiles', 'corrupt_profile.json'), '{ invalid json')

    const diag = diagnoseProfiles(tmpHome)
    assert.equal(diag.profiles.length, 2)

    const goodReport = diag.profiles.find(p => p.name === 'good_profile')
    assert.equal(goodReport.status, 'ok')

    const corruptReport = diag.profiles.find(p => p.name === 'corrupt_profile')
    assert.equal(corruptReport.status, 'error')

    // CLI doctor command should run cleanly
    assert.equal(await runCli(['doctor'], tmpHome), 0)
  })

  test('7-day exhaustion safeguard prevents auto-switching to near-limit profile', async () => {
    login(tmpHome, 'cur', 'tok-cur')
    saveProfile(tmpHome, 'cur_profile')
    login(tmpHome, 'cand_high_7d', 'tok-cand1')
    saveProfile(tmpHome, 'cand_high_7d')
    login(tmpHome, 'cand_safe', 'tok-cand2')
    saveProfile(tmpHome, 'cand_safe')

    const cache = {
      'cur_profile|cur@example.com': {
        limits: [['5 giờ', 98, '20:00']],
      },
      'cand_high_7d|cand_high_7d@example.com': {
        limits: [
          ['5 giờ', 10, '20:00'],
          ['7 ngày', 90, 'Thứ 6'],
        ],
      },
      'cand_safe|cand_safe@example.com': {
        limits: [
          ['5 giờ', 30, '20:00'],
          ['7 ngày', 40, 'Thứ 6'],
        ],
      },
    }

    // CLI safeguard commands
    assert.equal(await runCli(['auto', 'safeguard', '85'], tmpHome), 0)
    assert.equal(await runCli(['auto', 'safeguard'], tmpHome), 0)

    setCurrent(tmpHome, 'cur_profile')

    const res = await autoCheckAndSwap(tmpHome, {
      cache,
      config: { enabled: true, threshold: 90, safeguardThreshold: 85 },
    })
    assert.equal(res.swapped, true)
    assert.equal(res.to, 'cand_safe')
  })

  test('statusline and prompt integrator', async () => {
    login(tmpHome, 'dev', 'tok-dev')
    saveProfile(tmpHome, 'dev')

    const line = getStatusline(tmpHome)
    assert.match(line, /dev/)

    const starship = generatePromptSnippet('starship')
    assert.match(starship, /custom\.claude_profile/)

    const zsh = generatePromptSnippet('zsh')
    assert.match(zsh, /PROMPT/)

    assert.equal(await runCli(['statusline'], tmpHome), 0)
    assert.equal(await runCli(['prompt', 'starship'], tmpHome), 0)
  })

  test('ephemeral and temporary profile swap with expiry', async () => {
    assert.equal(parseDuration('30m'), 30 * 60 * 1000)
    assert.equal(parseDuration('2h'), 2 * 3600 * 1000)
    assert.equal(parseDuration('45s'), 45 * 1000)
    assert.throws(() => parseDuration('invalid'), /Thời gian không hợp lệ/)

    login(tmpHome, 'p_orig', 'tok-orig')
    saveProfile(tmpHome, 'orig')
    login(tmpHome, 'p_temp', 'tok-temp')
    saveProfile(tmpHome, 'temp')

    // Current is temp, swap back to orig first
    swapProfile(tmpHome, 'orig')
    assert.equal(currentProfile(tmpHome), 'orig')

    // Temporary swap to 'temp' for 1 hour
    assert.equal(await runCli(['temp', 'temp', '1h'], tmpHome), 0)
    assert.equal(currentProfile(tmpHome), 'temp')

    const tempState = loadTempProfile(tmpHome)
    assert.equal(tempState.tempProfile, 'temp')
    assert.equal(tempState.originalProfile, 'orig')

    // Untemp CLI command to revert
    assert.equal(await runCli(['untemp'], tmpHome), 0)
    assert.equal(currentProfile(tmpHome), 'orig')
    assert.equal(loadTempProfile(tmpHome), null)

    // Test expiry automatic reversion
    tempSwap(tmpHome, 'temp', '10ms')
    assert.equal(currentProfile(tmpHome), 'temp')

    // Wait 20ms to expire
    await new Promise(r => setTimeout(r, 20))

    const expRes = checkTempExpiry(tmpHome)
    assert.equal(expRes.expired, true)
    assert.equal(expRes.revertedTo, 'orig')
    assert.equal(currentProfile(tmpHome), 'orig')
  })

  test('help command and empty args display full command usage guide', async () => {
    const help = formatHelpReport()
    assert.match(help, /Hướng dẫn sử dụng các lệnh/)
    assert.match(help, /\/profile list/)
    assert.match(help, /\/profile auto/)

    assert.equal(await runCli([], tmpHome), 0)
    assert.equal(await runCli(['help'], tmpHome), 0)
  })

  test('profile aliases: set, resolve, swap and CLI', async () => {
    login(tmpHome, 'w', 'tok-w')
    saveProfile(tmpHome, 'work-full-name')

    setAlias(tmpHome, 'w', 'work-full-name')
    const aliases = loadAliases(tmpHome)
    assert.equal(aliases.w, 'work-full-name')
    assert.equal(resolveProfileOrAlias(tmpHome, 'w'), 'work-full-name')
    assert.equal(resolveProfileOrAlias(tmpHome, 'nonexistent'), 'nonexistent')

    // Swap using alias
    login(tmpHome, 'other', 'tok-other')
    saveProfile(tmpHome, 'other')
    swapProfile(tmpHome, 'w')
    assert.equal(currentProfile(tmpHome), 'work-full-name')

    // CLI commands
    assert.equal(await runCli(['alias', 'wf', 'work-full-name'], tmpHome), 0)
    assert.equal(await runCli(['aliases'], tmpHome), 0)
    assert.equal(await runCli(['unalias', 'wf'], tmpHome), 0)
  })

  test('git branch binding: pattern matching and CLI', async () => {
    login(tmpHome, 'w', 'tok-w')
    saveProfile(tmpHome, 'work')
    login(tmpHome, 'p', 'tok-p')
    saveProfile(tmpHome, 'personal')

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-branch-'))
    assert.equal(matchBranchPattern('feat/*', 'feat/login'), true)
    assert.equal(matchBranchPattern('feat/*', 'main'), false)
    assert.equal(matchBranchPattern('work-*', 'work-123'), true)

    bindBranch(tmpHome, projectDir, 'feat/*', 'work')
    bindBranch(tmpHome, projectDir, 'main', 'personal')

    const boundFeat = getBoundBranchProfile(tmpHome, projectDir, 'feat/login')
    assert.equal(boundFeat.profile, 'work')
    const boundMain = getBoundBranchProfile(tmpHome, projectDir, 'main')
    assert.equal(boundMain.profile, 'personal')

    // CLI
    assert.equal(await runCli(['bind-branch', 'exp/*', 'work', projectDir], tmpHome), 0)
    assert.equal(await runCli(['branch-bindings'], tmpHome), 0)
    assert.equal(await runCli(['unbind-branch', 'exp/*', projectDir], tmpHome), 0)
  })

  test('quota burn-rate and exhaustion forecast', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'worker')

    // Empty forecast
    const emptyF = calculateForecast(tmpHome, 'worker')
    assert.equal(emptyF.hasData, false)

    // Record two snapshots 1 hour apart with 10% increase
    recordUsageSnapshot(tmpHome, 'worker', 50)
    const histFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-history.json')
    const data = JSON.parse(fs.readFileSync(histFile, 'utf-8'))
    data.worker[0].timestamp = Date.now() - 3600000
    data.worker.push({ timestamp: Date.now(), util5h: 60, util7d: null })
    fs.writeFileSync(histFile, JSON.stringify(data))

    const f = calculateForecast(tmpHome, 'worker', 90)
    assert.equal(f.hasData, true)
    assert.equal(f.currentUtil, 60)
    assert.equal(f.trend, 'increasing')
    assert.equal(f.burnRatePerHour, 10)
    assert.equal(f.minutesUntilThreshold, 180)

    const report = formatForecastReport(tmpHome)
    assert.match(report, /worker/)
    assert.equal(await runCli(['forecast'], tmpHome), 0)
  })

  test('interactive picker fallback in non-interactive mode', async () => {
    login(tmpHome, 'p1', 'tok-1')
    saveProfile(tmpHome, 'p1')
    login(tmpHome, 'p2', 'tok-2')
    saveProfile(tmpHome, 'p2')

    const res = await interactivePickProfile(tmpHome, { nonInteractive: true })
    assert.ok(res.selected === 'p1' || res.selected === 'p2')
    assert.equal(await runCli(['pick'], tmpHome), 0)
  })

  test('encrypted remote sync: setup, push and pull', async () => {
    login(tmpHome, 'sync1', 'tok-s1')
    saveProfile(tmpHome, 'sync_profile')

    const syncFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-')), 'sync.enc')
    const pushRes = syncPush(tmpHome, syncFile, 'mypassword')
    assert.equal(pushRes.count, 1)
    assert.ok(fs.existsSync(syncFile))

    // Pull into new home
    const newHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-synchome-'))
    const pullRes = syncPull(newHome, syncFile, 'mypassword')
    assert.ok(pullRes.added.includes('sync_profile'))

    // CLI sync commands
    assert.equal(await runCli(['sync', 'setup', syncFile, '--password', 'mypassword'], tmpHome), 0)
    assert.equal(await runCli(['sync', 'status'], tmpHome), 0)
    assert.equal(await runCli(['sync', 'push', '--password', 'mypassword'], tmpHome), 0)
  })

  test('model affinity: assign, list, apply and CLI', async () => {
    login(tmpHome, 'op', 'tok-op')
    saveProfile(tmpHome, 'opus_heavy')
    login(tmpHome, 'so', 'tok-so')
    saveProfile(tmpHome, 'sonnet_fast')

    setModelAffinity(tmpHome, 'opus', 'opus_heavy')
    setModelAffinity(tmpHome, 'sonnet', 'sonnet_fast')

    const map = loadModelAffinity(tmpHome)
    assert.equal(map.opus, 'opus_heavy')
    assert.equal(map.sonnet, 'sonnet_fast')

    // CLI commands
    assert.equal(await runCli(['affinity', 'opus', 'opus_heavy'], tmpHome), 0)
    assert.equal(await runCli(['affinities'], tmpHome), 0)
    assert.equal(await runCli(['affinity', 'apply', 'opus'], tmpHome), 0)
    assert.equal(currentProfile(tmpHome), 'opus_heavy')
    assert.equal(await runCli(['unaffinity', 'opus'], tmpHome), 0)
  })

  test('profile cleanup and duplicate detection', async () => {
    login(tmpHome, 'same_user', 'tok-1')
    saveProfile(tmpHome, 'p_work')
    login(tmpHome, 'same_user', 'tok-2')
    saveProfile(tmpHome, 'p_work_clone')

    const analysis = analyzeProfilesForCleanup(tmpHome)
    assert.equal(analysis.duplicates.length, 1)
    assert.equal(analysis.duplicates[0].profiles.length, 2)

    const report = formatCleanupReport(analysis)
    assert.match(report, /p_work/)
    assert.match(report, /p_work_clone/)

    assert.equal(await runCli(['cleanup'], tmpHome), 0)
    assert.equal(await runCli(['cleanup', '--force'], tmpHome), 0)
  })

  test('bilingual language support: setLanguage, loadLanguage and formatHelpReport', async () => {
    // Default language is 'vi'
    assert.equal(loadLanguage(tmpHome), 'vi')

    // Switch to English
    assert.equal(setLanguage(tmpHome, 'en'), 'en')
    assert.equal(loadLanguage(tmpHome), 'en')

    // formatHelpReport in English
    const helpEn = formatHelpReport(false, 'en')
    assert.match(helpEn, /Command Usage Guide/)
    assert.match(helpEn, /Profile Management & Switching:/)
    assert.match(helpEn, /\/profile lang \[vi\|en\]/)

    // Switch to Vietnamese
    assert.equal(setLanguage(tmpHome, 'vi'), 'vi')
    assert.equal(loadLanguage(tmpHome), 'vi')

    const helpVi = formatHelpReport(false, 'vi')
    assert.match(helpVi, /Hướng dẫn sử dụng các lệnh/)

    // CLI lang commands
    assert.equal(await runCli(['lang'], tmpHome), 0)
    assert.equal(await runCli(['lang', 'en'], tmpHome), 0)
    assert.equal(loadLanguage(tmpHome), 'en')
    assert.equal(await runCli(['language', 'vi'], tmpHome), 0)
    assert.equal(loadLanguage(tmpHome), 'vi')

    // Invalid language throws / exits 1
    assert.throws(() => setLanguage(tmpHome, 'fr'), /Ngôn ngữ không được hỗ trợ/)
    assert.equal(await runCli(['lang', 'invalid'], tmpHome), 1)

    // Check empty reports in English
    assert.equal(profileListReport(tmpHome, false, 'en'), 'No profiles found. Create one with: /profile new <name>')
    assert.equal(formatCooldowns(tmpHome, null, 'en'), 'No profiles found.')
    assert.equal(formatForecastReport(tmpHome, 'en'), 'No profiles found.')
    assert.match(formatCleanupReport({ duplicates: [], expiredTokens: [], corruptFiles: [] }, false, 'en'), /Awesome/)
  })

  test('disabled profiles: exclude from auto-switch rotation and CLI', async () => {
    login(tmpHome, 'p1', 'tok-1')
    saveProfile(tmpHome, 'p1')
    login(tmpHome, 'p2', 'tok-2')
    saveProfile(tmpHome, 'p2')

    assert.equal(isProfileDisabled(tmpHome, 'p1'), false)
    disableProfile(tmpHome, 'p1')
    assert.equal(isProfileDisabled(tmpHome, 'p1'), true)
    assert.deepEqual(loadDisabledProfiles(tmpHome), ['p1'])

    // /profile list shows disabled badge
    const listOut = profileListReport(tmpHome, false)
    assert.match(listOut, /\(disabled\)/)

    // Re-enable
    enableProfile(tmpHome, 'p1')
    assert.equal(isProfileDisabled(tmpHome, 'p1'), false)

    // CLI commands
    assert.equal(await runCli(['disable', 'p2'], tmpHome), 0)
    assert.equal(isProfileDisabled(tmpHome, 'p2'), true)
    assert.equal(await runCli(['disabled'], tmpHome), 0)
    assert.equal(await runCli(['disabled', '--json'], tmpHome), 0)
    assert.equal(await runCli(['enable', 'p2'], tmpHome), 0)
    assert.equal(isProfileDisabled(tmpHome, 'p2'), false)
  })

  test('addTokenProfile: register from API key and OAuth token directly', async () => {
    // API key registration
    const apiRes = addTokenProfile(tmpHome, 'sk-ant-api03-secret-key-123', 'my-api-profile')
    assert.equal(apiRes.name, 'my-api-profile')
    assert.equal(apiRes.type, 'api_key')
    assert.ok(listProfiles(tmpHome).includes('my-api-profile'))

    const saved = JSON.parse(fs.readFileSync(apiRes.path, 'utf-8'))
    assert.equal(saved.claude_json.primaryApiKey, 'sk-ant-api03-secret-key-123')

    // OAuth token registration with auto-generated name
    const oauthRes = addTokenProfile(tmpHome, 'sk-ant-oat01-my-oauth-token', null, { email: 'custom@domain.com' })
    assert.equal(oauthRes.type, 'oauth_token')
    assert.equal(oauthRes.email, 'custom@domain.com')
    assert.ok(oauthRes.name.startsWith('token-'))

    const savedOauth = JSON.parse(fs.readFileSync(oauthRes.path, 'utf-8'))
    assert.equal(savedOauth.claude_json.oauthAccount.emailAddress, 'custom@domain.com')
    assert.match(savedOauth.credentials, /sk-ant-oat01-my-oauth-token/)

    // CLI command
    assert.equal(await runCli(['add-token', 'sk-ant-api03-cli-token', 'cli-api'], tmpHome), 0)
    assert.ok(listProfiles(tmpHome).includes('cli-api'))
  })

  test('isolated session: prepareSession, syncSessionBack and environment directory', async () => {
    login(tmpHome, 'session_user', 'tok-session')
    saveProfile(tmpHome, 'session-acc')

    const sDir = prepareSession(tmpHome, 'session-acc')
    assert.ok(fs.existsSync(sDir))
    assert.ok(fs.existsSync(path.join(sDir, '.claude.json')))
    assert.ok(fs.existsSync(path.join(sDir, '.claude', '.credentials.json')))

    // Simulate token refresh during the isolated session
    const refreshedCreds = JSON.stringify({ claudeAiOauth: { accessToken: 'new-refreshed-token' } })
    fs.writeFileSync(path.join(sDir, '.claude', '.credentials.json'), refreshedCreds)

    syncSessionBack(tmpHome, 'session-acc', sDir)
    const updated = JSON.parse(fs.readFileSync(profilePath(tmpHome, 'session-acc'), 'utf-8'))
    assert.equal(updated.credentials, refreshedCreds)
  })

  test('JSON output mode for list and current', async () => {
    login(tmpHome, 'json_user', 'tok-json')
    saveProfile(tmpHome, 'json_user')

    // Capture stdout or run CLI
    assert.equal(await runCli(['list', '--json'], tmpHome), 0)
    assert.equal(await runCli(['current', '--json'], tmpHome), 0)
  })

  test('version and help flags, deleteProfile session cleanup', async () => {
    assert.equal(await runCli(['--version'], tmpHome), 0)
    assert.equal(await runCli(['-v'], tmpHome), 0)
    assert.equal(await runCli(['version'], tmpHome), 0)
    assert.equal(await runCli(['--help'], tmpHome), 0)
    assert.equal(await runCli(['-h'], tmpHome), 0)

    // Test deleteProfile cleaning up session directory and disabled list
    login(tmpHome, 'to_del', 'tok-del')
    saveProfile(tmpHome, 'to_del')
    disableProfile(tmpHome, 'to_del')
    prepareSession(tmpHome, 'to_del')
    assert.ok(fs.existsSync(sessionDir(tmpHome, 'to_del')))
    assert.ok(isProfileDisabled(tmpHome, 'to_del'))

    deleteProfile(tmpHome, 'to_del')
    assert.ok(!fs.existsSync(sessionDir(tmpHome, 'to_del')))
    assert.ok(!isProfileDisabled(tmpHome, 'to_del'))
  })

  test('utilization is a 0-100 percentage and reset times keep their date', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'one')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'two')
    const config = { enabled: true, threshold: 95, safeguardThreshold: 85 }

    // 1% used must not read as 100%
    const low = { 'two|b@example.com': { limits: [['5 giờ', 1, ''], ['7 ngày', 1, '']] } }
    const res = await autoCheckAndSwap(tmpHome, { cache: low, config })
    assert.equal(res.swapped, false)
    assert.equal(res.util, 1)

    // a reset 2h from now (possibly after midnight) is still pending, from the raw ISO or the old "DD/MM HH:MM" form
    const later = new Date(Date.now() + 2 * 3600 * 1000)
    const ddmm = `${String(later.getDate()).padStart(2, '0')}/${String(later.getMonth() + 1).padStart(2, '0')}`
    const hhmm = `${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`
    for (const lim of [['5 giờ', 40, '', later.toISOString()], ['5 giờ', 40, `${ddmm} ${hhmm}`]]) {
      const report = formatCooldowns(tmpHome, { 'two|b@example.com': { limits: [lim] } }, 'vi')
      assert.match(report, /two: 40% 🟢 \(Reset lúc .* - còn (1 giờ 5\d|2 giờ 0) phút\)/)
    }
    assert.equal(parseLimits({ five_hour: { utilization: 3, resets_at: later.toISOString() } })[0][3], later.toISOString())

    // a failed fetch backs off for USAGE_TTL instead of retrying on every prompt
    let calls = 0
    const failing = async () => {
      calls++
      throw new Error('offline')
    }
    await autoCheckAndSwap(tmpHome, { fetchFn: failing, config })
    await autoCheckAndSwap(tmpHome, { fetchFn: failing, config })
    assert.equal(calls, 2) // one per profile, first call only
  })

  test('upgrade refreshes the marketplace, then updates the plugin, and stops on failure', () => {
    const seen = []
    const ok = (bin, args) => (seen.push([bin, ...args]), { status: 0, stdout: `${args[1]} ok\n`, stderr: '' })
    assert.equal(upgradePlugin(ok), 'marketplace ok\nupdate ok')
    assert.deepEqual(seen, [
      ['claude', 'plugin', 'marketplace', 'update', 'claude-swap'],
      ['claude', 'plugin', 'update', 'profile-swap@claude-swap'],
    ])

    let n = 0
    const failFirst = () => (n++, { status: 1, stdout: '', stderr: 'network down' })
    assert.throws(() => upgradePlugin(failFirst), /marketplace update claude-swap' thất bại \(mã 1\):\nnetwork down/)
    assert.equal(n, 1)
    assert.throws(() => upgradePlugin(() => ({ error: new Error('ENOENT') })), /Không chạy được/)
  })

  test('smart load balancing: modes, config and CLI', async () => {
    login(tmpHome, 'bal_a', 'tok-bal-a')
    saveProfile(tmpHome, 'bal_a')
    login(tmpHome, 'bal_b', 'tok-bal-b')
    saveProfile(tmpHome, 'bal_b')

    const cfg = loadBalanceConfig(tmpHome)
    assert.equal(cfg.enabled, false)
    assert.equal(cfg.mode, 'least-used')

    saveBalanceConfig(tmpHome, { enabled: true, mode: 'round-robin' })
    const next1 = getNextBalancedProfile(tmpHome)
    assert.ok(['bal_a', 'bal_b'].includes(next1))

    assert.equal(await runCli(['balance', 'status'], tmpHome), 0)
    assert.equal(await runCli(['balance', 'on'], tmpHome), 0)
    assert.equal(await runCli(['balance', 'mode', 'least-used'], tmpHome), 0)
    assert.equal(await runCli(['balance', 'pool', 'all'], tmpHome), 0)
    assert.equal(await runCli(['balance', 'next'], tmpHome), 0)
    assert.equal(await runCli(['balance', 'off'], tmpHome), 0)
  })

  test('webhook configuration, payload dispatch and CLI', async () => {
    const cfg = loadWebhookConfig(tmpHome)
    assert.equal(cfg.telegram, null)

    saveWebhookConfig(tmpHome, {
      discord: 'https://discord.com/api/webhooks/mock',
    })
    const updated = loadWebhookConfig(tmpHome)
    assert.equal(updated.discord, 'https://discord.com/api/webhooks/mock')

    assert.equal(await runCli(['webhook', 'status'], tmpHome), 0)
    assert.equal(await runCli(['webhook', 'set', 'discord', 'https://discord.com/api/webhooks/test'], tmpHome), 0)
    assert.equal(await runCli(['webhook', 'unset', 'discord'], tmpHome), 0)
  })

  test('budget limits, cost reporting and CLI', async () => {
    login(tmpHome, 'bud_user', 'tok-bud')
    saveProfile(tmpHome, 'bud_user')

    setBudgetLimit(tmpHome, 'bud_user', 45.5)
    const cfg = loadBudgetConfig(tmpHome)
    assert.equal(cfg.limits['bud_user'], 45.5)

    const rep = formatBudgetReport(tmpHome, 'vi')
    assert.match(rep, /bud_user: 45.50 USD/)

    assert.equal(await runCli(['budget', 'status'], tmpHome), 0)
    assert.equal(await runCli(['budget', 'set', 'bud_user', '60'], tmpHome), 0)
    assert.equal(await runCli(['budget', 'unset', 'bud_user'], tmpHome), 0)
  })

  test('masking and safe share configuration', async () => {
    assert.equal(isMaskingEnabled(tmpHome), false)
    setMasking(tmpHome, true)
    assert.equal(isMaskingEnabled(tmpHome), true)

    assert.equal(maskEmail('john.doe@example.com', true), 'jo***@example.com')
    assert.equal(maskToken('sk-ant-api03-abcdef123456', true), 'sk-a***3456')

    login(tmpHome, 'share_acc', 'tok-secret')
    saveProfile(tmpHome, 'share_acc')

    const outPath = path.join(tmpHome, 'safe-share.json')
    const res = exportSafeShare(tmpHome, outPath)
    assert.ok(fs.existsSync(outPath))
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'))
    assert.ok(parsed.profiles['share_acc'])
    assert.ok(!parsed.profiles['share_acc'].credentials)
    assert.ok(!parsed.profiles['share_acc'].claude_json)

    assert.equal(await runCli(['mask', 'on'], tmpHome), 0)
    assert.equal(await runCli(['mask', 'off'], tmpHome), 0)
    assert.equal(await runCli(['share'], tmpHome), 0)
  })

  test('shell completion generators', async () => {
    const bash = generateCompletion('bash')
    assert.match(bash, /complete -F _claude_swap_completions/)
    assert.match(bash, /balance/)
    assert.match(bash, /webhook/)
    assert.match(bash, /web/)

    const zsh = generateCompletion('zsh')
    assert.match(zsh, /compdef _claude_swap/)

    const fish = generateCompletion('fish')
    assert.match(fish, /complete -c swap.js/)

    assert.equal(await runCli(['completion', 'bash'], tmpHome), 0)
    assert.equal(await runCli(['completion', 'zsh'], tmpHome), 0)
    assert.equal(await runCli(['completion', 'fish'], tmpHome), 0)
  })

  test('web dashboard server and API endpoints', async () => {
    login(tmpHome, 'web_a', 'tok-web-a')
    saveProfile(tmpHome, 'web_a')
    login(tmpHome, 'web_b', 'tok-web-b')
    saveProfile(tmpHome, 'web_b')

    const data = getDashboardData(tmpHome)
    assert.ok(Array.isArray(data.profiles))
    assert.equal(data.profiles.length, 2)
    assert.ok(data.auto)
    assert.ok(data.balance)

    const dash = await startWebDashboard(tmpHome, { port: 3799, open: false })
    assert.ok(dash.url.includes('3799'))

    // Verify GET /
    const htmlRes = await fetch(dash.url)
    assert.equal(htmlRes.status, 200)
    const htmlText = await htmlRes.text()
    assert.match(htmlText, /claude-swap/)
    assert.match(htmlText, /Web UI/)

    // Verify GET /api/data
    const dataRes = await fetch(`${dash.url}/api/data`)
    assert.equal(dataRes.status, 200)
    const json = await dataRes.json()
    assert.equal(json.profiles.length, 2)

    // Verify POST /api/action swap
    const actRes = await fetch(`${dash.url}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'swap', profile: 'web_b' }),
    })
    assert.equal(actRes.status, 200)
    assert.equal(currentProfile(tmpHome), 'web_b')

    dash.close()
  })
})

