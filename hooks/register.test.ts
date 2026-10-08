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
    return argv[2] === 'current' ? ok('work\n') : ok("Đã chuyển sang 'work'.\n")
  })
  on('ui.status', (_$, { text }) => {
    statuses.push(text)
    return { value: undefined }
  })

  const ran = await $.command.run({ command: 'profile', args: 'work' })

  expect(ran.text).toContain("'work'")
  expect(calls).toEqual([['swap', 'work'], ['current']])
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

  expect((await $.command.run({ command: 'profile', args: '' })).text).toContain('Chưa có profile')
  await $.command.run({ command: 'profile', args: 'save work --force' })
  await $.command.run({ command: 'profile', args: 'new personal' })
  await $.command.run({ command: 'profile', args: 'auto threshold 80' })
  await $.command.run({ command: 'profile', args: 'auto order p1,p2' })
  expect((await $.command.run({ command: 'profile', args: 'a b' })).text).toContain('Dùng:')

  expect(calls).toEqual([
    ['list'],
    ['current'],
    ['save', 'work', '--force'],
    ['current'],
    ['new', 'personal'],
    ['current'],
    ['auto', 'threshold', '80'],
    ['current'],
    ['auto', 'order', 'p1,p2'],
    ['current'],
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
      return ok("[auto-swap] Đã tự động chuyển từ 'work' sang 'personal' (mức dùng: 96% >= ngưỡng 95%).\n")
    }
    if (argv[2] === 'current') {
      return ok('personal\n')
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

  expect(calls).toEqual([['auto', 'check'], ['current']])
  expect(statuses).toEqual(['● personal'])
})
