import { expect, test } from 'claude-code/testing'

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('/profile <name> swaps through swap.js and shows it on the status line', async ($, on) => {
  const calls: string[][] = []
  const scripts = new Set<string>()
  const statuses: (string | undefined)[] = []
  on('process.run', async (_$, { argv }) => {
    scripts.add(argv[1].split('/').pop() ?? '')
    calls.push(argv.slice(2))
    return argv[2] === 'statusline' ? ok('● work\n') : ok("Đã chuyển sang 'work'.\n")
  })
  on('ui.status', (_$, { text }) => {
    statuses.push(text)
    return { value: undefined }
  })

  const ran = await $.command.run({ command: 'profile', args: 'work' })

  expect(ran.text).toContain("'work'")
  expect(calls).toEqual([['swap', 'work'], ['statusline', 'text']])
  expect([...scripts]).toEqual(['swap.js'])
  expect(statuses).toEqual(['● work'])
})

test('/profile maps subcommands including auto and rejects junk', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('')
  })
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
    ['statusline', 'text'],
    ['list'],
    ['statusline', 'text'],
    ['save', 'work', '--force'],
    ['statusline', 'text'],
    ['new', 'personal'],
    ['statusline', 'text'],
    ['auto', 'threshold', '80'],
    ['statusline', 'text'],
    ['auto', 'order', 'p1,p2'],
    ['statusline', 'text'],
  ])
})

test('/profile import keeps a path with spaces as one argument', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('Đã nhập: w')
  })
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'import /home/me/old profiles --force' })
  expect(calls[0]).toEqual(['import', '/home/me/old profiles', '--force'])
  expect((await $.command.run({ command: 'profile', args: 'import' })).text).toContain('Dùng:')
})

test('prompt.submit automatically checks and switches profile if limit exceeded', async ($, on) => {
  const calls: string[][] = []
  const statuses: (string | undefined)[] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    if (argv[2] === 'auto' && argv[3] === 'check') {
      return ok("[auto-swap] Đã tự động chuyển từ 'work' sang 'personal' (mức dùng: 96% >= ngưỡng 95%).\n[status] ● personal │ 5h [░░░░░░░░] 0%\n")
    }
    return ok('')
  })
  on('ui.status', (_$, { text }) => {
    statuses.push(text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  // Submit prompt
  await $.prompt.submit({ text: 'test prompt' })

  expect(calls).toEqual([['auto', 'check']]) // the status text rides on the auto check output: no second process on the prompt path
  expect(statuses).toEqual(['● personal │ 5h [░░░░░░░░] 0%'])
})

test('session.start automatically switches to bound profile if different from current', async ($, on) => {
  const calls: string[][] = []
  const statuses: (string | undefined)[] = []
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
  on('ui.status', (_$, { text }) => {
    statuses.push(text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj' })

  expect(calls).toEqual([
    ['bind', 'get', '/proj'],
    ['current'],
    ['swap', 'work', '--project'],
    ['statusline', 'text'],
  ])
})

test('/profile dispatches advanced subcommands: bind, tag, notify, history, stats, export', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'bind work' })
  await $.command.run({ command: 'profile', args: 'tag work company' })
  await $.command.run({ command: 'profile', args: 'notify on' })
  await $.command.run({ command: 'profile', args: 'history 5' })
  await $.command.run({ command: 'profile', args: 'stats' })
  await $.command.run({ command: 'profile', args: 'export backup.enc --password 123' })

  expect(calls).toEqual([
    ['bind', 'work'],
    ['statusline', 'text'],
    ['tag', 'work', 'company'],
    ['statusline', 'text'],
    ['notify', 'on'],
    ['statusline', 'text'],
    ['history', '5'],
    ['statusline', 'text'],
    ['stats'],
    ['statusline', 'text'],
    ['export', 'backup.enc', '--password', '123'],
    ['statusline', 'text'],
  ])
})

test('/profile dispatches Batch 2 subcommands: cooldown, doctor, statusline, temp, untemp', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'cooldown' })
  await $.command.run({ command: 'profile', args: 'doctor' })
  await $.command.run({ command: 'profile', args: 'statusline' })
  await $.command.run({ command: 'profile', args: 'temp work 30m' })
  await $.command.run({ command: 'profile', args: 'untemp' })

  expect(calls).toEqual([
    ['cooldown'],
    ['statusline', 'text'],
    ['doctor'],
    ['statusline', 'text'],
    ['statusline', 'toggle'],
    ['statusline', 'text'],
    ['temp', 'work', '30m'],
    ['statusline', 'text'],
    ['untemp'],
    ['statusline', 'text'],
  ])
})

test('/profile dispatches Batch 3 subcommands: alias, bind-branch, forecast, pick, sync, affinity, cleanup', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
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
    ['statusline', 'text'],
    ['bind-branch', 'feat/*', 'work'],
    ['statusline', 'text'],
    ['forecast'],
    ['statusline', 'text'],
    ['pick'],
    ['statusline', 'text'],
    ['sync', 'push'],
    ['statusline', 'text'],
    ['affinity', 'opus', 'work'],
    ['statusline', 'text'],
    ['cleanup'],
    ['statusline', 'text'],
  ])
})

test('/profile dispatches lang subcommands', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'lang' })
  await $.command.run({ command: 'profile', args: 'lang en' })
  await $.command.run({ command: 'profile', args: 'language vi' })

  expect(calls).toEqual([
    ['lang'],
    ['statusline', 'text'],
    ['lang', 'en'],
    ['statusline', 'text'],
    ['language', 'vi'],
    ['statusline', 'text'],
  ])
})

test('/profile dispatches new Batch 4 subcommands: disable, enable, disabled, add-token, run', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
  on('ui.status', () => ({ value: undefined }))

  await $.command.run({ command: 'profile', args: 'disable work' })
  await $.command.run({ command: 'profile', args: 'enable work' })
  await $.command.run({ command: 'profile', args: 'disabled' })
  await $.command.run({ command: 'profile', args: 'add-token sk-ant-api03-test my-api' })
  await $.command.run({ command: 'profile', args: 'run work' })

  expect(calls).toEqual([
    ['disable', 'work'],
    ['statusline', 'text'],
    ['enable', 'work'],
    ['statusline', 'text'],
    ['disabled'],
    ['statusline', 'text'],
    ['add-token', 'sk-ant-api03-test', 'my-api'],
    ['statusline', 'text'],
    ['run', 'work'],
    ['statusline', 'text'],
  ])
})

test('/profile dispatches new Batch 5 subcommands: web, balance, webhook, budget, mask, share, completion', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('OK')
  })
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
    ['statusline', 'text'],
    ['balance', 'status'],
    ['statusline', 'text'],
    ['webhook', 'status'],
    ['statusline', 'text'],
    ['budget', 'status'],
    ['statusline', 'text'],
    ['mask', 'on'],
    ['statusline', 'text'],
    ['share', 'out.json'],
    ['statusline', 'text'],
    ['completion', 'bash'],
    ['statusline', 'text'],
  ])
})




test('/profile upgrade reloads plugins afterwards, and only when the upgrade succeeded', async ($, on) => {
  const reloads: string[] = []
  let exitCode = 0
  on('process.run', async (_$, { argv }) => ({
    value: { exitCode: argv[2] === 'upgrade' ? exitCode : 0, stdout: 'ok\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
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
  on('ui.status', () => ({ value: undefined }))
  expect((await $.command.run({ command: 'profile', args: 'list' })).text).toBe('\nHEAD\nrow')

})

test('prompt.submit redraws the status line only when its text changes', async ($, on) => {
  let check = '✅ ok\n[status] ● work │ ⚠ 5h ~12p'
  const statuses: (string | undefined)[] = []
  on('process.run', async () => ok(check))
  on('ui.status', (_$, { text }) => {
    statuses.push(text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  await $.prompt.submit({ text: 'hi' })
  await $.prompt.submit({ text: 'again' }) // same text: no redraw
  check = '✅ ok\n[status] ● work'
  await $.prompt.submit({ text: 'later' })
  check = '✅ ok\n[status]' // `/profile statusline off`
  await $.prompt.submit({ text: 'off' })
  check = 'ℹ️ skipped' // no status line in the output: leave the line alone
  await $.prompt.submit({ text: 'skip' })

  expect(statuses).toEqual(['● work │ ⚠ 5h ~12p', '● work', undefined])
})

test('bare /profile statusline toggles, and the list keeps its colour', async ($, on) => {
  const calls: string[][] = []
  const envs: unknown[] = []
  on('process.run', async (_$, { argv, init }) => {
    calls.push(argv.slice(2))
    envs.push(init?.env)
    return ok('')
  })
  on('ui.status', () => ({ value: undefined }))
  await $.command.run({ command: 'profile', args: 'statusline' })
  await $.command.run({ command: 'profile', args: 'statusline off' })
  expect(calls[0]).toEqual(['statusline', 'toggle'])
  expect(calls[2]).toEqual(['statusline', 'off'])
  expect(envs.every(e => e === undefined)).toBe(true) // no NO_COLOR: escape codes are meant to be drawn
})
