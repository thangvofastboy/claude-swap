import type { EngineInterface, Register } from 'claude-code'

const SUBCOMMANDS = new Set([
  'help',
  'list',
  'dedupe',
  'note',
  'restore',
  'export-config',
  'import-config',
  'verify',
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
  'autoupdate',
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
  'overview',
  'panel',
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
  // `<name> current`: this session only. A live session shares the config files with the others, so it is answered
  // with the terminal command for an isolated one (`run <name>`) instead of a swap
  if (words.length === 2 && words[1] === 'current') return ['run', words[0]]
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
// commands that run `claude` themselves (repair, upgrade) or talk to a remote: past the 30 s default
const SLOW = new Set(['repair', 'upgrade', 'autoupdate', 'sync', 'run'])

async function runSwap($: EngineInterface, argv: string[], stdin?: string) {
  // a swap must say which session asks, or swap.js counts this very session as "another one" on the profile
  if (argv[0] === 'swap' && !argv.includes('--session')) {
    const sid = await $.session.id().catch(() => '')
    if (sid) argv = [...argv, '--session', sid]
  }
  const script = `${$.plugin.root}/swap.js`
  const init = { timeoutMs: SLOW.has(argv[0]) ? 600_000 : 30_000, ...(stdin === undefined ? {} : { stdin }) }
  // the common case, `node` on PATH, costs no `$.env` lookups
  // a rejection that took the whole timeout is the command running too long, not a missing node: running it again
  // under another launcher would repeat its work. A quick one means this launcher could not start.
  const start = Date.now()
  const timedOut = () => Date.now() - start >= init.timeoutMs - 1000
  if (launcher <= 0) {
    try {
      const ran = await $.process.run(['node', script, ...argv], init)
      launcher = 0
      return ran
    } catch (error) {
      if (timedOut()) throw error
    }
  }
  const all = await nodeCandidates($, script, argv)
  const order = launcher > 0 ? [launcher, ...all.keys()].filter((i, n, a) => a.indexOf(i) === n) : [...all.keys()].slice(1)
  let failure: unknown
  for (const i of order) {
    try {
      const ran = await $.process.run(all[i], init)
      launcher = i
      return ran
    } catch (error) {
      if (timedOut()) throw error
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
  fable?: { pct: number; left: string } | null // the Fable 7-day limit, shown even when it is low
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

// What the session itself is running, read off its own model requests: not in swap.js's data.
const live = { model: '', effort: '', advisor: 0 }
const shortModel = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')

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

// the rest of the pane (`panel` in swap.js): every profile, every feature's stored items (each with the argv that removes it),
// the help's commands, and which tab shows
type Window = { name: string; pct: number; left: string }
type PanelProfile = { name: string; email: string; active: boolean; disabled: boolean; tags: string[]; windows: Window[] }
type Feature = { key: string; title: string; items: { text: string; remove?: string[] }[] }
type Panel = Omit<Overview, 'settings'> & { profileList: PanelProfile[]; features: Feature[] }
const TABS = [['overview', '🔀 Tổng quan'], ['profiles', '👤 Profile'], ['settings', '🧰 Cài đặt'], ['features', '🧩 Tính năng'], ['commands', '📜 Lệnh']] as const
type Tab = (typeof TABS)[number][0]
let panel: Panel | null = null
let commands: HelpRow[] = []
let tab: Tab = 'settings'

// the features tab's add forms: free text in an Input, a profile or a choice in a Select. The values stay here until the add runs.
// a secret goes on stdin, never argv. `bind` binds the session's folder: swap.js runs there (the cwd $.process.run defaults to)
type Vals = Record<string, string>
type FormField = { name: string; label: string; kind: 'text' | 'profile' | 'choice'; choices?: string[]; def?: string; placeholder?: string }
type Form = { key: string; fields: FormField[]; argv: (v: Vals) => string[]; stdin?: (v: Vals) => string }
const FORMS: Form[] = [
  { key: 'alias', fields: [{ name: 'name', label: 'tên', kind: 'text', placeholder: 'pm' }, { name: 'profile', label: 'profile', kind: 'profile' }], argv: v => ['alias', v.name, v.profile] },
  { key: 'tag', fields: [{ name: 'profile', label: 'profile', kind: 'profile' }, { name: 'tag', label: 'tag', kind: 'text', placeholder: 'work' }], argv: v => ['tag', v.profile, v.tag] },
  { key: 'bind', fields: [{ name: 'profile', label: 'profile', kind: 'profile' }], argv: v => ['bind', v.profile] },
  { key: 'bind-branch', fields: [{ name: 'pattern', label: 'pattern', kind: 'text', placeholder: 'feat/*' }, { name: 'profile', label: 'profile', kind: 'profile' }], argv: v => ['bind-branch', v.pattern, v.profile] },
  { key: 'affinity', fields: [{ name: 'model', label: 'model', kind: 'text', placeholder: 'opus' }, { name: 'profile', label: 'profile', kind: 'profile' }], argv: v => ['affinity', v.model, v.profile] },
  { key: 'schedule', fields: [{ name: 'range', label: 'khung giờ', kind: 'text', placeholder: '09:00-18:00' }, { name: 'profile', label: 'profile', kind: 'profile' }], argv: v => ['schedule', v.range, v.profile] },
  { key: 'temp', fields: [{ name: 'profile', label: 'profile', kind: 'profile' }, { name: 'duration', label: 'thời gian', kind: 'text', def: '1h', placeholder: '30m' }], argv: v => ['temp', v.profile, v.duration] },
  { key: 'budget', fields: [{ name: 'profile', label: 'profile', kind: 'profile' }, { name: 'amount', label: 'hạn mức', kind: 'text', placeholder: '50' }], argv: v => ['budget', 'set', v.profile, v.amount] },
  { key: 'webhook', fields: [{ name: 'type', label: 'loại', kind: 'choice', choices: ['telegram', 'discord', 'slack', 'generic'] }, { name: 'url', label: 'URL', kind: 'text', placeholder: 'https://…' }], argv: v => ['webhook', 'set', v.type, '--url-stdin'], stdin: v => v.url },
]
let formFields: Record<string, string> = {}
let busy = false // one pane action at a time: a double press must not add a schedule twice or run two repairs


async function loadSettings($: EngineInterface) {
  const [{ stdout }, help] = await Promise.all([runSwap($, ['panel']), commands.length ? null : runSwap($, ['help', '/profile']).catch(() => null)]) // a keyword on every command line: all of them, without the overview
  const data = JSON.parse(stdout.trim())
  settings = data.settings
  panel = data
  if (help) commands = helpRows(help.stdout)
  draft = {}
}

// a button, or an add form, on the pane: run that subcommand, say how it went, redraw from fresh data. Resolves true when it succeeded.
async function panelAction($: EngineInterface, argv: string[], stdin?: string): Promise<boolean> {
  if (busy) {
    $.ui.toast('⏳ Đang chạy lệnh trước, đợi chút…')
    return false
  }
  busy = true
  try {
    const ran = await runSwap($, [...argv, '--no-color'], stdin)
    const out = `${ran.stdout}${ran.stderr}`.trim()
    $.ui.toast(out.split('\n')[0] || 'OK')
    await reloadPanel($)
    await refreshStatus($).catch(() => undefined)
    return ran.exitCode === 0
  } finally {
    busy = false
  }
}

// fresh pane data once the profile or a setting may have changed (an auto-swap, a /profile command); edits in progress stay
async function reloadPanel($: EngineInterface) {
  if (!panel) return
  const kept = draft
  await loadSettings($).catch(() => undefined)
  draft = kept
  $.ui.invalidate('ui.render')
}

function setFormField($: EngineInterface, key: string, value: string) {
  formFields = { ...formFields, [key]: value }
  $.ui.invalidate('ui.render')
}

const profileNames = (): string[] => panel?.profileList.map(r => r.name) ?? []

// what a form shows: what was typed or picked, else the default (the active profile, the first choice, the field's `def`)
function formValues(f: Form): Vals {
  const active = panel?.profileList.find(r => r.active)?.name ?? profileNames()[0] ?? ''
  return Object.fromEntries(
    f.fields.map(x => {
      const fallback = x.kind === 'profile' ? active : x.kind === 'choice' ? (x.choices?.[0] ?? '') : (x.def ?? '')
      return [x.name, formFields[`${f.key}.${x.name}`] ?? fallback]
    })
  )
}

// the add button: every field must be filled; the form clears only when the subcommand succeeded
function submitForm($: EngineInterface, f: Form) {
  const v = Object.fromEntries(Object.entries(formValues(f)).map(([k, x]) => [k, String(x).trim()]))
  const missing = f.fields.find(x => !v[x.name])
  if (missing) {
    $.ui.toast(`⚠ Điền ${missing.label}`)
    return
  }
  void panelAction($, f.argv(v), f.stdin?.(v))
    .then(ok => {
      if (!ok) return
      formFields = Object.fromEntries(Object.entries(formFields).filter(([k]) => !k.startsWith(`${f.key}.`)))
      $.ui.invalidate('ui.render')
    })
    .catch(err => $.ui.toast(`⚠ ${String(err)}`))
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
    $.ui.invalidate('ui.render') // the pane stays open: the other tabs are still in use
    return
  }
  settingsNote = `⚠ Đã lưu ${saved}/${changed.length}. ${errors.join(' · ')}`
  $.ui.invalidate('ui.render')
}

// commands that only read: they cannot change what the band shows (not `list`/`usage`: they refresh the quota cache), so they skip the extra `statusline json` process
const READ_ONLY = new Set([
  'help', 'overview', 'panel', 'current', 'folder', 'history', 'stats', 'cooldown', 'forecast', 'doctor', 'tags',
  'aliases', 'disabled', 'branch-bindings', 'affinities', 'prompt', 'completion', 'version', 'share', 'export', 'web', 'dashboard',
])

// Same palette as the `/profile list` table (pctCode in swap.js): green < 50, yellow < 80, orange < 95, red above.
// Raw colours rather than theme keys, so the band and the table look alike on any theme.
const loadColor = (pct: number) => (pct >= 95 ? 'red' : pct >= 80 ? '#ff8700' : pct >= 50 ? 'yellow' : 'green')
const BAR_WIDTH = 8
const METER = 16 // cells in a pane's quota bar

// `/profile` help, row by row: a command (navy in swap.js's formatHelpReport) with its description, or a title
const SGR = /\x1b\[[0-9;]*m/g
const HELP_ARGS = new Set(['', 'help', '--help', '-h'])
type HelpRow = { cmd?: string; desc?: string; title?: string }

// what bare `/profile` draws above the help (`overview --json`, overviewData in swap.js); the latest one, so an older help
// in the scrollback shows the current values too
type Overview = {
  profile: string
  email: string
  profiles: number
  disabled: number
  rateLimited: boolean
  stale: string
  windows: { name: string; pct: number; left: string }[]
  settings: (Setting & { icon: string })[]
}
let overview: Overview | null = null

function helpRows(text: string): HelpRow[] {
  return text.split('\n').map(line => {
    const m = line.match(/^\s*\x1b\[1;38;5;18m(\/profile[^\x1b]*)\x1b\[0m\s*(.*)$/)
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
      // both at once: each is a node start-up, ~100 ms on Windows
      const [boundRan, curRan] = await Promise.all([runSwap($, ['bind', 'get', targetDir]), runSwap($, ['current'])])
      const boundOut = boundRan.stdout.trim()
      const match = boundOut.match(/(?:đang liên kết với profile|bound to profile|profile):\s*([^\s()]+)/i)
      if (match && match[1]) {
        const boundProfile = match[1]
        const curProfile = curRan.stdout.trim()
        if (boundProfile !== curProfile) {
          await runSwap($, ['swap', boundProfile, '--project'])
        }
      }
    } catch {}

    // network call, never awaited: it must not hold the session start. A new version is only on disk until reloaded.
    void runSwap($, ['autoupdate'])
      .then(ran => {
        if (ran.exitCode !== 0 || !ran.stdout.trim()) return
        $.ui.toast('⬆️ claude-swap đã cập nhật, đang nạp lại plugin...')
        $.clock.after(500, () => void $.command.run({ command: 'reload-plugins' }).catch(() => undefined))
      })
      .catch(() => undefined)

    void refreshStatus($).catch(() => undefined)
    if (!ticking) {
      ticking = true
      $.clock.every(TICK_MS, () => void refreshStatus($).catch(() => undefined))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const sid = await $.session.id().catch(() => '')
      const ran = await runSwap($, sid ? ['auto', 'check', '--session', sid] : ['auto', 'check'])
      const out = `${ran.stdout}${ran.stderr}`.trim()
      // the auto-swap notice would otherwise show nowhere: the hook only reads the [status] line
      const swapped = out.match(/^\[auto-swap\] (🔀 .*)$/m)
      if (swapped) {
        $.ui.toast(swapped[1])
        void reloadPanel($)
      }
      const presence = out.match(/^\[presence\] (.*)$/m)
      if (presence) $.ui.toast(presence[1])
      const line = out.match(/^\[status\] ?(.*)$/m)
      if (line && line[1].trim() !== lastRaw) showStatus($, line[1].trim())
    } catch {}

    return next(e)
  })

  // the main loop's model, effort and advisor calls, for the band; a subagent's request is not the session's
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? '' : String(e.effort)
      if (live.model !== e.model || live.effort !== effort) {
        live.model = e.model
        live.effort = effort
        $.ui.invalidate('ui.render')
      }
    }
    const r = yield* next(e)
    if (e.agentId === undefined) {
      const used = (r.serverToolUses ?? []).filter(u => u.name === 'advisor').length
      if (used) {
        live.advisor += used
        $.ui.invalidate('ui.render')
      }
    }
    return r
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
        {live.model ? (
          <Box>
            {sep}
            <Text color="magenta" bold>🤖 {shortModel(live.model)}</Text>
            {live.effort && !compact ? <Text color="magenta"> · effort {live.effort}</Text> : null}
            {live.advisor > 0 && !compact ? <Text color="magenta"> · advisor ×{live.advisor}</Text> : null}
          </Box>
        ) : null}
        {status.fable && !status.models?.includes('Fable') ? (
          <Box>
            {sep}
            <Text color="cyan" bold>Fable 7d </Text>
            <Text color={loadColor(status.fable.pct)} bold>{String(status.fable.pct)}%</Text>
            {status.fable.left && !compact ? <Text color="cyan"> ⏳{status.fable.left}</Text> : null}
          </Box>
        ) : null}
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
    let rows = helpRows(text)
    if (!rows.some(r => r.cmd)) return next(e) // not the help after all (a format change, no match): draw it as text
    const { Box, Text, Button } = $.ui.resolve(e)
    // bare `/profile`: swap.js printed the overview as text above the help; draw it from the data instead
    const ov = HELP_ARGS.has(args.trim()) ? overview : null
    const start = rows.findIndex(r => r.title?.includes('claude-swap —'))
    if (ov && start > 0) rows = rows.slice(start)
    const width = ov ? Math.max(...ov.settings.map(r => r.key.length), 8) : 0
    return (
      <Box flexDirection="column">
        {ov ? (
          <Box flexDirection="column">
            <Text color="cyan" bold>🔀 claude-swap · Tổng quan</Text>
            {ov.profile ? (
              <Box>
                <Text>  👤 </Text>
                <Text color="green" bold>{ov.profile}</Text>
                {ov.email ? <Text color="gray">{` ${ov.email}`}</Text> : null}
                <Text>{`   📦 ${ov.profiles} profile`}</Text>
                {ov.disabled ? <Text color="red">{` · 🚫 ${ov.disabled} tắt`}</Text> : null}
              </Box>
            ) : (
              <Text color="yellow" bold>  ⚠ Chưa có profile nào active. Tạo bằng: /profile new {'<tên>'}</Text>
            )}
            {ov.windows.map(w => {
              const filled = Math.round((w.pct / 100) * 16)
              const color = loadColor(w.pct)
              return (
                <Box key={`ov:${w.name}`}>
                  <Text>{w.name === '5h' ? '  ⌛ ' : '  📅 '}</Text>
                  <Text color="cyan" bold>{w.name === '5h' ? '5 giờ   ' : '7 ngày  '}</Text>
                  <Text color="gray">[</Text>
                  <Text color={color} bold>{'█'.repeat(filled)}</Text>
                  <Text color="gray">{'░'.repeat(16 - filled)}] </Text>
                  <Text color={color} bold>{`${String(w.pct).padStart(3)}%`}</Text>
                  {w.pct >= 80 ? <Text> 🔥</Text> : null}
                  {w.left ? <Text color="cyan">{`  ⏳ ${w.left}`}</Text> : null}
                </Box>
              )
            })}
            {ov.rateLimited ? <Text color="yellow" bold>  ⏳ máy chủ usage đang bận (429), quota sẽ hiện lại sau</Text> : null}
            {ov.stale ? <Text color="yellow" bold>{`  ${ov.stale}`}</Text> : null}
            <Text> </Text>
            <Box>
              <Text color="cyan" bold>🧰 Cài đặt </Text>
              <Button key="overview-settings" plain onPress={() => void $.prompt.fill({ text: '/profile settings' }).catch(() => undefined)}>
                <Text color="gray">(sửa: /profile settings)</Text>
              </Button>
            </Box>
            {ov.settings.map(r => {
              const v = r.value
              const off = v === false || v === '' || v === 'off'
              return (
                <Box key={`ov:${r.key}`}>
                  <Text>{`  ${r.icon} `}</Text>
                  <Text bold>{`${r.key.padEnd(width)}  `}</Text>
                  <Text color={v === true ? 'green' : off ? 'gray' : 'cyan'} bold={!off}>
                    {(v === true ? '● bật' : v === false ? '○ tắt' : v === '' ? '—' : String(v)).padEnd(14)}
                  </Text>
                  <Text dimColor>{r.desc}</Text>
                </Box>
              )
            })}
            <Text> </Text>
          </Box>
        ) : null}
        {rows.map((r, i) =>
          r.cmd ? (
            <Box key={`row${i}`}>
              <Text>  </Text>
              <Button key={`help:${r.cmd}`} plain onPress={() => void $.prompt.fill({ text: helpDraft(r.cmd!) }).catch(() => undefined)}>
                <Text color="#000087" bold>{r.cmd.padEnd(28)}</Text>
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

  // `/profile settings`: one pane, a row of tabs, everything a click away. Each item sits on a card (rounded border);
  // a row lights up under the pointer (`hover` scope, one per row). Keys: 1-5 change tab, s saves.
  on('ui.render', { component: 'Pane', requestId: 'settings' }, ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const run = (argv: string[]) => void panelAction($, argv).catch(err => $.ui.toast(`⚠ ${String(err)}`))
    const fill = (text: string) => void $.prompt.fill({ text }).catch(() => undefined)
    const goTo = (id: Tab) => () => {
      tab = id
      $.ui.invalidate('ui.render')
    }
    const p = panel

    // one quota window: its name, a bar coloured by load, the percentage, the time to reset
    const meter = (w: Window) => {
      const filled = Math.round((w.pct / 100) * METER)
      const color = loadColor(w.pct)
      return (
        <Box key={`w:${w.name}`} marginRight={2}>
          <Text color="cyan" bold>{`${w.name} `}</Text>
          <Text color="gray">[</Text>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text color="gray">{'░'.repeat(METER - filled)}]</Text>
          <Text color={color} bold>{` ${String(w.pct).padStart(3)}%`}</Text>
          {w.left ? <Text color="cyan">{` ⏳${w.left}`}</Text> : null}
        </Box>
      )
    }

    const tabs = (
      <Box>
        {TABS.map(([id, label], i) => (
          <Box key={`tab:${id}`} marginRight={1}>
            <Button key={`tab:${id}`} variant={tab === id ? 'primary' : 'secondary'} hotkey={String(i + 1)} onPress={goTo(id)}>
              {label}
            </Button>
          </Box>
        ))}
      </Box>
    )

    const overviewBody = !p?.profile ? (
      <Text color="yellow" bold>⚠ Chưa có profile nào active. Tạo bằng: /profile new {'<tên>'}</Text>
    ) : (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="green" bold>{`👤 ${p.profile}`}</Text>
          {p.email ? <Text color="gray">{`   ${p.email}`}</Text> : null}
        </Box>
        {p.windows.length ? p.windows.map(meter) : <Text dimColor>chưa có số liệu quota (mở /profile usage để tải)</Text>}
        {p.rateLimited ? <Text color="yellow" bold>⏳ máy chủ usage đang bận (429), quota sẽ hiện lại sau</Text> : null}
        {p.stale ? <Text color="yellow">{p.stale}</Text> : null}
        <Box marginTop={1}>
          <Text color="gray">{`📦 ${p.profiles} profile`}</Text>
          {p.disabled ? <Text color="red">{`   🚫 ${p.disabled} tắt`}</Text> : null}
          <Text color="gray">{`   🧰 ${settings.filter(r => r.type === 'bool' && r.value === true).length} tính năng bật`}</Text>
        </Box>
      </Box>
    )

    const profilesBody = (
      <Box flexDirection="column">
        {(p?.profileList || []).map(r => (
          <Box key={`p:${r.name}`} hover={{ scope: `pf:${r.name}` }} flexDirection="column" borderStyle="round" borderColor={r.active ? 'green' : 'gray'} paddingX={1} marginBottom={1}>
            <Box>
              <Text color={r.active ? 'green' : 'white'} bold>{`${r.active ? '● ' : '○ '}${r.name}`}</Text>
              <Text color="gray">{`   ${r.email}`}</Text>
              {r.tags.map(t => <Text key={`t:${r.name}:${t}`} color="magenta">{` #${t}`}</Text>)}
              {r.disabled ? <Text color="red" bold>{'   🚫 tắt'}</Text> : null}
            </Box>
            {r.windows.length ? <Box>{r.windows.map(meter)}</Box> : <Text dimColor>chưa có số liệu quota</Text>}
            <Box marginTop={1}>
              {r.active ? (
                <Text color="green" bold>✓ đang dùng</Text>
              ) : (
                <Button key={`p-swap:${r.name}`} variant="primary" onPress={() => run(['swap', r.name])}>{'⇄ Dùng'}</Button>
              )}
              <Text> </Text>
              <Button key={`p-dis:${r.name}`} onPress={() => run([r.disabled ? 'enable' : 'disable', r.name])}>
                {r.disabled ? '↺ Bật lại' : '⊘ Tắt'}
              </Button>
              <Text> </Text>
              <Button key={`p-repair:${r.name}`} onPress={() => run(['repair', r.name])}>{'🔧 Repair'}</Button>
              <Text> </Text>
              <Button key={`p-del:${r.name}`} onPress={() => fill(`/profile delete ${r.name}`)}>{'🗑 Xóa…'}</Button>
            </Box>
          </Box>
        ))}
        <Box>
          <Button key="p-new" variant="primary" onPress={() => fill('/profile new ')}>{'＋ Tạo từ login hiện tại'}</Button>
          <Text> </Text>
          <Button key="p-token" onPress={() => fill('/profile add-token ')}>{'＋ Thêm bằng token'}</Button>
        </Box>
        <Text dimColor>{'🗑 Xóa… đưa lệnh xuống ô nhập, bạn gửi đi mới thật sự xóa.'}</Text>
      </Box>
    )

    // one add form: its fields in a row, each a text Input or a Select, then the add button
    const control = (f: Form, x: FormField) => {
      const key = `${f.key}.${x.name}`
      const current = formValues(f)[x.name]
      if (x.kind === 'text') {
        return (
          <Input key={`in:${key}`} value={current} placeholder={x.placeholder} onInput={v => setFormField($, key, v)} onSubmit={v => setFormField($, key, v)} />
        )
      }
      const names = x.kind === 'profile' ? profileNames() : (x.choices ?? [])
      if (!names.length) return <Text color="yellow">chưa có profile</Text>
      return <Select key={`sel:${key}`} options={names.map(n => ({ value: n }))} value={current} onSelect={v => setFormField($, key, v)} />
    }

    const featuresBody = (
      <Box flexDirection="column">
        {(p?.features || []).map(f => {
          const form = FORMS.find(x => x.key === f.key)
          return (
            <Box key={`f:${f.key}`} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
              <Text color="cyan" bold>{`${f.title}  ${f.items.length ? `(${f.items.length})` : ''}`}</Text>
              {f.items.length ? f.items.map((it, i) => (
                <Box key={`fi:${f.key}:${i}`} hover={{ scope: `fi:${f.key}:${i}` }}>
                  <Text>{`  ${it.text}   `}</Text>
                  {it.remove ? (
                    <Button key={`f-rm:${f.key}:${i}`} onPress={() => run(it.remove!)}>{'✕ Gỡ'}</Button>
                  ) : null}
                </Box>
              )) : <Text dimColor>{'  chưa có'}</Text>}
              {form ? (
                <Box flexWrap="wrap" marginTop={1} alignItems="center">
                  {form.fields.map(x => (
                    <Box key={`ff:${f.key}:${x.name}`} marginRight={2} alignItems="center">
                      <Text color="gray">{`${x.label} `}</Text>
                      {control(form, x)}
                    </Box>
                  ))}
                  <Button key={`add:${f.key}`} variant="primary" onPress={() => submitForm($, form)}>{'＋ Thêm'}</Button>
                </Box>
              ) : null}
            </Box>
          )
        })}
      </Box>
    )

    const settingsBody = (() => {
      const width = Math.max(...settings.map(r => r.key.length), 8)
      const shown = (v: Setting['value']) => (v === '' ? '—' : String(v))
      return (
        <Box flexDirection="column">
          {settings.map(r => {
            const value = r.key in draft ? draft[r.key] : r.value
            const changed = r.key in draft && draft[r.key] !== r.value
            const control =
              r.type === 'bool' ? (
                <Button key={`set:${r.key}`} onPress={() => edit($, r.key, !value)}>
                  {value ? '● bật' : '○ tắt'}
                </Button>
              ) : r.type === 'choice' ? (
                <Button
                  key={`set:${r.key}`}
                  onPress={() => {
                    const list = r.choices || []
                    edit($, r.key, list[(list.indexOf(String(value)) + 1) % list.length] ?? '')
                  }}
                >
                  {`⇄ ${shown(value)}`}
                </Button>
              ) : (
                <Input key={`set:${r.key}`} value={String(value)} placeholder="—" onInput={v => edit($, r.key, v)} onSubmit={v => edit($, r.key, v)} />
              )
            return (
              <Box key={`row:${r.key}`} hover={{ scope: `st:${r.key}` }}>
                <Text color={changed ? 'yellow' : 'white'} bold>{`${changed ? '* ' : '  '}${r.key.padEnd(width)}  `}</Text>
                {control}
                <Text dimColor>{`  ${r.desc}`}</Text>
              </Box>
            )
          })}
          {settingsNote ? <Text color="yellow">{settingsNote}</Text> : null}
          <Box marginTop={1}>
            <Button key="settings-save" variant="primary" hotkey="s" onPress={() =>
                void saveSettings($).catch(err => {
                  settingsNote = `⚠ ${String(err)}`
                  $.ui.invalidate('ui.render')
                })
              }>
              {`💾 Lưu${Object.keys(draft).length ? ` (${Object.keys(draft).length})` : ''}`}
            </Button>
            <Text> </Text>
            <Button key="settings-cancel" role="dismiss" onPress={() => void $.ui.close({ id: 'settings' })}>
              Đóng
            </Button>
          </Box>
        </Box>
      )
    })()

    const commandsBody = (
      <Box flexDirection="column">
        {commands.map((r, i) =>
          r.cmd ? (
            <Box key={`c${i}`} hover={{ scope: `cm:${i}` }}>
              <Button key={`cmd:${r.cmd}`} plain onPress={() => fill(helpDraft(r.cmd!))}>
                <Text color="yellow" bold>{r.cmd.padEnd(30)}</Text>
              </Button>
              <Text dimColor>{` ${r.desc}`}</Text>
            </Box>
          ) : r.title?.trim() ? <Text key={`c${i}`} color="cyan" bold>{r.title}</Text> : null
        )}
        <Text dimColor>{'💡 Bấm một lệnh để đưa nó xuống ô nhập.'}</Text>
      </Box>
    )

    const body = tab === 'overview' ? overviewBody : tab === 'profiles' ? profilesBody : tab === 'features' ? featuresBody : tab === 'commands' ? commandsBody : settingsBody
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan" bold>{'🔀 claude-swap'}</Text>
          {p?.profile ? <Text color="green" bold>{`   ● ${p.profile}`}</Text> : null}
        </Box>
        <Box marginTop={1}>{tabs}</Box>
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={2} paddingY={1} marginTop={1}>
          {body}
        </Box>
        <Text dimColor>{'Bấm tab hoặc phím 1–5 · trỏ chuột vào dòng để làm nổi · sửa rồi 💾 Lưu (phím s) · Esc đóng'}</Text>
      </Box>
    )
  })

  on('command.run', { command: 'profile' }, async ($, e) => {
    const argv = toArgv(e.args)
    if (!argv) return { text: USAGE }
    // an interactive `claude` has no terminal here: the hook only collects output
    if (argv[0] === 'run' && !argv.includes('--')) return { text: `Chạy trong terminal: node "${$.plugin.root}/swap.js" run ${argv[1] || '<tên>'}` }

    // bare `/profile settings` opens the editor; with arguments (`settings set k v`) it runs as any command
    if (argv[0] === 'settings' && argv.length === 1) {
      await loadSettings($)
      settingsNote = ''
      const opened = await $.ui.open({ id: 'settings', title: 'claude-swap', focus: true, closeOnEscape: true })
      if (opened.isPlaced) return { text: '⚙️ Đã mở bảng điều khiển: phím 1-5 đổi tab, sửa cài đặt rồi bấm 💾 Lưu (phím s), Esc để đóng.' }
      await $.ui.close({ id: 'settings' })
    }

    // bare `/profile`: the overview's data, for the render hook to draw in colour above the help
    // the token goes on stdin, not argv, where `ps` would show it
    const token = argv[0] === 'add-token' && argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined
    const [ran, ov] = await Promise.all([
      token ? runSwap($, ['add-token', '--token-stdin', ...argv.slice(2)], token) : runSwap($, argv),
      argv.length === 1 && argv[0] === 'help' ? runSwap($, ['overview', '--json']).catch(() => null) : null,
    ])
    if (ov) {
      try {
        overview = JSON.parse(ov.stdout.trim())
      } catch {}
    }
    if (!READ_ONLY.has(argv[0]) || ran.exitCode !== 0) {
      await refreshStatus($).catch(() => undefined)
      if (argv[0] !== 'settings') await reloadPanel($)
    }
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
