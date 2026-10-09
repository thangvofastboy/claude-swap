import { expect, test } from 'claude-code/testing'

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// what swap.js prints for the status line: `statusline json` and the `[status]` line of `auto check`
const data = (profile: string, pct = 34, warn = '') =>
  JSON.stringify({ profile, mode: 'band', rateLimited: false, windows: [{ name: '5h', pct, left: '2h10m' }, { name: '7d', pct: 90, left: '3d4h' }], warn })
const WORK = data('work')
const PERSONAL = data('personal', 0)

// draws the band above the prompt the way the terminal would and returns what it shows
async function band($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'profile-swap', surface, component: 'AbovePrompt', props: { hasSurvey: false } })
  return ui
}

async function expectBand($: any, profile: string) {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: profile })).toBeDefined()
    await ui.unmount()
  }
}

test('/profile <name> swaps through swap.js and shows it on the status line', async ($, on) => {
  const calls: string[][] = []
  const scripts = new Set<string>()
  let redraws = 0
  on('process.run', async (_$, { argv }) => {
    scripts.add(argv[1].split('/').pop() ?? '')
    calls.push(argv.slice(2))
    return argv[2] === 'statusline' ? ok(`${WORK}\n`) : ok("Đã chuyển sang 'work'.\n")
  })
  on('ui.invalidate', () => {
    redraws++
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  const ran = await $.command.run({ command: 'profile', args: 'work' })

  expect(ran.text).toContain("'work'")
  expect(calls).toEqual([['swap', 'work'], ['statusline', 'json']])
  expect([...scripts]).toEqual(['swap.js'])
  expect(redraws).toBe(1)
  await expectBand($, 'work')
})

test('/profile maps subcommands including auto and rejects junk', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  // empty args should invoke help
  await $.command.run({ command: 'profile', args: '' })
  await $.command.run({ command: 'profile', args: 'list' })
  await $.command.run({ command: 'profile', args: 'save work --force' })
  await $.command.run({ command: 'profile', args: 'new personal' })
  await $.command.run({ command: 'profile', args: 'auto threshold 80' })
  await $.command.run({ command: 'profile', args: 'auto order p1,p2' })
  expect((await $.command.run({ command: 'profile', args: 'a b' })).text).toContain('Dùng:')

  expect(calls).toEqual([
    ['help'],
    ['list'],
    ['save', 'work', '--force'],
    ['statusline', 'json'],
    ['new', 'personal'],
    ['statusline', 'json'],
    ['auto', 'threshold', '80'],
    ['statusline', 'json'],
    ['auto', 'order', 'p1,p2'],
    ['statusline', 'json'],
  ])
})

test('/profile import keeps a path with spaces as one argument', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('Đã nhập: w')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'import /home/me/old profiles --force' })
  expect(calls[0]).toEqual(['import', '/home/me/old profiles', '--force'])
  expect((await $.command.run({ command: 'profile', args: 'import' })).text).toContain('Dùng:')
})

test('prompt.submit automatically checks and switches profile if limit exceeded', async ($, on) => {
  const calls: string[][] = []
  let redraws = 0
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    if (argv[2] === 'auto' && argv[3] === 'check') {
      return ok(`[auto-swap] Đã tự động chuyển từ 'work' sang 'personal' (mức dùng: 96% >= ngưỡng 95%).\n[status] ${PERSONAL}\n`)
    }
    return ok('')
  })
  on('ui.invalidate', () => {
    redraws++
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  // Submit prompt
  await $.prompt.submit({ text: 'test prompt' })

  expect(calls).toEqual([['auto', 'check']]) // the status text rides on the auto check output: no second process on the prompt path
  expect(redraws).toBe(1)
  await expectBand($, 'personal')
})

test('session.start automatically switches to bound profile if different from current', async ($, on) => {
  const calls: string[][] = []
  let redraws = 0
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    if (argv[2] === 'bind' && argv[3] === 'get') {
      return ok("Thư mục '/proj' đang liên kết với profile: work (local)\n")
    }
    if (argv[2] === 'current') {
      return ok('personal\n')
    }
    if (argv[2] === 'statusline') {
      return ok('● personal\n')
    }
    if (argv[2] === 'swap') {
      return ok("Đã chuyển sang 'work'.\n")
    }
    return ok('')
  })
  on('ui.invalidate', () => {
    redraws++
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj' })

  expect(calls).toEqual([
    ['bind', 'get', '/proj'],
    ['current'],
    ['swap', 'work', '--project'],
    ['statusline', 'json'],
  ])
})

test('/profile dispatches advanced subcommands: bind, tag, notify, history, stats, export', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'bind work' })
  await $.command.run({ command: 'profile', args: 'tag work company' })
  await $.command.run({ command: 'profile', args: 'notify on' })
  await $.command.run({ command: 'profile', args: 'history 5' })
  await $.command.run({ command: 'profile', args: 'stats' })
  await $.command.run({ command: 'profile', args: 'export backup.enc --password 123' })

  expect(calls).toEqual([
    ['bind', 'work'],
    ['statusline', 'json'],
    ['tag', 'work', 'company'],
    ['statusline', 'json'],
    ['notify', 'on'],
    ['statusline', 'json'],
    ['history', '5'],
    ['stats'],
    ['export', 'backup.enc', '--password', '123'],
  ])
})

test('/profile dispatches Batch 2 subcommands: cooldown, doctor, statusline, temp, untemp', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'cooldown' })
  await $.command.run({ command: 'profile', args: 'doctor' })
  await $.command.run({ command: 'profile', args: 'statusline' })
  await $.command.run({ command: 'profile', args: 'temp work 30m' })
  await $.command.run({ command: 'profile', args: 'untemp' })

  expect(calls).toEqual([
    ['cooldown'],
    ['doctor'],
    ['statusline', 'toggle'],
    ['statusline', 'json'],
    ['temp', 'work', '30m'],
    ['statusline', 'json'],
    ['untemp'],
    ['statusline', 'json'],
  ])
})

test('/profile dispatches Batch 3 subcommands: alias, bind-branch, forecast, pick, sync, affinity, cleanup', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'alias w work' })
  await $.command.run({ command: 'profile', args: 'bind-branch feat/* work' })
  await $.command.run({ command: 'profile', args: 'forecast' })
  await $.command.run({ command: 'profile', args: 'pick' })
  await $.command.run({ command: 'profile', args: 'sync push' })
  await $.command.run({ command: 'profile', args: 'affinity opus work' })
  await $.command.run({ command: 'profile', args: 'cleanup' })

  expect(calls).toEqual([
    ['alias', 'w', 'work'],
    ['statusline', 'json'],
    ['bind-branch', 'feat/*', 'work'],
    ['statusline', 'json'],
    ['forecast'],
    ['pick'],
    ['statusline', 'json'],
    ['sync', 'push'],
    ['statusline', 'json'],
    ['affinity', 'opus', 'work'],
    ['statusline', 'json'],
    ['cleanup'],
    ['statusline', 'json'],
  ])
})

test('/profile dispatches lang subcommands', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'lang' })
  await $.command.run({ command: 'profile', args: 'lang en' })
  await $.command.run({ command: 'profile', args: 'language vi' })

  expect(calls).toEqual([
    ['lang'],
    ['statusline', 'json'],
    ['lang', 'en'],
    ['statusline', 'json'],
    ['language', 'vi'],
    ['statusline', 'json'],
  ])
})

test('/profile dispatches new Batch 4 subcommands: disable, enable, disabled, add-token, run', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'disable work' })
  await $.command.run({ command: 'profile', args: 'enable work' })
  await $.command.run({ command: 'profile', args: 'disabled' })
  await $.command.run({ command: 'profile', args: 'add-token sk-ant-api03-test my-api' })
  await $.command.run({ command: 'profile', args: 'run work' })

  expect(calls).toEqual([
    ['disable', 'work'],
    ['statusline', 'json'],
    ['enable', 'work'],
    ['statusline', 'json'],
    ['disabled'],
    ['add-token', 'sk-ant-api03-test', 'my-api'],
    ['statusline', 'json'],
    ['run', 'work'],
    ['statusline', 'json'],
  ])
})

test('/profile dispatches new Batch 5 subcommands: web, balance, webhook, budget, mask, share, completion', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'web' })
  await $.command.run({ command: 'profile', args: 'balance status' })
  await $.command.run({ command: 'profile', args: 'webhook status' })
  await $.command.run({ command: 'profile', args: 'budget status' })
  await $.command.run({ command: 'profile', args: 'mask on' })
  await $.command.run({ command: 'profile', args: 'share out.json' })
  await $.command.run({ command: 'profile', args: 'completion bash' })

  expect(calls).toEqual([
    ['web', '--daemon'],
    ['balance', 'status'],
    ['statusline', 'json'],
    ['webhook', 'status'],
    ['statusline', 'json'],
    ['budget', 'status'],
    ['statusline', 'json'],
    ['mask', 'on'],
    ['statusline', 'json'],
    ['share', 'out.json'],
    ['completion', 'bash'],
  ])
})




test('/profile upgrade reloads plugins afterwards, and only when the upgrade succeeded', async ($, on) => {
  const reloads: string[] = []
  let exitCode = 0
  on('process.run', async (_$, { argv }) => ({
    value: { exitCode: argv[2] === 'upgrade' ? exitCode : 0, stdout: 'ok\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined })) // fire the timer at once
  on('command.run', { command: 'reload-plugins' }, (_$, e) => {
    reloads.push(e.command)
    return { value: { text: 'reloaded' } }
  })

  const ran = await $.command.run({ command: 'profile', args: 'upgrade' })
  expect(ran.text).toContain('reload-plugins')
  await new Promise(r => setTimeout(r, 50))
  expect(reloads).toEqual(['reload-plugins'])

  exitCode = 1
  await $.command.run({ command: 'profile', args: 'upgrade' })
  await new Promise(r => setTimeout(r, 50))
  expect(reloads).toEqual(['reload-plugins'])
})

test('/profile list starts on its own line so the table lines up', async ($, on) => {
  on('process.run', async (_$, { argv }) => {
    return ok(argv[2] === 'list' ? 'HEAD\nrow\n' : '')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  expect((await $.command.run({ command: 'profile', args: 'list' })).text).toBe('\nHEAD\nrow')

})

test('prompt.submit redraws the status band only when its data changes', async ($, on) => {
  let check = `✅ ok\n[status] ${data('work', 34, '⚠ 5h ~12p')}`
  let redraws = 0
  on('process.run', async () => ok(check))
  on('ui.invalidate', () => {
    redraws++
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({})) // the engine's own (empty) band, drawn when the plugin has nothing to show

  await $.prompt.submit({ text: 'hi' })
  await $.prompt.submit({ text: 'again' }) // same data: no redraw
  expect(redraws).toBe(1)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: '⚠ 5h ~12p' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /34%/ })).toBeDefined()
  await ui.unmount()

  check = `✅ ok\n[status] ${WORK}`
  await $.prompt.submit({ text: 'later' })
  expect(redraws).toBe(2)
  check = '✅ ok\n[status] null' // `/profile statusline off`
  await $.prompt.submit({ text: 'off' })
  expect(redraws).toBe(3)
  const hidden = await band($)
  expect(await hidden.find({ type: 'Text', text: 'work' })).toBeUndefined()
  await hidden.unmount()
  check = 'ℹ️ skipped' // no [status] line in the output: leave the band alone
  await $.prompt.submit({ text: 'skip' })
  expect(redraws).toBe(3)
})

test('bare /profile statusline toggles, and the list keeps its colour', async ($, on) => {
  const calls: string[][] = []
  const envs: unknown[] = []
  on('process.run', async (_$, { argv, init }) => {
    calls.push(argv.slice(2))
    envs.push(init?.env)
    return ok('')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  await $.command.run({ command: 'profile', args: 'statusline' })
  await $.command.run({ command: 'profile', args: 'statusline off' })
  await $.command.run({ command: 'profile', args: 'rename a b' })
  expect(calls[0]).toEqual(['statusline', 'toggle'])
  expect(calls[2]).toEqual(['statusline', 'off'])
  expect(calls[4]).toEqual(['rename', 'a', 'b']) // a known subcommand, not "swap to a profile called rename"
  expect(envs.every(e => e === undefined)).toBe(true) // no NO_COLOR: escape codes are meant to be drawn
})

test('read-only commands do not spawn a second process for the status band', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok(argv[2] === 'statusline' ? WORK : 'out')
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  await $.command.run({ command: 'profile', args: 'list' })
  await $.command.run({ command: 'profile', args: 'history 5' })
  expect(calls).toEqual([['list'], ['history', '5']])
  await $.command.run({ command: 'profile', args: 'undo' }) // may change the profile: refresh
  expect(calls[2]).toEqual(['undo'])
  expect(calls[3]).toEqual(['statusline', 'json'])
})

test('line mode pins plain text under the prompt, band mode clears it and draws above', async ($, on) => {
  const pinned: (string | undefined)[] = []
  let out = ''
  const line = (mode: string) =>
    JSON.stringify({ profile: 'work', mode, rateLimited: false, windows: [], warn: '', text: '● work' })
  on('process.run', async () => ok(out))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', (_$, { text }) => {
    pinned.push(text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))

  out = `[status] ${line('line')}`
  await $.prompt.submit({ text: 'a' })
  expect(pinned).toEqual(['● work'])
  const none = await band($)
  expect(await none.find({ type: 'Text', text: 'work' })).toBeUndefined() // no band in line mode
  await none.unmount()

  out = `[status] ${line('band')}`
  await $.prompt.submit({ text: 'b' })
  expect(pinned).toEqual(['● work', undefined]) // the pinned line is cleared
  await expectBand($, 'work')
})
