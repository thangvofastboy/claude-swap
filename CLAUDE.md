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

- **`hooks/register.ts`** — thin plugin glue. It never touches profile data itself; every action spawns `node swap.js <argv>` via `$.process.run` and returns the stdout/stderr text.
  - `command.run` for `/profile`: `toArgv()` maps the args. A first word in `SUBCOMMANDS` passes through as-is; a single unknown word becomes `swap <word>`. **A new CLI subcommand must also be added to `SUBCOMMANDS`**, or `/profile foo` gets treated as "swap to profile foo".
  - `session.start`: runs `bind get <cwd>` and **regex-parses its human-readable output** (`đang liên kết với profile: X`). Changing that message in `swap.js` breaks project auto-binding.
  - `prompt.submit`: runs `auto check` on every prompt. It refreshes the status line only when the output contains `[auto-swap]`. Keep `auto check` cheap: it is on the prompt path.
- **`swap.js`** — a single ES module holding all logic plus the CLI (`runCli(argv, home)` returns an exit code; a `SwapError` is printed as `❌ Lỗi: …` and returns 1). Every function takes `home` as its first parameter so tests can point it at a temp dir. It only runs as a CLI when it is the entry script (the `SCRIPT_PATH` guard at the bottom). That guard must stay free of top-level `await`: `web.js` imports `swap.js`, and `runCli` does `await import('./web.js')`. A pending top-level await deadlocks that import, and the process exits silently.
- **`web.js`** — local dashboard (`/profile web`, run as a detached `web --server` child). It binds `127.0.0.1` only, rejects a non-local `Host` (DNS rebinding) and any non-`application/json` POST (CSRF), and the client escapes all interpolated HTML with `esc()`. Keep all four guards: the API can swap, delete and add credentials. State lives in `.web.pid` as `{ pid, port }`.

### How a swap works

Profiles live in `~/.config/claude-cli-profiles/` (dir 0700, files 0600, always written through `atomicWrite`). Each `<name>.json` is `{ claude_json, credentials, tags }`:
- `claude_json` holds only the `AUTH_KEYS` (`oauthAccount`, `primaryApiKey`, `customApiKeyResponses`) copied out of `~/.claude.json`. A swap replaces just those keys and leaves the rest of `~/.claude.json` (projects, settings, history) untouched.
- `credentials` is the raw string of `~/.claude/.credentials.json`. On macOS without that file it lives in the Keychain instead (`useKeychain`).
- If `CLAUDE_CONFIG_DIR` is set, Claude Code uses `<dir>/.claude.json`, `<dir>/.credentials.json` and the Keychain item `Claude Code-credentials-<sha256(dir)[0:8]>`; `claudeConfigDir`/`claudeJson`/`credentialsFile` follow it. The variable is honoured **only when `home === os.homedir()`**, so tests and other callers that pass their own `home` are never redirected into the real config. Which profile a config dir holds is stored per dir: `.current` for the default, `.current-<hash>` otherwise (`currentFileFor`).
- Before switching, `swapProfile` re-saves the current profile if the live account matches it. This captures tokens that Claude Code refreshed in the meantime.

State is kept in dotfiles beside the profiles: `.current`, `.aliases.json`, `.auto-switch.json`, `.usage-cache.json`, `.usage-history.json`, `.temp-profile.json`, `.project-bindings.json`, `.branch-bindings.json`, `.disabled.json`, `.swap-history.json`, `.language.json`, and others. `listProfiles` skips dotfiles. `run <name>` creates an isolated session under `.sessions/<name>/` using `CLAUDE_CONFIG_DIR`, then syncs refreshed credentials back into the profile. With `CLAUDE_CONFIG_DIR=X`, Claude Code reads `X/.claude.json` and `X/.credentials.json`; on macOS it reads Keychain item `Claude Code-credentials-<sha256(X)[0:8]>` (`sessionKeychainService`). Inside such a session (`isolatedSession(home)`), `swapProfile` throws and `auto check` is skipped. `syncSessionBack` also refuses to copy a different account back into the profile.

### Usage / quota data (easy to get wrong)

- `fetchUsage` calls Anthropic's OAuth usage endpoint. Results are cached in `.usage-cache.json` for `USAGE_TTL` (5 min) under the key `` `${name}|${email}` ``. Failures are cached too, so an offline machine is not refetched on every prompt. A 429 sets `retry_at`; that is a polling limit on the usage endpoint, **not** quota exhaustion.
- `parseLimits` produces tuples `[label, pct, "DD/MM HH:MM", rawIsoResetsAt]`. **`pct` is already 0–100**; do not rescale it. Labels `'5 giờ'` / `'7 ngày'` (`LABEL_5H` / `LABEL_7D`) double as lookup keys, so don't translate them. Read cached quota through the helpers `cacheHit`, `findLimit`, `limitPct`, `isRateLimited`, `parseResetTime` rather than indexing tuples by hand.
- `findNextProfile` filters candidates by disabled list, auto `pool` and balance `pool`, expiry, and quota. When `balance` is on, its mode picks among the survivors (`round-robin` = next name after the current one, stateless; `least-used` = the default sort), and `auto order` is ignored. `balance next` goes through the same function.
- `autoCheckAndSwap` runs its checks in this order: temp-profile expiry → refresh usage → Git branch binding → auto-return to primary → threshold / 7-day safeguard → `findNextProfile` (config `order`, otherwise lowest 5h usage, then earliest reset).

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
