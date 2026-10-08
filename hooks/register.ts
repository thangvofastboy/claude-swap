import type { EngineInterface, Register } from 'claude-code'

const SUBCOMMANDS = new Set([
  'help',
  'list',
  'current',
  'usage',
  'folder',
  'save',
  'swap',
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

async function refreshStatus($: EngineInterface) {
  const { stdout } = await runSwap($, ['current'])
  const name = stdout.trim()
  $.ui.status(name ? `● ${name}` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'profile',
      description: 'Đổi tài khoản Claude ngay trong session: /profile [tên | usage | auto | cooldown | doctor | temp | bind | history]',
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
      if (out.includes('[auto-swap]') || out.includes('quay về') || out.includes('revert')) {
        await refreshStatus($)
      }
    } catch {}

    return next(e)
  })

  on('command.run', { command: 'profile' }, async ($, e) => {
    const argv = toArgv(e.args)
    if (!argv) return { text: USAGE }

    const ran = await runSwap($, argv)
    await refreshStatus($)
    const out = `${ran.stdout}${ran.stderr}`.trim()
    if (out) return { text: out }

    return { text: argv[0] === 'list' ? 'Chưa có profile nào. Tạo bằng: /profile new <tên>' : 'OK' }
  })
}
