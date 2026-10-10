import type { EngineInterface, Register } from 'claude-code'

const SUBCOMMANDS = new Set([
  'help',
  'list',
  'current',
  'usage',
  'folder',
  'save',
  'swap',
  'rename',
  'delete',
  'new',
  'auto',
  'bind',
  'unbind',
  'notify',
  'tag',
  'untag',
  'tags',
  'export',
  'import-enc',
  'history',
  'undo',
  'stats',
  'cooldown',
  'doctor',
  'statusline',
  'prompt',
  'temp',
  'untemp',
  'alias',
  'unalias',
  'aliases',
  'bind-branch',
  'unbind-branch',
  'branch-bindings',
  'forecast',
  'pick',
  'sync',
  'affinity',
  'unaffinity',
  'affinities',
  'cleanup',
  'lang',
  'language',
  'disable',
  'enable',
  'disabled',
  'add-token',
  'run',
  'version',
  'upgrade',
  'web',
  'dashboard',
  'balance',
  'webhook',
  'budget',
  'cost',
  'mask',
  'share',
  'completion',
  'repair',
  'schedule',
  'unschedule',
  'settings',
])
const USAGE =
  'Dùng: /profile | /profile list | /profile <tên|alias> | /profile pick | /profile web | /profile balance | /profile webhook | /profile lang [vi|en] | /profile run <tên> | /profile add-token <tok> | /profile disable <tên> | /profile auto | /profile sync | /profile upgrade'

// "" → help, "list" → list, "work" → swap work, "save work" → save work, "import ~/a b" → import ~/a b, "auto ..." → auto ...
function toArgv(args: string): string[] | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words[0] === '--help' || words[0] === '-h') return ['help']
  if (words.length === 1 && words[0] === 'statusline') return ['statusline', 'toggle'] // bare CLI `statusline` prints the shell-prompt string
  if (words[0] === 'version' || words[0] === '--version' || words[0] === '-v') return ['version']
  if (words[0] === 'web' || words[0] === 'dashboard') {
    if (words[1] === 'stop') return words
    if (!words.includes('--daemon')) return [words[0], '--daemon', ...words.slice(1)]
  }
  if (words[0] === 'import') {
    const path = words.slice(1).filter(w => w !== '--force').join(' ')
    if (!path) return undefined
    return ['import', path, ...(words.includes('--force') ? ['--force'] : [])]
  }
  if (SUBCOMMANDS.has(words[0])) return words
  if (words.length === 1) return ['swap', words[0]]
  if (words.length === 2 && words[1] === '--project') return ['swap', words[0], '--project']
  return undefined
}

// `$.env.get` wants a literal name at its call site (so a module's variables can be listed): pass the call itself
const safely = async (read: () => Promise<string | undefined>) => {
  try {
    return await read()
  } catch {
    return undefined
  }
}

// Where node may live when the host was started from a GUI (Desktop app from Finder/Dock) and PATH lacks the
// shell's additions; the login shell last, since it reads the user's profile (nvm, asdf…). The hooks module has no
// `process`: the environment comes through `$.env`.
async function nodeCandidates($: EngineInterface, script: string, argv: string[]): Promise<string[][]> {
  const home = (await safely(() => $.env.get('HOME'))) || (await safely(() => $.env.get('USERPROFILE'))) || ''
  const windows = (await safely(() => $.env.get('OS'))) === 'Windows_NT'
  const direct = [
    'node',
    'nodejs',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    `${home}/.volta/bin/node`,
    'C:\\Program Files\\nodejs\\node.exe',
  ].map(node => [node, script, ...argv])
  const shell = (await safely(() => $.env.get('SHELL'))) || '/bin/sh'
  return windows ? direct : [...direct, [shell, '-lc', 'exec node "$@"', 'node', script, ...argv]]
}

// the first launcher that worked, tried first from then on (a reload starts over)
let launcher = -1

// the plugin is the repo itself: swap.js sits next to .claude-plugin/ and hooks/
async function runSwap($: EngineInterface, argv: string[]) {
  const script = `${$.plugin.root}/swap.js`
  // the common case, `node` on PATH, costs no `$.env` lookups
  if (launcher <= 0) {
    try {
      const ran = await $.process.run(['node', script, ...argv])
      launcher = 0
      return ran
    } catch {}
  }
  const all = await nodeCandidates($, script, argv)
  const order = launcher > 0 ? [launcher, ...all.keys()].filter((i, n, a) => a.indexOf(i) === n) : [...all.keys()].slice(1)
  let failure: unknown
  for (const i of order) {
    try {
      const ran = await $.process.run(all[i])
      launcher = i
      return ran
    } catch (error) {
      failure = error
    }
  }
  throw new Error(
    `Không tìm thấy Node.js để chạy claude-swap (${String(failure)}). Cài Node.js 18+ rồi mở lại app; ` +
      'nếu đã cài qua nvm/Homebrew mà app Desktop vẫn không thấy, mở Claude từ terminal hoặc thêm node vào PATH hệ thống.'
  )
}

// What `statusLineData` in swap.js returns. Drawn as a coloured band above the prompt: the host's own status line
// takes plain text only (one colour, prefixed with the plugin name).
type StatusData = {
  profile: string
  rateLimited: boolean
  windows: { name: string; pct: number; left: string }[]
  warn: string
  stale?: string // '⚠ lỗi mạng', '⚠ cũ 2h': the numbers are not current
  suggest?: string // '→ minhvong 7d 31%': auto-switch is off and this profile is running out
  next?: string
  pace?: string // '7d ≈0.7%/h': the 7-day quota left per hour until its reset
  models?: string // 'Fable 7d 85% → minhvong 13%': a model's own 7-day limit running out
  recovered?: string[] // other profiles whose full window has reset since
  mode?: 'line' | 'band'
  text?: string
}

// The data swap.js last produced. `auto check` reprints it on every prompt, so only a change redraws.
// A reload loses it; the next prompt brings it back.
let status: StatusData | null = null
let lastRaw: string | undefined

function parseStatus(raw: string): StatusData | null {
  try {
    const data = JSON.parse(raw)
    return data && typeof data.profile === 'string' && Array.isArray(data.windows) ? data : null
  } catch {
    return null
  }
}

// `line` mode pins plain text under the prompt (the host drops the ESC byte of a pinned line, so no colour there);
// `band` (default) draws the coloured band above it. Whichever is not in use is cleared:
// a plugin's pinned text survives a reload, so the very first call must clear a line an older version left behind.
let pinned = true

// the suggestion last toasted, so one profile running out toasts once, not on every refresh
let lastSuggest = ''
let lastRecovered: string[] = []

function showStatus($: EngineInterface, raw: string) {
  lastRaw = raw
  status = parseStatus(raw)
  const suggest = status?.suggest || ''
  if (suggest && status?.next !== lastSuggest) $.ui.toast(`⚠ ${status!.profile} sắp hết quota ${suggest}: /profile ${status!.next}`)
  lastSuggest = suggest ? status!.next || '' : ''
  const recovered = status?.recovered || []
  for (const name of recovered) if (!lastRecovered.includes(name)) $.ui.toast(`✅ ${name} đã hồi quota: /profile ${name}`)
  lastRecovered = recovered
  const text = status && status.mode === 'line' ? status.text || undefined : undefined
  if (text !== undefined || pinned) $.ui.status(text)
  pinned = text !== undefined
  $.ui.invalidate('ui.render')
}

async function refreshStatus($: EngineInterface) {
  const { stdout } = await runSwap($, ['statusline', 'json'])
  const raw = stdout.trim()
  if (raw !== lastRaw) showStatus($, raw)
}

// Between prompts nothing else redraws: tick once a minute so the countdown moves and the quota (refetched by
// `statusline json` once USAGE_TTL has passed) stays current while the session sits idle. Started once per load.
const TICK_MS = 60_000
let ticking = false

// the band's "switch" button: the same swap `/profile <name>` does, then the band redraws for the new profile
async function swapTo($: EngineInterface, name: string) {
  const ran = await runSwap($, ['swap', name, '--no-color']) // a toast is plain text: `swap` output is coloured
  $.ui.toast(`${ran.stdout}${ran.stderr}`.trim().split('\n')[0] || name)
  await refreshStatus($)
}

// `/profile settings` editor: the rows swap.js reported, the edits not saved yet, and the last save's outcome
type Setting = { key: string; type: 'bool' | 'number' | 'choice' | 'text'; choices?: string[]; value: boolean | number | string; desc: string }
let settings: Setting[] = []
let draft: Record<string, Setting['value']> = {}
let settingsNote = ''

async function loadSettings($: EngineInterface) {
  const { stdout } = await runSwap($, ['settings', '--json'])
  settings = JSON.parse(stdout.trim())
  draft = {}
}

function edit($: EngineInterface, key: string, value: Setting['value']) {
  draft = { ...draft, [key]: value }
  settingsNote = ''
  $.ui.invalidate('ui.render')
}

// every changed row goes through `settings set`, which validates it; a refused one stays in the draft with its error
async function saveSettings($: EngineInterface) {
  const errors: string[] = []
  const changed = Object.entries(draft)
  for (const [key, value] of changed) {
    const text = value === true ? 'on' : value === false ? 'off' : String(value)
    const ran = await runSwap($, ['settings', 'set', key, text, '--no-color'])
    if (ran.exitCode !== 0) errors.push(`${key}: ${`${ran.stderr}${ran.stdout}`.trim().replace(/^❌ Lỗi: /, '')}`)
  }
  const failed = new Set(errors.map(e => e.split(':')[0]))
  const kept = Object.fromEntries(Object.entries(draft).filter(([k]) => failed.has(k)))
  await loadSettings($)
  draft = kept
  await refreshStatus($)
  const saved = changed.length - errors.length
  if (!errors.length) {
    $.ui.toast(saved ? `✅ Đã lưu ${saved} cài đặt` : 'Không có gì thay đổi')
    await $.ui.close({ id: 'settings' })
    return
  }
  settingsNote = `⚠ Đã lưu ${saved}/${changed.length}. ${errors.join(' · ')}`
  $.ui.invalidate('ui.render')
}

// commands that only read: they cannot change what the band shows, so they skip the extra `statusline json` process
const READ_ONLY = new Set([
  'help', 'list', 'current', 'usage', 'folder', 'history', 'stats', 'cooldown', 'forecast', 'doctor', 'tags',
  'aliases', 'disabled', 'branch-bindings', 'affinities', 'prompt', 'completion', 'version', 'share', 'export', 'web', 'dashboard',
])

// Same palette as the `/profile list` table (pctCode in swap.js): green < 50, yellow < 80, orange < 95, red above.
// Raw colours rather than theme keys, so the band and the table look alike on any theme.
const loadColor = (pct: number) => (pct >= 95 ? 'red' : pct >= 80 ? '#ff8700' : pct >= 50 ? 'yellow' : 'green')
const BAR_WIDTH = 8

// `/profile` help, row by row: a command (yellow in swap.js's formatHelpReport) with its description, or a title
const SGR = /\x1b\[[0-9;]*m/g
const HELP_ARGS = new Set(['', 'help', '--help', '-h'])
type HelpRow = { cmd?: string; desc?: string; title?: string }

function helpRows(text: string): HelpRow[] {
  return text.split('\n').map(line => {
    const m = line.match(/^\s*\x1b\[1;33m(\/profile[^\x1b]*)\x1b\[0m\s*(.*)$/)
    return m ? { cmd: m[1].trim(), desc: m[2].replace(SGR, '') } : { title: line.replace(SGR, '') }
  })
}

// what a click puts in the prompt box: the command up to its first placeholder ("/profile alias <tên> <p>" → "/profile alias ")
export function helpDraft(cmd: string): string {
  const words: string[] = []
  for (const w of cmd.split(/\s+/)) {
    if (/[<[|]/.test(w)) break
    words.push(w)
  }
  return `${words.join(' ')} `
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'profile',
      description: 'Đổi tài khoản Claude ngay trong session: /profile [tên | usage | auto | cooldown | doctor | temp | bind | history]',
      immediate: true, // runs at once even while a turn is streaming, instead of queueing behind it
    })

    try {
      const targetDir = e.cwd || '.'
      const boundRan = await runSwap($, ['bind', 'get', targetDir])
      const boundOut = boundRan.stdout.trim()
      const match = boundOut.match(/(?:đang liên kết với profile|bound to profile|profile):\s*([^\s()]+)/i)
      if (match && match[1]) {
        const boundProfile = match[1]
        const curRan = await runSwap($, ['current'])
        const curProfile = curRan.stdout.trim()
        if (boundProfile !== curProfile) {
          await runSwap($, ['swap', boundProfile, '--project'])
        }
      }
    } catch {}

    void refreshStatus($).catch(() => undefined)
    if (!ticking) {
      ticking = true
      $.clock.every(TICK_MS, () => void refreshStatus($).catch(() => undefined))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const ran = await runSwap($, ['auto', 'check'])
      const out = `${ran.stdout}${ran.stderr}`.trim()
      // the auto-swap notice would otherwise show nowhere: the hook only reads the [status] line
      const swapped = out.match(/^\[auto-swap\] (🔀 .*)$/m)
      if (swapped) $.ui.toast(swapped[1])
      const line = out.match(/^\[status\] ?(.*)$/m)
      if (line && line[1].trim() !== lastRaw) showStatus($, line[1].trim())
    } catch {}

    return next(e)
  })

  // coloured status band: ● profile │ 5h [███░░░░░] 34% ⏳2h10m │ 7d [██████░░] 73% ⏳3d4h │ ⚠ 5h ~12p
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (!status || status.mode === 'line' || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const suggested = status.next
    // a narrow terminal drops the bars and countdowns: "● work │ 5h 34% │ 7d 73%"
    const width = status.text ? status.text.length : status.profile.length + 4 + status.windows.length * 28 // ≈ one full window
    const compact = typeof e.props.bodyColumns === 'number' && e.props.bodyColumns < width + 8
    const sep = <Text color="gray"> │ </Text>
    return (
      <Box>
        <Text color="green" bold>● {status.profile}</Text>
        {status.rateLimited ? <Text color="yellow" bold> ⏳ 429</Text> : null}
        {status.windows.map(w => {
          const filled = Math.round((w.pct / 100) * BAR_WIDTH)
          const color = loadColor(w.pct)
          return (
            <Box key={w.name}>
              {sep}
              <Text color="cyan" bold>{w.name} </Text>
              {compact ? null : <Text color="gray">[</Text>}
              {compact ? null : <Text color={color} bold>{'█'.repeat(filled)}</Text>}
              {compact ? null : <Text color="gray">{'░'.repeat(BAR_WIDTH - filled)}] </Text>}
              <Text color={color} bold>{String(w.pct)}%</Text>
              {w.pct >= 80 && !compact ? <Text> 🔥</Text> : null}
              {w.left && !compact ? <Text color="cyan"> ⏳{w.left}</Text> : null}
            </Box>
          )
        })}
        {[status.warn, status.pace, status.models, status.stale, status.suggest].filter(Boolean).map(note => (
          <Box key={note}>{sep}<Text color="yellow" bold>{note}</Text></Box>
        ))}
        {suggested ? (
          <Box>
            <Text> </Text>
            <Button key="swap-next" hotkey="s" plain onPress={() => void swapTo($, suggested).catch(() => undefined)}>
              {`⇄ ${suggested}`}
            </Button>
          </Box>
        ) : null}
      </Box>
    )
  })

  // `/profile` help: every command is a button that puts it in the prompt box, ready to complete and send
  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
    const { command, args, text, isErrored } = e.props
    if (command !== 'profile' || isErrored || !HELP_ARGS.has(args.trim().split(/\s+/)[0])) return next(e)
    const rows = helpRows(text)
    if (!rows.some(r => r.cmd)) return next(e) // not the help after all (a format change, no match): draw it as text
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rows.map((r, i) =>
          r.cmd ? (
            <Box key={`row${i}`}>
              <Text>  </Text>
              <Button key={`help:${r.cmd}`} plain onPress={() => void $.prompt.fill({ text: helpDraft(r.cmd!) }).catch(() => undefined)}>
                <Text color="yellow" bold>{r.cmd.padEnd(28)}</Text>
              </Button>
              <Text> {r.desc}</Text>
            </Box>
          ) : (
            <Text key={`row${i}`} color="cyan" bold>{r.title || ' '}</Text>
          )
        )}
        <Text dimColor>💡 Bấm vào một lệnh để đưa nó xuống ô nhập.</Text>
      </Box>
    )
  })

  // the settings editor: a toggle for on/off, a button cycling through choices, a field for numbers and text
  on('ui.render', { component: 'Pane', requestId: 'settings' }, ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const width = Math.max(...settings.map(r => r.key.length), 8)
    const shown = (v: Setting['value']) => (v === '' ? '—' : String(v))
    return (
      <Box flexDirection="column">
        {settings.map(r => {
          const value = r.key in draft ? draft[r.key] : r.value
          const changed = r.key in draft && draft[r.key] !== r.value
          const control =
            r.type === 'bool' ? (
              <Button key={`set:${r.key}`} plain onPress={() => edit($, r.key, !value)}>
                <Text color={value ? 'green' : 'gray'} bold>{value ? '● on ' : '○ off'}</Text>
              </Button>
            ) : r.type === 'choice' ? (
              <Button
                key={`set:${r.key}`}
                plain
                onPress={() => {
                  const list = r.choices || []
                  edit($, r.key, list[(list.indexOf(String(value)) + 1) % list.length] ?? '')
                }}
              >
                <Text color="cyan" bold>{`⇄ ${shown(value)}`}</Text>
              </Button>
            ) : (
              <Input key={`set:${r.key}`} value={String(value)} placeholder="—" onInput={v => edit($, r.key, v)} onSubmit={v => edit($, r.key, v)} />
            )
          return (
            <Box key={`row:${r.key}`}>
              <Text color={changed ? 'yellow' : 'white'} bold>{`${changed ? '* ' : '  '}${r.key.padEnd(width)}  `}</Text>
              {control}
              <Text dimColor>{`  ${r.desc}`}</Text>
            </Box>
          )
        })}
        {settingsNote ? <Text color="yellow">{settingsNote}</Text> : null}
        <Box>
          <Button key="settings-save" variant="primary" hotkey="s" onPress={() =>
              void saveSettings($).catch(err => {
                settingsNote = `⚠ ${String(err)}`
                $.ui.invalidate('ui.render')
              })
            }>
            💾 Lưu
          </Button>
          <Text> </Text>
          <Button key="settings-cancel" role="dismiss" onPress={() => void $.ui.close({ id: 'settings' })}>
            Hủy
          </Button>
          <Text dimColor>{`  ${Object.keys(draft).length} thay đổi chưa lưu`}</Text>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'profile' }, async ($, e) => {
    const argv = toArgv(e.args)
    if (!argv) return { text: USAGE }

    // bare `/profile settings` opens the editor; with arguments (`settings set k v`) it runs as any command
    if (argv[0] === 'settings' && argv.length === 1) {
      await loadSettings($)
      settingsNote = ''
      const opened = await $.ui.open({ id: 'settings', title: 'claude-swap · Cài đặt', focus: true, closeOnEscape: true })
      if (opened.isPlaced) return { text: '⚙️ Đã mở bảng cài đặt: sửa rồi bấm 💾 Lưu (phím s), Esc để đóng.' }
      await $.ui.close({ id: 'settings' })
    }

    const ran = await runSwap($, argv)
    if (!READ_ONLY.has(argv[0]) || ran.exitCode !== 0) await refreshStatus($)
    const out = `${ran.stdout}${ran.stderr}`.trim()
    // the new version is only on disk: have the host re-read plugins once this command has returned
    if (argv[0] === 'upgrade' && ran.exitCode === 0) {
      $.clock.after(500, () => void $.command.run({ command: 'reload-plugins' }).catch(() => undefined))
      return { text: `${out}\n🔄 Đang nạp lại plugin (/reload-plugins)...`.trim() }
    }
    // the host draws the first line beside its own prefix, which would push a table's header out of line
    if (out) return { text: argv[0] === 'list' || argv[0] === 'usage' ? `\n${out}` : out }

    return { text: argv[0] === 'list' ? 'Chưa có profile nào. Tạo bằng: /profile new <tên>' : 'OK' }
  })
}
