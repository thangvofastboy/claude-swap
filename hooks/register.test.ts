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

test('/profile maps subcommands and rejects junk', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, { argv }) => {
    calls.push(argv.slice(2))
    return ok('')
  })
  on('ui.status', () => ({ value: undefined }))

  expect((await $.command.run({ command: 'profile', args: '' })).text).toContain('Chưa có profile')
  await $.command.run({ command: 'profile', args: 'save work --force' })
  await $.command.run({ command: 'profile', args: 'new personal' })
  expect((await $.command.run({ command: 'profile', args: 'a b' })).text).toContain('Dùng:')

  expect(calls).toEqual([
    ['list'],
    ['current'],
    ['save', 'work', '--force'],
    ['current'],
    ['new', 'personal'],
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
