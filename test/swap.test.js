process.env.NODE_ENV = 'test'
process.env.CLAUDE_SWAP_SILENT = '1'

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
  getProfileTags,
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
  loadNotificationConfig,
  disableProfile,
  enableProfile,
  isProfileDisabled,
  loadDisabledProfiles,
  addTokenProfile,
  prepareSession,
  keepLiveMcpOAuth,
  undoSwap,
  renameProfile,
  bindProfile,
  loadProjectBindings,
  loadBranchBindings,
  loadAutoSwitchConfig,
  saveAutoSwitchConfig,
  colorizeLine,
  usageReport,
  statusLineText,
  statusLineData,
  statuslineMode,
  isStatuslineEnabled,
  forecastWarning,
  formatDiagnostics,
  usageHistoryFile,
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
  sparkline,
  settingsList,
  overviewData,
  formatOverview,
  setSetting,
  addScheduleRule,
  removeScheduleRule,
  activeScheduleRule,
  checkSchedule,
  loadSchedule,
  maybeAutoRepair,
  setAutoRepair,
  weeklyReport,
  repairProfile,
  brokenProfiles,
  swapStats,
  sendQuotaAlerts,
  flushWebhooks,
  thinHistory,
  slotSparkline,
  weeklyPace,
  formatProjectUsage,
  loadProjectUsage,
  refreshUsage,
  maskEmail,
  exportSafeShare,
  generateCompletion,
  keychainWriteCommand,
  readPasswordArg,
  positionalArgs,
  syncConfigFile,
  findNextProfile,
  isolatedSession,
  readCurrent,
  quotaSnapshot,
  maskUrl,
  spawnDetached,
} from '../swap.js'
import { startWebDashboard, getDashboardData, stopWebDashboard } from '../web.js'
import child_process from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
    assert.ok(out.includes('🟢 personal'))
    assert.ok(out.includes('b@example.com'))
    // columns line up: the email starts at the same offset on every row
    const col = email => Array.from(out.split('\n').find(r => r.includes(email))).slice(1).join('').indexOf(email) // icons differ in UTF-16 length, not in width
    assert.equal(col('b@example.com'), col('a@example.com'))
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
    assert.equal(await runCli(['notify', 'on'], tmpHome), 0)
    assert.equal(loadNotificationConfig(tmpHome).enabled, true)
    assert.equal(await runCli(['notify', 'off'], tmpHome), 0)
    assert.equal(loadNotificationConfig(tmpHome).enabled, false)
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

  test('an expired temp loan does not drag you back after you switched away on purpose', async () => {
    login(tmpHome, 'tl_a', 'tok-a')
    saveProfile(tmpHome, 'tl-orig')
    login(tmpHome, 'tl_b', 'tok-b')
    saveProfile(tmpHome, 'tl-temp')
    login(tmpHome, 'tl_c', 'tok-c')
    saveProfile(tmpHome, 'tl-other')
    swapProfile(tmpHome, 'tl-orig')
    tempSwap(tmpHome, 'tl-temp', '10ms')
    swapProfile(tmpHome, 'tl-other') // the user moves on by hand
    await new Promise(r => setTimeout(r, 20))

    const res = checkTempExpiry(tmpHome)
    assert.equal(res.expired, true)
    assert.equal(res.revertedTo, null)
    assert.equal(currentProfile(tmpHome), 'tl-other') // left alone
    assert.equal(loadTempProfile(tmpHome), null) // but the loan is closed
    const auto = await autoCheckAndSwap(tmpHome, { config: { enabled: true, threshold: 95 }, cache: {} })
    assert.notEqual(auto.isTempRevert, true) // and auto check does not report a revert that never happened
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
    assert.equal(loadSyncConfig(tmpHome).password, undefined) // never persisted

    // a password saved by an older version is used once, then scrubbed
    fs.writeFileSync(syncConfigFile(tmpHome), JSON.stringify({ targetPath: syncFile, password: 'mypassword' }))
    assert.equal(syncPush(tmpHome, null, '').count, 1)
    assert.equal(JSON.parse(fs.readFileSync(syncConfigFile(tmpHome), 'utf-8')).password, undefined)

    // the env var works end-to-end, so the password need not appear on the command line
    process.env.CLAUDE_SWAP_PASSWORD = 'mypassword'
    try {
      assert.equal(await runCli(['sync', 'pull', syncFile, '--force'], newHome), 0)
    } finally {
      delete process.env.CLAUDE_SWAP_PASSWORD
    }
  })

  test('secrets stay off the command line: password sources and Keychain stdin command', () => {
    assert.equal(readPasswordArg(['export', 'f', '--password-stdin'], () => 'from-stdin\n'), 'from-stdin')
    assert.equal(readPasswordArg(['export', 'f', '--password', 'p1']), 'p1')
    process.env.CLAUDE_SWAP_PASSWORD = 'from-env'
    try {
      assert.equal(readPasswordArg(['export', 'f']), 'from-env')
      assert.equal(readPasswordArg(['export', 'f', '--password', 'p1']), 'p1')
    } finally {
      delete process.env.CLAUDE_SWAP_PASSWORD
    }

    // a bare --password does not swallow the next flag or count as a path value
    assert.deepEqual(positionalArgs(['sync', 'push', '--password', 'pw', '/tmp/b.enc'], 2), ['/tmp/b.enc'])
    assert.deepEqual(positionalArgs(['sync', 'push', '/tmp/b.enc', '--password', '--force'], 2), ['/tmp/b.enc'])
    assert.equal(readPasswordArg(['sync', 'push', '--password', '--force']), '')
    assert.throws(() => keychainWriteCommand('evil" -s "x', 'me', 'data'), /Keychain/)

    const secret = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET"}}'
    const line = keychainWriteCommand('Claude Code-credentials', 'me', secret)
    assert.ok(!line.includes('SECRET')) // hex-encoded, sent on stdin
    const hex = line.match(/-X "([0-9a-f]+)"/)[1]
    assert.equal(Buffer.from(hex, 'hex').toString('utf-8'), secret)
    assert.match(line, /^add-generic-password -U -a "me" -s "Claude Code-credentials" -X "[0-9a-f]+"\n$/)
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
    assert.ok(fs.existsSync(path.join(sDir, '.credentials.json'))) // CLAUDE_CONFIG_DIR/.credentials.json is what Claude Code reads

    // Simulate token refresh during the isolated session
    const refreshedCreds = JSON.stringify({ claudeAiOauth: { accessToken: 'new-refreshed-token' } })
    fs.writeFileSync(path.join(sDir, '.credentials.json'), refreshedCreds)

    syncSessionBack(tmpHome, 'session-acc', sDir)
    const updated = JSON.parse(fs.readFileSync(profilePath(tmpHome, 'session-acc'), 'utf-8'))
    assert.equal(updated.credentials, refreshedCreds)
  })

  test('swap keeps the live MCP logins instead of the profile snapshot', () => {
    const creds = (token, mcp) => JSON.stringify({ claudeAiOauth: { accessToken: token }, mcpOAuth: { srv: { accessToken: mcp } } })
    const credFile = path.join(tmpHome, '.claude', '.credentials.json')
    login(tmpHome, 'mcp_a', 'tok-a')
    fs.writeFileSync(credFile, creds('tok-a', 'old-mcp'))
    saveProfile(tmpHome, 'mcp-a')
    login(tmpHome, 'mcp_b', 'tok-b')
    fs.writeFileSync(credFile, creds('tok-b', 'old-mcp'))
    saveProfile(tmpHome, 'mcp-b')
    fs.writeFileSync(credFile, creds('tok-b', 'fresh-mcp')) // MCP re-authenticated while on mcp-b

    swapProfile(tmpHome, 'mcp-a')
    const live = JSON.parse(fs.readFileSync(credFile, 'utf-8'))
    assert.equal(live.claudeAiOauth.accessToken, 'tok-a') // account follows the profile
    assert.equal(live.mcpOAuth.srv.accessToken, 'fresh-mcp') // MCP logins follow the machine
    // unparsable or MCP-less input falls back to the profile as-is
    assert.equal(keepLiveMcpOAuth('not json', '{"a":1}'), '{"a":1}')
    assert.equal(keepLiveMcpOAuth('{"x":1}', '{"a":1}'), '{"a":1}')
  })

  test('run session shares skills, settings and memory with the real config dir', () => {
    const real = path.join(tmpHome, '.claude')
    fs.mkdirSync(path.join(real, 'skills'), { recursive: true })
    fs.writeFileSync(path.join(real, 'settings.json'), '{"x":1}')
    login(tmpHome, 'share_user', 'tok-share')
    saveProfile(tmpHome, 'share-acc')

    const sDir = prepareSession(tmpHome, 'share-acc')
    assert.equal(fs.readFileSync(path.join(sDir, 'settings.json'), 'utf-8'), '{"x":1}')
    assert.ok(fs.lstatSync(path.join(sDir, 'skills')).isSymbolicLink())
    assert.ok(!fs.existsSync(path.join(sDir, 'agents'))) // absent in the real dir, so nothing to link
    assert.notEqual(
      fs.realpathSync(path.join(sDir, '.credentials.json')),
      fs.realpathSync(path.join(real, '.credentials.json'))
    ) // credentials stay per profile
    prepareSession(tmpHome, 'share-acc') // second run must not fail on existing links
  })

  test('rename moves the profile and everything that points at it', async () => {
    login(tmpHome, 'rn_a', 'tok-a')
    saveProfile(tmpHome, 'old-name')
    login(tmpHome, 'rn_b', 'tok-b')
    saveProfile(tmpHome, 'other')
    swapProfile(tmpHome, 'old-name')
    const repo = path.join(tmpHome, 'repo')
    fs.mkdirSync(repo)
    setAlias(tmpHome, 'o', 'old-name')
    bindProfile(tmpHome, repo, 'old-name')
    bindBranch(tmpHome, repo, 'feat/*', 'old-name')
    disableProfile(tmpHome, 'old-name')
    setBudgetLimit(tmpHome, 'old-name', 50)
    saveAutoSwitchConfig(tmpHome, { ...loadAutoSwitchConfig(tmpHome), order: ['other', 'old-name'], primaryProfile: 'old-name' })
    swapProfile(tmpHome, 'other')
    swapProfile(tmpHome, 'old-name')
    const cacheFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json')
    fs.writeFileSync(cacheFile, JSON.stringify({ 'old-name|rn_a@example.com': { limits: [] }, 'other|rn_b@example.com': { limits: [] } }))

    assert.throws(() => renameProfile(tmpHome, 'old-name', 'other'), /đã tồn tại/)
    assert.throws(() => renameProfile(tmpHome, 'old-name', 'o'), /alias/)
    assert.throws(() => renameProfile(tmpHome, 'old-name', 'bad name'), /không hợp lệ/)
    assert.throws(() => renameProfile(tmpHome, 'nope', 'x'), /Không có profile/)

    assert.deepEqual(renameProfile(tmpHome, 'old-name', 'new-name'), { from: 'old-name', to: 'new-name' })
    assert.ok(!fs.existsSync(profilePath(tmpHome, 'old-name')))
    assert.deepEqual(listProfiles(tmpHome).sort(), ['new-name', 'other'])
    assert.equal(currentProfile(tmpHome), 'new-name')
    assert.equal(loadAliases(tmpHome).o, 'new-name')
    assert.equal(Object.values(loadProjectBindings(tmpHome))[0], 'new-name')
    assert.equal(fs.readFileSync(path.join(repo, '.claude-profile'), 'utf-8').trim(), 'new-name')
    assert.equal(Object.values(loadBranchBindings(tmpHome))[0][0].profile, 'new-name')
    assert.deepEqual(loadDisabledProfiles(tmpHome), ['new-name'])
    assert.deepEqual(Object.keys(loadBudgetConfig(tmpHome).limits), ['new-name'])
    const auto = loadAutoSwitchConfig(tmpHome)
    assert.deepEqual(auto.order, ['other', 'new-name'])
    assert.equal(auto.primaryProfile, 'new-name')
    assert.ok(loadSwapHistory(tmpHome).every(h => h.from !== 'old-name' && h.to !== 'old-name'))
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))).sort(), ['new-name|rn_a@example.com', 'other|rn_b@example.com'])
    assert.equal(undoSwap(tmpHome).to, 'other') // history still resolves after the rename
    assert.equal(await runCli(['rename', 'new-name', 'final', '--no-color'], tmpHome), 0)
    assert.equal(await runCli(['rename', 'final'], tmpHome), 1) // missing the new name
  })

  test('rename survives corrupt state files and a stale session dir', () => {
    login(tmpHome, 'cs_a', 'tok-a')
    saveProfile(tmpHome, 'cs-old')
    const dir = path.join(tmpHome, '.config', 'claude-cli-profiles')
    fs.writeFileSync(path.join(dir, '.aliases.json'), '{ not json')
    fs.mkdirSync(path.join(dir, '.sessions', 'cs-new'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sessions', 'cs-new', 'stale'), 'x')
    prepareSession(tmpHome, 'cs-old')
    renameProfile(tmpHome, 'cs-old', 'cs-new')
    assert.equal(fs.readFileSync(path.join(dir, '.aliases.json'), 'utf-8'), '{ not json') // left untouched
    assert.ok(!fs.existsSync(path.join(dir, '.sessions', 'cs-new', 'stale')))
    assert.ok(fs.existsSync(path.join(dir, '.sessions', 'cs-new', '.credentials.json')))
    renameProfile(tmpHome, 'cs-new', 'CS-new') // case-only change
    assert.deepEqual(listProfiles(tmpHome).filter(n => /cs-new/i.test(n)), ['CS-new'])
  })

  test('rename carries the isolated run session along', () => {
    login(tmpHome, 'rs_a', 'tok-a')
    saveProfile(tmpHome, 'sess-old')
    const oldDir = prepareSession(tmpHome, 'sess-old')
    renameProfile(tmpHome, 'sess-old', 'sess-new')
    assert.ok(!fs.existsSync(oldDir))
    assert.ok(fs.existsSync(path.join(sessionDir(tmpHome, 'sess-new'), '.credentials.json')))
  })

  test('undo goes back to the profile before the last swap, and again', () => {
    login(tmpHome, 'u_a', 'tok-a')
    saveProfile(tmpHome, 'un-a')
    login(tmpHome, 'u_b', 'tok-b')
    saveProfile(tmpHome, 'un-b')
    assert.throws(() => undoSwap(tmpHome), /Không có lần chuyển/) // nothing swapped yet

    swapProfile(tmpHome, 'un-a')
    assert.deepEqual(undoSwap(tmpHome), { from: 'un-a', to: 'un-b' })
    assert.equal(currentProfile(tmpHome), 'un-b')
    assert.equal(undoSwap(tmpHome).to, 'un-a') // undo is itself a swap, so it toggles
    assert.equal(loadSwapHistory(tmpHome)[0].reason, 'undo')
  })

  test('forecast counts from the last measurement and drops a stale warning', () => {
    login(tmpHome, 'fs_a', 'tok-a')
    saveProfile(tmpHome, 'fs')
    const now = Date.now()
    const min = 60000
    const hist = (t1, u1, t2, u2) => ({ fs: [{ timestamp: now - t1 * min, util5h: u1 }, { timestamp: now - t2 * min, util5h: u2 }] })
    // 40% -> 83% in 60 min = 43%/h; 12% left to 95 = 16.7 min after the last reading
    const fresh = calculateForecast(tmpHome, 'fs', 95, hist(65, 40, 5, 83))
    assert.equal(fresh.minutesUntilThreshold, 12) // 16.7 - 5 min already elapsed (away from a .5 rounding edge)
    assert.equal(fresh.stale, false)
    // the same numbers measured an hour ago: the threshold has long passed, but the data is stale
    const old = calculateForecast(tmpHome, 'fs', 95, hist(125, 40, 65, 80))
    assert.equal(old.stale, true)
    assert.equal(old.minutesUntilThreshold, 0)
    assert.match(old.message, /Số liệu đã cũ/)
    fs.writeFileSync(usageHistoryFile(tmpHome), JSON.stringify(hist(125, 40, 65, 80)))
    assert.equal(forecastWarning(tmpHome), '') // no scary "~0p" from yesterday's numbers
    fs.writeFileSync(usageHistoryFile(tmpHome), JSON.stringify(hist(65, 40, 5, 83)))
    assert.equal(forecastWarning(tmpHome), '⚠ 5h ~12p')
  })

  test('forecastWarning only speaks when the threshold is minutes away', () => {
    login(tmpHome, 'f_a', 'tok-a')
    saveProfile(tmpHome, 'fc')
    const now = Date.now()
    const write = (a, b) => fs.writeFileSync(usageHistoryFile(tmpHome), JSON.stringify({ fc: [
      { timestamp: now - 3600000, util5h: a, util7d: 0 },
      { timestamp: now, util5h: b, util7d: 0 },
    ] }))
    write(40, 90) // +50%/h, 5% left to 95: ~6 minutes
    assert.match(forecastWarning(tmpHome), /^⚠ 5h ~\d+p$/)
    write(10, 20) // far from the threshold
    assert.equal(forecastWarning(tmpHome), '')
    write(90, 50) // cooling down
    assert.equal(forecastWarning(tmpHome), '')
  })

  test('doctor counts MCP logins and flags the ones that cannot renew', () => {
    login(tmpHome, 'd_a', 'tok-a')
    fs.writeFileSync(path.join(tmpHome, '.claude', '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'tok-a' },
      mcpOAuth: {
        ok: { accessToken: 'x', expiresAt: Date.now() + 1e6, refreshToken: 'r' },
        renewable: { accessToken: 'x', expiresAt: 1, refreshToken: 'r' },
        dead: { accessToken: 'x', expiresAt: 1 },
      },
    }))
    saveProfile(tmpHome, 'doc')
    const p = diagnoseProfiles(tmpHome).profiles.find(x => x.name === 'doc')
    assert.deepEqual(p.mcp, { total: 3, expired: 1 })
    assert.equal(p.status, 'warn')
    assert.match(formatDiagnostics({ profiles: [p] }), /MCP: 3 đăng nhập, 1 hết hạn/)
  })

  test('statusline text shows both windows with reset times, and on/off hides it', async () => {
    login(tmpHome, 'sl_a', 'tok-a')
    saveProfile(tmpHome, 'sl')
    const soon = new Date(Date.now() + 2 * 3600000 + 60000).toISOString()
    const later = new Date(Date.now() + 3 * 86400000 + 5400000).toISOString()
    writeFreshCache(path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json'), {
      'sl|sl_a@example.com': { limits: [['5 giờ', 34, '', soon], ['7 ngày', 90, '', later]] },
    })
    const text = statusLineText(tmpHome)
    // a hot 7d window also shows its budget until the reset: 10% over ~3d1h
    assert.match(text, /^● sl │ 5h \[███░░░░░\] 34% ⏳2h0\dm │ 7d \[███████░\] 90%🔥 ⏳3d1h │ 7d ≈0\.1%\/h$/)
    assert.equal(isStatuslineEnabled(tmpHome), true)

    assert.equal(await runCli(['statusline', 'off'], tmpHome), 0)
    assert.equal(statusLineText(tmpHome), '')
    assert.equal(await runCli(['statusline', 'toggle'], tmpHome), 0) // off -> on
    assert.equal(isStatuslineEnabled(tmpHome), true)
    assert.match(statusLineText(tmpHome), /^● sl/)
  })

  test('coloured output sticks to the SGR codes the host is known to draw', async () => {
    login(tmpHome, 'k_a', 'tok-a')
    saveProfile(tmpHome, 'k1')
    writeFreshCache(path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json'), {
      'k1|k_a@example.com': { limits: [['5 giờ', 85, ''], ['7 ngày', 10, '']] },
    })
    const lines = ["❌ Lỗi: 'x'", '✨ ok', '⚠️ w', 'ℹ️ i', '📜 Lịch sử:', '• 1 | 👤 [manual] a ➔ b', 'BẬT TẮT 55%', '🏷️ t']
    const out = [profileListReport(tmpHome, true), await usageReport(tmpHome, async () => ({}), false, true), ...lines.map(colorizeLine)].join('\n')
    // the host printed `[37m` and `[38;5;248m` as text; only these were seen drawn properly
    const seen = new Set(['0', '1;31', '1;32', '1;33', '1;36', '1;37', '36', '90', '1;38;5;208', '38;5;240'])
    const used = new Set([...out.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1]))
    assert.deepEqual([...used].filter(c => !seen.has(c)), [])
  })

  test('a limit with no reset time shows a dash, not a huge countdown', () => {
    login(tmpHome, 'nr_a', 'tok-a')
    saveProfile(tmpHome, 'nr')
    writeFreshCache(path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json'), {
      'nr|nr_a@example.com': { limits: [['5 giờ', 10, ''], ['7 ngày', 20, '']] },
    })
    assert.doesNotMatch(profileListReport(tmpHome, false), /\d{6,}/)
    assert.equal(statusLineText(tmpHome), '● nr │ 5h [█░░░░░░░] 10% │ 7d [██░░░░░░] 20%')
  })

  test('statusline modes: band by default, plain line on request, ansi uses only drawable codes', async () => {
    login(tmpHome, 'sm_a', 'tok-a')
    saveProfile(tmpHome, 'sm')
    writeFreshCache(path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json'), {
      'sm|sm_a@example.com': { limits: [['5 giờ', 85, '', new Date(Date.now() + 3600000).toISOString()], ['7 ngày', 10, '']] },
    })
    assert.equal(statuslineMode(tmpHome), 'band')
    const d = statusLineData(tmpHome)
    assert.equal(d.mode, 'band')
    assert.ok(!d.text.includes('\x1b') && d.text.includes('85%')) // the pinned form must carry no ESC byte
    const seen = new Set(['0', '1;31', '1;32', '1;33', '1;36', '36', '90', '1;38;5;208', '38;5;240'])
    const used = [...d.ansi.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1])
    assert.deepEqual([...new Set(used)].filter(c => !seen.has(c)), [])
    assert.ok(d.ansi.includes('85%') && d.ansi.includes('🔥') && !d.ansi.includes('↻'))

    assert.equal(await runCli(['statusline', 'line'], tmpHome), 0)
    assert.equal(statusLineData(tmpHome).mode, 'line')
    assert.equal(await runCli(['statusline', 'off'], tmpHome), 0)
    assert.equal(statusLineData(tmpHome), null)
    assert.equal(await runCli(['statusline', 'toggle'], tmpHome), 0) // back on, mode kept
    assert.equal(statusLineData(tmpHome).mode, 'line')
    assert.equal(await runCli(['statusline', 'band'], tmpHome), 0)
    assert.equal(statuslineMode(tmpHome), 'band')
  })

  test('list shows both reset columns', () => {
    login(tmpHome, 'rs_a', 'tok-a')
    saveProfile(tmpHome, 'rs')
    writeFreshCache(path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json'), {
      'rs|rs_a@example.com': { limits: [['5 giờ', 10, '', new Date(Date.now() + 90 * 60000 + 30000).toISOString()], ['7 ngày', 20, '', new Date(Date.now() + 2 * 86400000 + 5 * 3600000).toISOString()]] },
    })
    const out = profileListReport(tmpHome, false)
    assert.match(out, /RESET 5H {2}RESET 7D/)
    assert.match(out, /1h\d\dm {5}2d\dh/)
  })

  test('human commands are coloured, machine-read ones and --no-color stay plain', async () => {
    login(tmpHome, 'c_a', 'tok-a')
    saveProfile(tmpHome, 'col-a')
    login(tmpHome, 'c_b', 'tok-b')
    saveProfile(tmpHome, 'col-b')
    const run = async args => {
      const lines = []
      const orig = console.log
      console.log = (...a) => lines.push(a.join(' '))
      try {
        await runCli(args, tmpHome)
      } finally {
        console.log = orig
      }
      return lines.join('\n')
    }
    assert.match(await run(['swap', 'col-a']), /\x1b\[/) // coloured
    assert.doesNotMatch(await run(['swap', 'col-b', '--no-color']), /\x1b\[/)
    assert.equal(await run(['current']), 'col-b') // the hook compares this string
    assert.match(await run(['auto', 'check']), /^(?!.*\x1b)/s) // `[status]` is parsed line by line
    assert.doesNotMatch(await run(['history', '--json']), /\x1b\[/)

    const err = colorizeLine("❌ Lỗi: Profile 'x' không tồn tại.")
    assert.ok(err.startsWith('\x1b[1;31m') && err.includes('\x1b[1;33m\'x\'')) // red line, yellow name
    assert.equal(colorizeLine('plain \x1b[32mgreen\x1b[0m'), 'plain \x1b[32mgreen\x1b[0m') // already styled lines are left alone
    assert.equal(colorizeLine("It's not 'x"), "It's not 'x") // an apostrophe in prose is not a quoted name
    // errors honour --no-color and NO_COLOR too
    const errs = []
    const origErr = console.error
    console.error = (...x) => errs.push(x.join(' '))
    try {
      await runCli(['swap', 'nope', '--no-color'], tmpHome)
      await runCli(['swap', 'nope'], tmpHome)
    } finally {
      console.error = origErr
    }
    assert.doesNotMatch(errs[0], /\x1b\[/)
    assert.match(errs[1], /\x1b\[1;31m/)
  })

  test('deleting a profile removes its run session but never the shared config it links to', () => {
    const real = path.join(tmpHome, '.claude')
    fs.mkdirSync(path.join(real, 'skills'), { recursive: true })
    fs.writeFileSync(path.join(real, 'skills', 'keep.md'), 'x')
    login(tmpHome, 'del_u', 'tok-del')
    saveProfile(tmpHome, 'del-acc')
    const sDir = prepareSession(tmpHome, 'del-acc')
    assert.ok(fs.existsSync(path.join(sDir, 'skills', 'keep.md'))) // visible through the link
    deleteProfile(tmpHome, 'del-acc')
    assert.ok(!fs.existsSync(sDir))
    assert.ok(fs.existsSync(path.join(real, 'skills', 'keep.md'))) // the target survives
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
    assert.equal(calls, 1) // only the current profile, and only the first call (the failure is cached)
  })

  test('auto check fetches only the current profile until a swap needs the others', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'r-one')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'r-two') // current
    login(tmpHome, 'c', 'tok-c')
    saveProfile(tmpHome, 'r-three')
    swapProfile(tmpHome, 'r-two')
    const config = { enabled: true, threshold: 95 }
    const fetched = []
    const usage = pct => ({ five_hour: { utilization: pct, resets_at: new Date(Date.now() + 3600000).toISOString() } })
    const fetchWith = pcts => async token => (fetched.push(token), usage(pcts[token] ?? 10))

    const calm = await autoCheckAndSwap(tmpHome, { config, fetchFn: fetchWith({ 'tok-b': 20 }) })
    assert.equal(calm.swapped, false)
    assert.deepEqual(fetched, ['tok-b']) // nobody else was asked

    // the cache entry is fresh, so a second prompt costs nothing; force it stale to cross the threshold
    fs.rmSync(path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json'))
    fetched.length = 0
    const hot = await autoCheckAndSwap(tmpHome, { config, fetchFn: fetchWith({ 'tok-b': 99, 'tok-a': 50, 'tok-c': 5 }) })
    assert.equal(hot.swapped, true)
    assert.equal(hot.to, 'r-three') // chosen from fresh numbers for everyone
    assert.deepEqual([...fetched].sort(), ['tok-a', 'tok-b', 'tok-c'])
  })

  test('status line flags stale quota and, with auto-switch off, suggests the next profile', async () => {
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'st-two')
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'st-one') // current
    const cacheFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json')
    const lim = (label, pct) => [label, pct, '', new Date(Date.now() + 3600000).toISOString()]
    const at = Date.now() / 1000 - 3 * 3600 // three hours old
    fs.writeFileSync(cacheFile, JSON.stringify({
      'st-one|a@example.com': { at, limits: [lim('5 giờ', 20), lim('7 ngày', 90)] },
      'st-two|b@example.com': { at, limits: [lim('5 giờ', 5), lim('7 ngày', 31)] },
    }))
    saveAutoSwitchConfig(tmpHome, { ...loadAutoSwitchConfig(tmpHome), enabled: false })
    let d = statusLineData(tmpHome)
    assert.match(d.stale, /^⚠ cũ 3h0\dm$/)
    assert.equal(d.suggest, '→ st-two 7d 31%')
    assert.match(d.text, /→ st-two 7d 31%/)

    // a failed fetch keeps the old limits: say so instead of the age; auto-switch on needs no hint
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
    cache['st-one|a@example.com'] = { ...cache['st-one|a@example.com'], at: Date.now() / 1000, note: 'lỗi mạng: fetch failed' }
    cache['st-two|b@example.com'].note = 'token đã hết hạn — chuyển sang profile này'
    fs.writeFileSync(cacheFile, JSON.stringify(cache))
    saveAutoSwitchConfig(tmpHome, { ...loadAutoSwitchConfig(tmpHome), enabled: true })
    d = statusLineData(tmpHome)
    assert.equal(d.stale, '⚠ lỗi mạng')
    assert.equal(d.suggest, '')

    // the list flags the stale row, and still finds its numbers with emails masked
    setMasking(tmpHome, true)
    const list = profileListReport(tmpHome, false, 'vi')
    assert.match(list, /st-two .* 31% .*⚠ token đã hết hạn/)

    // a profile without an OAuth token: the refresh replaces the old note, so `list` and `usage` agree
    const prof = path.join(tmpHome, '.config', 'claude-cli-profiles', 'st-two.json')
    fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(fs.readFileSync(prof, 'utf-8')), credentials: '{}' }))
    await refreshUsage(tmpHome, ['st-two'])
    assert.match(profileListReport(tmpHome, false, 'vi'), /st-two .*⚠ không có token OAuth/)

    assert.equal(sparkline([0, 50, 100, 200, -5]), '▁▅██▁')
  })

  test('history keeps a week, thinned to hourly past 6h; slot sparklines; project usage; weekly pace', async () => {
    const now = Date.now()
    const H = 3600000
    const at = (h, u5 = 10, u7 = null) => ({ timestamp: now - h * H, util5h: u5, util7d: u7 })
    const hour = Math.floor((now - 30 * H) / H) * H // three readings inside one clock hour, 30h ago
    const inHour = m => ({ timestamp: hour + m * 60000, util5h: m, util7d: null })
    const thinned = thinHistory([at(200), inHour(5), inHour(20), inHour(50), at(2), at(1.5), at(1)], now)
    assert.equal(thinned.length, 4) // the 200h-old one dropped, the old hour kept as its last reading
    assert.equal(thinned[0].util5h, 50)
    assert.equal(slotSparkline([at(0.5, 100), at(0.2, 0), at(3, 50)], 'util5h', H, 4, now), '▅··█') // 3h ago is the oldest of 4 hourly slots

    // the 5h usage gained between readings is put down to the session's project; a reset counts the new value
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'pj-one')
    recordUsageSnapshot(tmpHome, 'pj-one', 10, 50, '/w/alpha')
    recordUsageSnapshot(tmpHome, 'pj-one', 25, 52, '/w/alpha')
    recordUsageSnapshot(tmpHome, 'pj-one', 30, 53, '/w/beta')
    recordUsageSnapshot(tmpHome, 'pj-one', 4, 54, '/w/beta')
    recordUsageSnapshot(tmpHome, 'pj-one', 90, 55) // another profile's fetch: no project
    const totals = Object.fromEntries(Object.entries(loadProjectUsage(tmpHome)).map(([d, v]) => [d, Object.values(v)[0]]))
    assert.deepEqual(totals, { '/w/alpha': 15, '/w/beta': 9 })
    assert.match(formatProjectUsage(tmpHome, 7, 'vi'), /alpha\s+15%.*\n.*beta\s+9%/)

    // 7-day budget: 10% left over 10h is 1%/h; the readings above climbed 5% in moments, too short to give a pace
    const cacheFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json')
    writeFreshCache(cacheFile, { 'pj-one|a@example.com': { limits: [['7 ngày', 90, '', new Date(now + 10 * H + 60000).toISOString()]] } })
    const pace = weeklyPace(tmpHome, 'pj-one')
    assert.equal(Math.round(pace.budget * 100) / 100, 1)
    assert.equal(pace.rate, null)
    const fast = weeklyPace(tmpHome, 'pj-one', undefined, { 'pj-one': [at(2, 0, 80), at(0, 0, 90)] })
    assert.equal(Math.round(fast.rate), 5)
  })

  test('status line names profiles whose full window has reset since', () => {
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'rc-two')
    login(tmpHome, 'c', 'tok-c')
    saveProfile(tmpHome, 'rc-three')
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'rc-one') // current
    const cacheFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json')
    const past = new Date(Date.now() - 60000).toISOString()
    writeFreshCache(cacheFile, {
      'rc-one|a@example.com': { limits: [['5 giờ', 99, '', past]] }, // the current one is not "recovered"
      'rc-two|b@example.com': { limits: [['5 giờ', 97, '', past]] },
      'rc-three|c@example.com': { limits: [['5 giờ', 97, '', past]], note: 'token đã hết hạn' },
    })
    assert.deepEqual(statusLineData(tmpHome).recovered, ['rc-two'])
  })

  test('repair renews an expired profile in an isolated session, and says what a missing token needs', async () => {
    const profilesDirPath = path.join(tmpHome, '.config', 'claude-cli-profiles')
    const creds = (token, expiresAt, refreshToken) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt, refreshToken } })
    login(tmpHome, 'x', 'tok-x')
    saveProfile(tmpHome, 'rp-old')
    login(tmpHome, 'y', 'tok-y')
    saveProfile(tmpHome, 'rp-gone')
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'rp-cur') // current
    const setCreds = (name, c) => {
      const f = path.join(profilesDirPath, `${name}.json`)
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf-8')), credentials: c }))
    }
    setCreds('rp-old', creds('tok-x', Date.now() - 1000, 'r-x'))
    setCreds('rp-gone', '{}')
    assert.deepEqual(brokenProfiles(tmpHome).sort(), ['rp-gone', 'rp-old'])

    const runs = []
    // stands in for `claude -p`: Claude Code refreshes the session's token before its request
    const fakeClaude = (bin, args, opts) => {
      runs.push([bin, ...args])
      fs.writeFileSync(path.join(opts.env.CLAUDE_CONFIG_DIR, '.credentials.json'), creds('tok-x2', Date.now() + 3600000, 'r-x2'))
      return { status: 0, stdout: 'ok' }
    }
    assert.equal((await repairProfile(tmpHome, 'rp-old', fakeClaude)).state, 'repaired')
    assert.equal(runs[0][0], 'claude')
    const saved = JSON.parse(JSON.parse(fs.readFileSync(path.join(profilesDirPath, 'rp-old.json'), 'utf-8')).credentials)
    assert.equal(saved.claudeAiOauth.accessToken, 'tok-x2')
    assert.equal((await repairProfile(tmpHome, 'rp-gone', fakeClaude)).state, 'no_token')
    assert.equal((await repairProfile(tmpHome, 'rp-cur', fakeClaude)).state, 'current')
    assert.equal(runs.length, 1) // only the expired one ran claude

    // a renewed token left in the session dir (a run killed before its sync-back) is taken back without a request
    setCreds('rp-old', creds('tok-x', Date.now() - 1000, 'r-x'))
    assert.equal((await repairProfile(tmpHome, 'rp-old', () => assert.fail('no request needed'))).state, 'repaired')

    setCreds('rp-old', creds('tok-x', Date.now() - 1000, 'r-x'))
    fs.rmSync(path.join(profilesDirPath, '.sessions'), { recursive: true, force: true })
    const stillOld = await repairProfile(tmpHome, 'rp-old', () => ({ status: 1, stderr: 'network down\nmore' }))
    assert.deepEqual([stillOld.state, stillOld.detail], ['failed', 'network down'])
    // a refresh that fails and leaves the session without a token must not wipe the profile's refresh token
    fs.rmSync(path.join(profilesDirPath, '.sessions'), { recursive: true, force: true })
    const wiped = await repairProfile(tmpHome, 'rp-old', (bin, args, opts) => {
      fs.writeFileSync(path.join(opts.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}')
      return { status: 1, stderr: '401' }
    })
    assert.equal(wiped.state, 'failed')
    const kept = JSON.parse(JSON.parse(fs.readFileSync(path.join(profilesDirPath, 'rp-old.json'), 'utf-8')).credentials)
    assert.deepEqual([kept.claudeAiOauth.accessToken, kept.claudeAiOauth.refreshToken], ['tok-x', 'r-x'])
  })

  test('stats --json carries swap counts and project usage', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'js-one')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'js-two')
    swapProfile(tmpHome, 'js-one')
    recordUsageSnapshot(tmpHome, 'js-one', 10, null, '/w/p')
    recordUsageSnapshot(tmpHome, 'js-one', 12, null, '/w/p')
    const logs = []
    const orig = console.log
    console.log = m => logs.push(m)
    try {
      assert.equal(await runCli(['stats', '--json'], tmpHome), 0)
    } finally {
      console.log = orig
    }
    const out = JSON.parse(logs.join('\n'))
    assert.equal(out.swaps.total, swapStats(tmpHome).total)
    assert.equal(out.swaps.byProfile['js-one'], 1)
    assert.deepEqual(out.projects, [{ dir: '/w/p', pct: 2 }])
  })

  test('quota alerts go to the webhook once per window', async () => {
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'al-two')
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'al-one') // current
    const past = new Date(Date.now() - 60000).toISOString()
    const later = new Date(Date.now() + 10 * 3600000).toISOString()
    const cache = {
      'al-one|a@example.com': { at: Date.now() / 1000, limits: [['7 ngày', 93, '', later]] },
      'al-two|b@example.com': { at: Date.now() / 1000, limits: [['5 giờ', 99, '', past]] },
    }
    recordUsageSnapshot(tmpHome, 'al-one', 0, 85)
    const history = JSON.parse(fs.readFileSync(usageHistoryFile(tmpHome), 'utf-8'))
    history['al-one'][0].timestamp = Date.now() - 2 * 3600000 // 85% → 93% in 2h: 4%/h against 0.7%/h left
    fs.writeFileSync(usageHistoryFile(tmpHome), JSON.stringify(history))
    recordUsageSnapshot(tmpHome, 'al-one', 0, 93)
    saveWebhookConfig(tmpHome, { generic: 'https://hooks.example.test/x' })

    const posted = []
    const origFetch = globalThis.fetch
    const origEnv = [process.env.NODE_ENV, process.env.CLAUDE_SWAP_SILENT]
    globalThis.fetch = async (url, init) => (posted.push(JSON.parse(init.body)), { status: 200 })
    process.env.NODE_ENV = ''
    process.env.CLAUDE_SWAP_SILENT = ''
    try {
      sendQuotaAlerts(tmpHome, cache)
      sendQuotaAlerts(tmpHome, cache) // same windows: nothing new
      await flushWebhooks()
    } finally {
      globalThis.fetch = origFetch
      ;[process.env.NODE_ENV, process.env.CLAUDE_SWAP_SILENT] = origEnv
    }
    // the weekly report rides along unless the test runs on a Monday before 08:00
    assert.deepEqual(posted.map(p => p.event).filter(e => e !== 'weekly_report').sort(), ['quota_pace', 'quota_recovered'])
    assert.ok(posted.filter(p => p.event === 'weekly_report').length <= 1)
    assert.match(posted.find(p => p.event === 'quota_recovered').text, /al-two đã hồi quota/)
  })

  test('help <keyword> keeps only the matching commands under their titles', () => {
    const out = formatHelpReport(false, 'vi', 'schedule')
    assert.match(out, /\/profile schedule <giờ> <p>/)
    assert.doesNotMatch(out, /\/profile list /)
    assert.match(formatHelpReport(false, 'vi', 'zzz-nothing'), /Không có lệnh nào khớp/)
  })

  test('schedule swaps once when a window starts, overnight windows included', () => {
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'sc-night')
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'sc-day') // current
    assert.throws(() => addScheduleRule(tmpHome, '9-18', 'sc-day'), /Khung giờ không hợp lệ/)
    addScheduleRule(tmpHome, '22:00-06:00', 'sc-night')
    const at = (h, m = 0, day = 10) => new Date(2026, 9, day, h, m)
    assert.equal(activeScheduleRule(loadSchedule(tmpHome).rules, at(12)), null)
    // 02:00 on the 11th is the tail of the window that started on the 10th
    assert.equal(activeScheduleRule(loadSchedule(tmpHome).rules, at(2, 0, 11)).key, '2026-10-10|0')
    const config = { threshold: 95, safeguardThreshold: 85 }
    assert.deepEqual(checkSchedule(tmpHome, config, {}, at(22, 30)), { from: 'sc-day', to: 'sc-night' })
    swapProfile(tmpHome, 'sc-day') // a manual swap inside the window is left alone
    assert.equal(checkSchedule(tmpHome, config, {}, at(23)), null)
    assert.equal(currentProfile(tmpHome), 'sc-day')
    renameProfile(tmpHome, 'sc-night', 'sc-late')
    assert.equal(loadSchedule(tmpHome).rules[0].profile, 'sc-late')
    removeScheduleRule(tmpHome, 'all')
    assert.equal(loadSchedule(tmpHome).rules.length, 0)
  })

  test('status line names a model whose own 7-day limit runs out, with the profile that has most of it', () => {
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'md-two')
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'md-one') // current
    writeFreshCache(path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json'), {
      'md-one|a@example.com': { limits: [['5 giờ', 10, ''], ['7 ngày Fable', 88, '']] },
      'md-two|b@example.com': { limits: [['7 ngày Fable', 12, '']] },
    })
    assert.equal(statusLineData(tmpHome).models, 'Fable 7d 88% → md-two 12%')
  })

  test('auto repair starts a background repair at most every 6h, only for an expired token', () => {
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'ar-old')
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'ar-cur')
    const f = path.join(tmpHome, '.config', 'claude-cli-profiles', 'ar-old.json')
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf-8')), credentials: JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() - 1, refreshToken: 'r' } }) }))
    const spawned = []
    const spawn = (cmd, args) => spawned.push(args[1])
    assert.equal(maybeAutoRepair(tmpHome, spawn), false) // off by default
    setAutoRepair(tmpHome, true)
    assert.equal(maybeAutoRepair(tmpHome, spawn), true)
    assert.equal(maybeAutoRepair(tmpHome, spawn), false) // ran just now
    assert.deepEqual(spawned, ['repair'])
  })

  test('weekly report sums up quota, projects and swaps', () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'wr-one')
    writeFreshCache(path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json'), {
      'wr-one|a@example.com': { limits: [['5 giờ', 30, ''], ['7 ngày', 60, '']] },
    })
    recordUsageSnapshot(tmpHome, 'wr-one', 10, null, '/w/app')
    recordUsageSnapshot(tmpHome, 'wr-one', 15, null, '/w/app')
    const text = weeklyReport(tmpHome)
    assert.match(text, /wr-one: 5h 30% · 7d 60%/)
    assert.match(text, /app 5%/)
    assert.match(text, /Chuyển profile 7 ngày qua: \d+ lần/)
  })

  test('settings lists every option and writes each through its own validation', () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'st-main')
    const get = key => settingsList(tmpHome).find(r => r.key === key)
    assert.equal(get('auto.threshold').value, 95)
    assert.deepEqual(get('auto.primary').choices, ['', 'st-main'])
    setSetting(tmpHome, 'auto.threshold', '88')
    setSetting(tmpHome, 'auto.enabled', 'off')
    setSetting(tmpHome, 'auto.primary', 'st-main')
    setSetting(tmpHome, 'statusline', 'off')
    setSetting(tmpHome, 'balance', 'round-robin')
    assert.deepEqual(
      ['auto.threshold', 'auto.enabled', 'auto.primary', 'statusline', 'balance'].map(k => get(k).value),
      [88, false, 'st-main', 'off', 'round-robin']
    )
    assert.equal(loadAutoSwitchConfig(tmpHome).threshold, 88)
    assert.throws(() => setSetting(tmpHome, 'auto.threshold', '500'), /từ 1 đến 100/)
    assert.throws(() => setSetting(tmpHome, 'auto.primary', 'ghost'), /không tồn tại/)
    assert.throws(() => setSetting(tmpHome, 'nope', '1'), /Không có cài đặt/)
  })

  test('bare /profile opens with an overview: current profile, quota bars and every setting', () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'ov-main')
    const cacheFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.usage-cache.json')
    writeFreshCache(cacheFile, { 'ov-main|a@example.com': { limits: [['5 giờ', 34, '20:00'], ['7 ngày', 91, '20:00']] } })
    setSetting(tmpHome, 'notify', 'on')
    const d = overviewData(tmpHome)
    assert.equal(d.profile, 'ov-main')
    assert.deepEqual(d.windows.map(w => [w.name, w.pct]), [['5h', 34], ['7d', 91]])
    assert.equal(d.settings.find(r => r.key === 'notify').icon, '🔔')
    const text = formatOverview(tmpHome, false)
    assert.match(text, /👤 ov-main a@example\.com/)
    assert.match(text, /7 ngày .*\] {2}91% 🔥/)
    assert.match(text, /🔔 notify +● bật/)
    assert.match(text, /🔁 auto\.return +○ tắt/)
    assert.doesNotMatch(text, /\x1b/)
  })

  test('forecast reads a burst after an idle stretch at its real pace, not averaged over the idle hours', () => {
    const now = Date.now()
    const idle = Array.from({ length: 72 }, (_, i) => ({ timestamp: now - (72 - i) * 3600000 - 600000, util5h: 0, util7d: 0 }))
    const history = { burst: [...idle, { timestamp: now - 600000, util5h: 0 }, { timestamp: now - 300000, util5h: 10 }, { timestamp: now, util5h: 40 }] }
    const f = calculateForecast(tmpHome, 'burst', 95, history)
    assert.equal(f.trend, 'increasing')
    assert.ok(f.burnRatePerHour > 100, `burn rate ${f.burnRatePerHour}`)
  })

  test('auto check refreshes the current quota even with auto-switch off, so the status line is not stale', async () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'off-one')
    const fetched = []
    const res = await autoCheckAndSwap(tmpHome, {
      config: { enabled: false },
      fetchFn: async token => (fetched.push(token), { five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600000).toISOString() } }),
    })
    assert.equal(res.reason, 'disabled')
    assert.deepEqual(fetched, ['tok-a'])
    assert.equal(statusLineData(tmpHome).windows[0].pct, 42)
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

  test('balance on drives auto-switch: round-robin rotates, least-used and pools apply, order is overridden', () => {
    for (const n of ['b1', 'b2', 'b3']) {
      login(tmpHome, n, `tok-${n}`)
      saveProfile(tmpHome, n)
    }
    swapProfile(tmpHome, 'b1')
    const config = { enabled: true, threshold: 95, order: ['b3'], safeguardThreshold: null }
    const cache = {
      'b2|b2@example.com': { limits: [['5 giờ', 50, '']] },
      'b3|b3@example.com': { limits: [['5 giờ', 10, '']] },
    }
    // off: `order` decides
    assert.equal(findNextProfile(tmpHome, { config, cache }), 'b3')
    // round-robin: next name after the current one, wrapping around
    const rr = { enabled: true, mode: 'round-robin', pool: 'all' }
    assert.equal(findNextProfile(tmpHome, { config, cache, balance: rr }), 'b2')
    swapProfile(tmpHome, 'b3')
    assert.equal(findNextProfile(tmpHome, { config, cache, balance: rr }), 'b1')
    // least-used: lowest 5h usage, `order` ignored
    swapProfile(tmpHome, 'b1')
    const lu = { enabled: true, mode: 'least-used', pool: 'all' }
    assert.equal(findNextProfile(tmpHome, { config: { ...config, order: ['b2'] }, cache, balance: lu }), 'b3')
    // balance pool filters candidates; exhausted profiles are never picked
    addProfileTag(tmpHome, 'b2', 'team')
    assert.equal(findNextProfile(tmpHome, { config, cache, balance: { ...lu, pool: 'team' } }), 'b2')
    const full = { ...cache, 'b2|b2@example.com': { limits: [['5 giờ', 99, '']] } }
    assert.equal(findNextProfile(tmpHome, { config, cache: full, balance: { ...lu, pool: 'team' } }), null)
  })

  test('CLAUDE_CONFIG_DIR is honoured for the real home and run sessions are protected', () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DIR: process.env.CLAUDE_CONFIG_DIR }
    const restore = () => {
      for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['CLAUDE_CONFIG_DIR', saved.DIR]]) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    try {
      process.env.HOME = process.env.USERPROFILE = tmpHome // os.homedir() === tmpHome
      const custom = path.join(tmpHome, 'custom-claude')
      process.env.CLAUDE_CONFIG_DIR = custom
      const loginCustom = (account, token) => {
        fs.mkdirSync(custom, { recursive: true })
        fs.writeFileSync(path.join(custom, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${account}@example.com`, accountUuid: `uuid-${account}` } }))
        fs.writeFileSync(path.join(custom, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }))
      }
      loginCustom('a', 'tok-a')
      saveProfile(tmpHome, 'ca')
      loginCustom('b', 'tok-b')
      saveProfile(tmpHome, 'cb')
      swapProfile(tmpHome, 'ca')
      const live = JSON.parse(fs.readFileSync(path.join(custom, '.claude.json'), 'utf-8'))
      assert.equal(live.oauthAccount.emailAddress, 'a@example.com') // edited the dir Claude Code reads
      assert.ok(!fs.existsSync(path.join(tmpHome, '.claude.json'))) // not ~/.claude.json
      assert.equal(readCurrent(tmpHome), 'ca')

      // inside a `/profile run` session: swapping is refused, the pointer is the session's profile
      const sDir = prepareSession(tmpHome, 'cb')
      process.env.CLAUDE_CONFIG_DIR = sDir
      assert.equal(isolatedSession(tmpHome), 'cb')
      assert.equal(currentProfile(tmpHome), 'cb')
      assert.throws(() => swapProfile(tmpHome, 'ca'), /session cô lập/)

      // logging into another account inside the session must not overwrite profile cb on exit
      fs.writeFileSync(path.join(sDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com', accountUuid: 'uuid-x' } }))
      syncSessionBack(tmpHome, 'cb', sDir)
      assert.equal(profileEmail(tmpHome, 'cb'), 'b@example.com')
    } finally {
      restore()
    }
    // a home other than os.homedir() is never redirected
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, 'elsewhere')
    try {
      assert.equal(isolatedSession(tmpHome), null)
    } finally {
      restore()
    }
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
    assert.equal(loadWebhookConfig(tmpHome).discord, null) // merge-on-save used to bring it back
    assert.equal(maskUrl('https://api.telegram.org/bot123:SECRET/sendMessage'), 'https://api.telegram.org/…')
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
    try {
    assert.ok(dash.url.includes('3799'))

    // Verify GET /
    const htmlRes = await fetch(dash.url)
    assert.equal(htmlRes.status, 200)
    const htmlText = await htmlRes.text()
    assert.match(htmlText, /claude-swap/)
    assert.match(htmlText, /Web UI/)

    // the API needs the per-launch token; GET / alone must not reveal it
    assert.ok(!htmlText.includes(dash.token))
    assert.equal((await fetch(`${dash.url}/api/data`)).status, 401)
    const auth = { 'X-Dashboard-Token': dash.token }

    // Verify GET /api/data
    const dataRes = await fetch(`${dash.url}/api/data`, { headers: auth })
    assert.equal(dataRes.status, 200)
    const json = await dataRes.json()
    assert.equal(json.profiles.length, 2)

    // Verify POST /api/action swap
    const actRes = await fetch(`${dash.url}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ action: 'swap', profile: 'web_b' }),
    })
    assert.equal(actRes.status, 200)
    assert.equal(currentProfile(tmpHome), 'web_b')
    assert.match(dash.url, /^http:\/\/127\.0\.0\.1:/)

    // stats tab data: the swap above is in the history, a usage snapshot shows up per profile
    assert.match(htmlText, /id="tab-stats"/)
    assert.match(htmlText, /id="tab-features"/)

    // "All features" tab: whitelisted subcommands run in a child against this home
    const cli = async (args, password) => (await fetch(`${dash.url}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ action: 'cli', args, password }),
    })).json()
    const tagged = await cli(['tag', 'web_a', 'corp'])
    assert.equal(tagged.ok, true, tagged.output)
    assert.deepEqual(getProfileTags(tmpHome, 'web_a'), ['corp'])
    assert.equal((await cli(['run', 'web_a'])).ok, false) // interactive: CLI only
    assert.equal((await cli(['export', 'x.enc', '--password', 'pw'])).ok, false) // never on argv
    const enc = path.join(tmpHome, 'web.enc')
    const exported = await cli(['export', enc], 'pw-web')
    assert.equal(exported.ok, true, exported.output)
    assert.ok(fs.existsSync(enc))
    assert.equal((await cli(['import-enc', enc], 'wrong')).ok, false)
    assert.equal((await cli(['swap', 'web_a'])).ok, true)

    recordUsageSnapshot(tmpHome, 'web_a', 30, 50)
    const stats = getDashboardData(tmpHome)
    assert.equal(stats.swapHistory[0].to, 'web_a')
    assert.equal(stats.usageHistory.web_a.length, 1)
    assert.equal(stats.forecast.web_a.hasData, false)

    // CSRF: a cross-site "simple" POST (text/plain) is refused
    const csrf = await fetch(`${dash.url}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...auth },
      body: JSON.stringify({ action: 'delete', profile: 'web_a' }),
    })
    assert.equal(csrf.status, 415)
    assert.ok(listProfiles(tmpHome).includes('web_a'))

    // saving the form keeps auto-switch keys it does not show (order) and maps its short names
    const cfgFile = path.join(tmpHome, '.config', 'claude-cli-profiles', '.auto-switch.json')
    fs.writeFileSync(cfgFile, JSON.stringify({ enabled: true, threshold: 95, order: ['web_a'] }))
    await fetch(`${dash.url}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ action: 'save_config', auto: { enabled: true, threshold: 90, safeguard: 70, primary: 'web_a', pool: 'all' } }),
    })
    // webhook URLs are secrets: stored in full, shown masked, and an empty field keeps the stored one
    const hook = 'https://api.telegram.org/bot123:SECRET/sendMessage?chat_id=1'
    const saveHook = webhook => fetch(`${dash.url}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ action: 'save_config', webhook }),
    })
    await saveHook({ telegram: hook, evil: 'https://x.test', slack: 'javascript:alert(1)' })
    await saveHook({ telegram: '', discord: '' })
    assert.equal(loadWebhookConfig(tmpHome).telegram, hook)
    assert.equal(loadWebhookConfig(tmpHome).slack, null)
    assert.ok(!('evil' in JSON.parse(fs.readFileSync(path.join(tmpHome, '.config', 'claude-cli-profiles', '.webhook.json'), 'utf-8'))))
    const shown = await (await fetch(`${dash.url}/api/data`, { headers: auth })).text()
    assert.ok(!shown.includes('SECRET'))

    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'))
    assert.deepEqual(saved.order, ['web_a'])
    assert.equal(saved.safeguardThreshold, 70)
    assert.equal(saved.primaryProfile, 'web_a')
    assert.equal(saved.pool, null)
    } finally {
      dash.close() // a failed assertion must not leave the server holding the test process open
    }
  })

  test('a corrupt profile error never echoes the file content', () => {
    login(tmpHome, 'leak', 'tok-leak')
    saveProfile(tmpHome, 'leak')
    fs.writeFileSync(profilePath(tmpHome, 'leak'), '{"credentials": sk-ant-SECRET-TOKEN}')
    assert.throws(() => swapProfile(tmpHome, 'leak'), err => !err.message.includes('sk-ant') && /JSON/.test(err.message))
  })

  test('cross-platform helpers and quota labels', async () => {
    // a missing binary must not crash the process with an unhandled 'error' event
    spawnDetached('claude-swap-no-such-binary', [])
    await new Promise(r => setTimeout(r, 50))

    // model-specific labels containing digits must not be read as the 5h/7d quota
    login(tmpHome, 'q', 'tok-q')
    saveProfile(tmpHome, 'q')
    const cache = { 'q|q@example.com': { limits: [['5 giờ', 10, ''], ['7 ngày', 20, ''], ['7 ngày Opus 5.5', 99, '']] } }
    const snap = quotaSnapshot(tmpHome, cache, 'q')
    assert.equal(snap.util5h, 10)
    assert.equal(snap.util7d, 20)

    // run as the entry script: `web` dynamically imports web.js, which imports swap.js back;
    // a top-level await at the entry used to deadlock that and exit without doing anything
    const res = child_process.spawnSync(process.execPath, [fileURLToPath(new URL('../swap.js', import.meta.url)), 'web', 'stop'], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      encoding: 'utf-8',
      timeout: 10000,
    })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /Web Dashboard/)
  })
})

