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
  profileEmail,
  importProfiles,
  parseLimits,
  profileUsage,
  usageRows,
  profileListReport,
  runCli,
  SwapError,
  ProfileExists,
} from '../swap.js'

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

  test('profileListReport formats active and inactive indicators', () => {
    login(tmpHome, 'a', 'tok-a')
    saveProfile(tmpHome, 'work')
    login(tmpHome, 'b', 'tok-b')
    saveProfile(tmpHome, 'personal')

    const out = profileListReport(tmpHome, false)
    assert.ok(out.includes('⚪ work'))
    assert.ok(out.includes('🟢 personal (Active)'))
    assert.ok(out.includes('👤 b@example.com'))
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
})
