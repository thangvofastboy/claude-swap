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

// the plugin is the repo itself: swap.js sits next to .claude-plugin/ and hooks/
async function runSwap($: EngineInterface, argv: string[]) {
  const script = `${$.plugin.root}/swap.js`
  let failure: unknown
  for (const node of ['node', 'nodejs']) {
    try {
      return await $.process.run([node, script, ...argv])
    } catch (error) {
      failure = error
    }
  }
  throw new Error(`Không chạy được node: ${String(failure)}`)
}

// What `statusLineData` in swap.js returns. Drawn as a coloured band above the prompt: the host's own status line
// takes plain text only (one colour, prefixed with the plugin name).
type StatusData = {
  profile: string
  rateLimited: boolean
  windows: { name: string; pct: number; left: string }[]
  warn: string
  mode?: 'line' | 'band'
  ansi?: string
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

// `line` mode pins the coloured text under the prompt; `band` draws it above. Whichever is not in use is cleared:
// a plugin's pinned text survives a reload, so the very first call must clear a line an older version left behind.
let pinned = true

function showStatus($: EngineInterface, raw: string) {
  lastRaw = raw
  status = parseStatus(raw)
  const text = status && status.mode !== 'band' ? status.ansi || undefined : undefined
  if (text !== undefined || pinned) $.ui.status(text)
  pinned = text !== undefined
  $.ui.invalidate('ui.render')
}

async function refreshStatus($: EngineInterface) {
  const { stdout } = await runSwap($, ['statusline', 'json'])
  showStatus($, stdout.trim())
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'profile',
      description: 'Đổi tài khoản Claude ngay trong session: /profile [tên | usage | auto | cooldown | doctor | temp | bind | history]',
      immediate: true, // runs at once even while a turn is streaming, instead of queueing behind it
    })

    try {
      const targetDir = e.cwd || process.cwd()
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

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const ran = await runSwap($, ['auto', 'check'])
      const out = `${ran.stdout}${ran.stderr}`.trim()
      const line = out.match(/^\[status\] ?(.*)$/m)
      if (line && line[1].trim() !== lastRaw) showStatus($, line[1].trim())
    } catch {}

    return next(e)
  })

  // coloured status band: ● profile │ 5h [███░░░░░] 34% ⏳2h10m │ 7d [██████░░] 73% ⏳3d4h │ ⚠ 5h ~12p
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (!status || status.mode !== 'band' || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
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
              <Text color="gray">[</Text>
              <Text color={color} bold>{'█'.repeat(filled)}</Text>
              <Text color="gray">{'░'.repeat(BAR_WIDTH - filled)}]</Text>
              <Text color={color} bold> {String(w.pct)}%</Text>
              {w.pct >= 80 ? <Text> 🔥</Text> : null}
              {w.left ? <Text color="cyan"> ⏳{w.left}</Text> : null}
            </Box>
          )
        })}
        {status.warn ? <Box>{sep}<Text color="yellow" bold>{status.warn}</Text></Box> : null}
      </Box>
    )
  })

  on('command.run', { command: 'profile' }, async ($, e) => {
    const argv = toArgv(e.args)
    if (!argv) return { text: USAGE }

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
