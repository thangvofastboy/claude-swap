import type { EngineInterface, Register } from 'claude-code'

const SUBCOMMANDS = new Set(['list', 'current', 'usage', 'folder', 'save', 'swap', 'delete', 'new', 'auto'])
const USAGE =
  'Dùng: /profile | /profile <tên> | /profile usage | /profile auto [on|off|threshold <%>|order <ds>|check] | /profile folder | /profile import <thư mục> [--force] | /profile new <tên> [--force] | /profile save <tên> [--force] | /profile delete <tên>'

// "" → list, "work" → swap work, "save work" → save work, "import ~/a b" → import "~/a b", "auto ..." → auto ...
function toArgv(args: string): string[] | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['list']
  if (words[0] === 'import') {
    const path = words.slice(1).filter(w => w !== '--force').join(' ')
    if (!path) return undefined
    return ['import', path, ...(words.includes('--force') ? ['--force'] : [])]
  }
  if (words[0] === 'auto') return words
  if (SUBCOMMANDS.has(words[0])) return words
  if (words.length === 1) return ['swap', words[0]]
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
      description: 'Đổi tài khoản Claude ngay trong session: /profile [tên | usage | auto | new <tên> | save <tên> | delete <tên>]',
    })
    void refreshStatus($).catch(() => undefined)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const ran = await runSwap($, ['auto', 'check'])
      const out = `${ran.stdout}${ran.stderr}`.trim()
      if (out.includes('[auto-swap]')) {
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
