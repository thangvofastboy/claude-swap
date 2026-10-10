# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                                   # unit tests for swap.js (node --test, no deps)
node --test --test-name-pattern="auto-switch" test/swap.test.js  # run matching tests only (pass the file, not the dir)
claude plugin validate .                                   # validate manifest + hooks
claude plugin test .                                       # run hooks/register.test.ts (NOT covered by npm test)
node swap.js <subcommand> [args] [--no-color]              # run the CLI directly, e.g. `node swap.js cooldown`
```

Zero runtime dependencies is a project constraint (README): use Node stdlib only. There is no build or lint step.

## Architecture

The repo itself is the Claude Code plugin (`.claude-plugin/plugin.json`, `source: "./"`). Two layers:

- **`hooks/register.tsx`** — thin plugin glue. It never touches profile data itself; every action spawns `node swap.js <argv>` via `$.process.run` and returns the stdout/stderr text.
  - `command.run` for `/profile`: `toArgv()` maps the args. A first word in `SUBCOMMANDS` passes through as-is; a single unknown word becomes `swap <word>`. **A new CLI subcommand must also be added to `SUBCOMMANDS`**, or `/profile foo` gets treated as "swap to profile foo".
  - `/profile` is registered `immediate: true` (runs while a turn is streaming). After a successful `upgrade` the hook schedules `/reload-plugins` via `$.clock.after`, so no restart is needed.
  - `session.start`: runs `bind get <cwd>` and **regex-parses its human-readable output** (`đang liên kết với profile: X`). Changing that message in `swap.js` breaks project auto-binding.
  - `prompt.submit`: runs `auto check` on every prompt. It ends with a `[status] <json>` line (`statusLineData`: profile, 5h/7d percentages and reset times, forecast warning; `null` when `/profile statusline off`). The JSON carries `mode` and a ready-made `ansi` line (`statusLineAnsi`, safe SGR codes only). `band` mode (default) clears the pinned line and draws a coloured `AbovePrompt` band through a `ui.render` hook; `line` mode pins the plain `text` with `$.ui.status`. Never put colour codes in a pinned line: verified on the real host that it strips the ESC byte and prints `[1;32m` as text (the host also prefixes the plugin name there). The first `showStatus` after a (re)load always calls `$.ui.status` so a line left by an older plugin version is replaced. The hook keeps the data in a module variable; it calls `$.ui.invalidate('ui.render')` only when the JSON changes. The band's `loadColor` mirrors `pctCode` in swap.js (green < 50, yellow < 80, orange < 95, red), labels and reset times are cyan: change both together so the band and `/profile list` keep one palette. Commands in `READ_ONLY` (hooks/register.tsx) skip the follow-up `statusline json` process; a new command that can change the profile or settings must stay out of that set. Use `⏳`, not `↻`, for countdowns: the terminal draws `↻` wider than one cell and it overlaps the next character. `statusline text` is the plain-text form. The data also carries `stale` (cache older than `STALE_STATUS_MIN` or a failed fetch) and, only with auto-switch off and a window ≥ `WARN_PCT`, `suggest`/`next` from `findNextProfile`; the hook toasts a new `next` once, draws a `⇄ <next>` `Button` (key `swap-next`, hotkey `s`) that runs `swap`, and toasts every `[auto-swap] 🔀` line. `pace` (7d window hot: budget per hour, `weeklyPace`) and `recovered` (other profiles whose hot window's reset time has passed; toasted once each) come from the cache alone. Between prompts the hook polls `statusline json` every minute (`$.clock.every`, started once per load); that subcommand refetches the current profile (others only while a suggestion is due), so `auto check` must also refresh the current profile **before** its `enabled` check. Bare `/profile statusline` toggles it (the hook maps it to `statusline toggle`); the bare CLI `statusline` still prints the shell-prompt string for starship/tmux. Keep `auto check` cheap: it is on the prompt path (it also runs `sendQuotaAlerts`, a no-op without a webhook).
  - `runSwap` has no `process` in the hooks module: `node` on PATH first, then the usual install paths and a login shell (env read through `$.env.get('LITERAL')`, which only takes a literal name). The launcher that worked is remembered.
  - `/profile settings` (no args) opens a `Pane` (`requestId: 'settings'`) fed by `settings --json`; Save runs `settings set <key> <value>` per changed row. A new option goes into `SETTINGS` in swap.js only.
  - `ui.render` on `CommandOutput`: the `/profile` help is redrawn with each command as a `Button` that calls `$.prompt.fill`. It finds commands by the `\x1b[1;33m/profile …\x1b[0m` yellow that `formatHelpReport` gives them; change that colour and the help falls back to plain text. Bare `/profile` (`help` with no keyword) also runs `overview --json` (`overviewData`) and draws that block above the commands; it drops swap.js's own text copy of it by cutting the rows before the help title (`claude-swap —`). `formatOverview` is the CLI's text form; a new setting gets its icon in `SETTING_ICONS` (single-codepoint emoji only, VS16 ones break the columns).
- **`swap.js`** — a single ES module holding all logic plus the CLI (`runCli(argv, home)` returns an exit code; a `SwapError` is printed as `❌ Lỗi: …` and returns 1). Every function takes `home` as its first parameter so tests can point it at a temp dir. It only runs as a CLI when it is the entry script (the `SCRIPT_PATH` guard at the bottom). That guard must stay free of top-level `await`: `web.js` imports `swap.js`, and `runCli` does `await import('./web.js')`. A pending top-level await deadlocks that import, and the process exits silently.
- **`web.js`** — local dashboard (`/profile web`, run as a detached `web --server` child). It binds `127.0.0.1` only, rejects a non-local `Host` (DNS rebinding) and any non-`application/json` POST (CSRF), and every `/api/*` call without the per-launch token (`X-Dashboard-Token`, handed to the browser only via the URL `#fragment` from `dashboardUrl`) gets 401, which keeps other local users out. The client escapes all interpolated HTML with `esc()`. Keep all five guards: the API can swap, delete, export and add credentials. The "All features" tab runs `swap.js` subcommands through `runSwapCli`. That function has a whitelist (`WEB_CLI`), and passwords go on stdin. A new CLI subcommand must be added to `WEB_CLI` to be reachable from the web. State lives in `.web.pid` as `{ pid, port, token }`.

### Output colour

`runCli` wraps `runCliInner` and, for commands in `PRETTY_CMDS`, runs every plain `console.log` line through `colorizeLine` (errors on `console.error` always). Only commands meant for people belong in that set: the hook and shells parse `current`, `bind get`, `auto check` (`[status]` is matched line by line), `statusline`, `export`, so a new machine-read command must stay out of it. Lines that already carry an escape are left alone.

### How a swap works

Profiles live in `~/.config/claude-cli-profiles/` (dir 0700, files 0600, always written through `atomicWrite`). Each `<name>.json` is `{ claude_json, credentials, tags }`:
- `claude_json` holds only the `AUTH_KEYS` (`oauthAccount`, `primaryApiKey`, `customApiKeyResponses`) copied out of `~/.claude.json`. A swap replaces just those keys and leaves the rest of `~/.claude.json` (projects, settings, history) untouched.
- `credentials` is the raw string of `~/.claude/.credentials.json`. On macOS without that file it lives in the Keychain instead (`useKeychain`).
- If `CLAUDE_CONFIG_DIR` is set, Claude Code uses `<dir>/.claude.json`, `<dir>/.credentials.json` and the Keychain item `Claude Code-credentials-<sha256(dir)[0:8]>`; `claudeConfigDir`/`claudeJson`/`credentialsFile` follow it. The variable is honoured **only when `home === os.homedir()`**, so tests and other callers that pass their own `home` are never redirected into the real config. Which profile a config dir holds is stored per dir: `.current` for the default, `.current-<hash>` otherwise (`currentFileFor`).
- `.credentials.json` also holds `mcpOAuth` (the MCP servers' own logins). A swap and `prepareSession` merge the **live** `mcpOAuth` into the target credentials (`keepLiveMcpOAuth`), so MCP logins follow the machine, not the profile. Only `claudeAiOauth` etc. follow the profile.
- Before switching, `swapProfile` re-saves the current profile if the live account matches it. This captures tokens that Claude Code refreshed in the meantime.

`renameProfile` rewrites every dotfile that is keyed by or points at a profile name (aliases, bindings, disabled, auto-switch order/primary, temp, history, budget, usage cache/history, `.current*`, the `.sessions/<name>` dir); **a new state file that stores profile names must be added there**.

State is kept in dotfiles beside the profiles: `.current`, `.aliases.json`, `.auto-switch.json`, `.usage-cache.json`, `.usage-history.json`, `.temp-profile.json`, `.project-bindings.json`, `.branch-bindings.json`, `.disabled.json`, `.swap-history.json`, `.language.json`, `.project-usage.json` (keyed by directory, not profile, so `renameProfile` leaves it), `.alerts-sent.json` (webhook alerts already sent, keyed by email + reset time for the same reason), `.repair.json`, `.schedule.json` (holds profile names: `renameProfile` rewrites it), and others. `.usage-history.json` keeps every reading of the last 6h (the forecast reads those) and one per hour back to 7 days (`thinHistory`). `listProfiles` skips dotfiles. `run <name>` creates an isolated session under `.sessions/<name>/` using `CLAUDE_CONFIG_DIR`, then syncs refreshed credentials back into the profile. With `CLAUDE_CONFIG_DIR=X`, Claude Code reads `X/.claude.json` and `X/.credentials.json`; on macOS it reads Keychain item `Claude Code-credentials-<sha256(X)[0:8]>` (`sessionKeychainService`). `prepareSession` symlinks `SHARED_CONFIG` (skills, agents, plugins, settings, `projects`/memory, …) from the real config dir into the session dir; credentials and `.claude.json` stay per profile. Inside such a session (`isolatedSession(home)`), `swapProfile` throws and `auto check` is skipped. `syncSessionBack` also refuses to copy a different account back into the profile. `repair` (`repairProfile`) reuses that pair to renew an expired token without a swap: it runs `claude -p` with haiku in the session, because `claude auth status` does not refresh (verified).

### Usage / quota data (easy to get wrong)

- `fetchUsage` calls Anthropic's OAuth usage endpoint. Results are cached in `.usage-cache.json` for `USAGE_TTL` (5 min) under the key `` `${name}|${email}` ``. Failures are cached too, so an offline machine is not refetched on every prompt. A 429 sets `retry_at`; that is a polling limit on the usage endpoint, **not** quota exhaustion.
- `parseLimits` produces tuples `[label, pct, "DD/MM HH:MM", rawIsoResetsAt]`. **`pct` is already 0–100**; do not rescale it. Labels `'5 giờ'` / `'7 ngày'` (`LABEL_5H` / `LABEL_7D`) double as lookup keys, so don't translate them. Read cached quota through the helpers `cacheHit`, `findLimit`, `limitPct`, `isRateLimited`, `parseResetTime` rather than indexing tuples by hand.
- `calculateForecast` counts minutes from the **last measurement** (`.usage-history.json`), not from now, and flags it `stale` past `STALE_FORECAST_MIN` (20 min); `forecastWarning` (status line) stays silent on stale data. Tests on it must keep expected values away from `.5` rounding edges, since the clock moves while they run.
- `findNextProfile` filters candidates by disabled list, auto `pool` and balance `pool`, expiry, and quota. When `balance` is on, its mode picks among the survivors (`round-robin` = next name after the current one, stateless; `least-used` = the default sort), and `auto order` is ignored. `balance next` goes through the same function.
- `autoCheckAndSwap` runs its checks in this order: temp-profile expiry → refresh usage **of the current profile only** (`refreshUsage`; the bound, primary or all other profiles are refreshed lazily, just before a check needs them) → Git branch binding → auto-return to primary → threshold / 7-day safeguard → `findNextProfile` (config `order`, otherwise lowest 5h usage, then earliest reset).

### Secrets

- Keychain writes go through `security -i` on stdin (`keychainWriteCommand`, hex `-X`), never `-w <token>` on argv where `ps` shows it.
- Webhook URLs are secrets (bot token / signing path). `/api/data` sends only `maskUrl()` versions, and `save_config` only accepts typed-in `http(s)` URLs for the four known types (an empty field keeps the stored value). Never pass one on a child's argv: the web "Features" tab deliberately has no `webhook set`.
- Errors about secret-bearing files go through `safeError()`. Node's `JSON.parse` messages quote the input (`"sk-ant-…" is not valid JSON`).
- Backup/sync passwords are never written to disk (`saveSyncConfig` strips `password`). Read them only with `readPasswordArg` (`--password-stdin` > `--password` > `CLAUDE_SWAP_PASSWORD`).

### Cross-platform

- Spawn fire-and-forget processes (notifications, `xdg-open`/`open`/`explorer`, the dashboard) through `spawnDetached`. A missing binary otherwise emits an unhandled `'error'` and crashes the process.
- Spawn `claude` through `spawnClaudeSync`. On Windows an npm install is `claude.cmd`, which Node will not spawn without a shell.
- `atomicWrite` retries the rename on Windows `EPERM`/`EACCES`/`EBUSY` (antivirus locks).
- Webhook posts made during a CLI run are awaited by `flushWebhooks()` before `process.exit`.

### i18n

Default language is Vietnamese; English is chosen via `/profile lang en` or `CLAUDE_SWAP_LANG`. Many `format*` functions take a `lang` argument, but plenty of messages are still Vietnamese-only.

## Testing notes

- `test/swap.test.js` also tests `web.js` (it starts the server on port 3799; keep `dash.close()` in a `finally`, or a failing assertion hangs the run) and runs `swap.js` as an entry script once (`web stop`) to guard the import deadlock.
- `test/swap.test.js` builds fake logins with `login(home, account, token)`, using tokens like `tok-a`. `fetchUsage` deliberately short-circuits `tok-*` / `mock-*` tokens to 0% usage so that `runCli(['list'])` etc. never hit the network. Don't remove that without injecting a fetch stub instead.
- `auto check` refetches cache entries older than `USAGE_TTL`. Cache fixtures for it must be written with `writeFreshCache` (it adds `at`), or the mock fetch overwrites them with 0%. You can also pass `{ cache, config, fetchFn }` to `autoCheckAndSwap` directly.

## Versioning

The version is in `package.json` and `.claude-plugin/plugin.json`; bump both together. `swap.js version` reads `package.json`.

`/profile upgrade` runs `claude plugin marketplace update claude-swap` and then `claude plugin update profile-swap@claude-swap`. The plugin manager installs from the GitHub default branch, not from tags, and it skips the update when `plugin.json`'s version is unchanged. A release therefore means: bump the version, commit, tag `vX.Y.Z`, and push `main`.
