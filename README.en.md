<div align="center">

[Tiếng Việt](README.md) · **English**

# 🔀 claude-swap

**One Claude Code, many accounts, zero restarts.**

*Because "You've reached your usage limit" at 2 a.m., mid-refactor, should happen to no one.*

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-1f2937)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin%20%2Fprofile-d97757)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-success)
![License MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![i18n](https://img.shields.io/badge/i18n-Tiếng%20Việt%20%7C%20English-orange)

[Features](#-features) ·
[Install](#-install) ·
[Quick start](#-quick-start) ·
[Web Dashboard](#-web-dashboard) ·
[Commands](#-profile-commands) ·
[Parallel sessions](#-parallel-sessions) ·
[Troubleshooting](#-troubleshooting) ·
[Under the hood](#-under-the-hood) ·
[Languages](#-languages) ·
[Development](#️-development--testing)

</div>

---

You have a work account, a personal account, a "backup" account, and one more that even you can't remember creating. Every switch means `/logout`, `/login`, a browser tab, a redirect, and forgetting what you were thinking about.

**claude-swap** turns each account into a *profile*. Switch with one command, inside the session you're already in. Your context stays, your conversation stays, only the account changes.

It runs on the **Node.js** that Claude Code already ships with: **no Python, no `npm install`, exactly 0 dependencies.** This project's `node_modules` weighs precisely 0 bytes, and we are unreasonably proud of that.

---

## ✨ Features

| Group | What it does for you |
| --- | --- |
| 🌐 **Web Dashboard** | `/profile web` opens a control panel in your browser: one click to switch accounts, sliders for settings, built-in docs. For days when typing feels like too much. |
| 💾 **Profile management** | Create, save, switch, delete: `/profile new`, `save`, `delete`. The classic four. |
| ✏️ **Rename & undo** | `/profile rename old new` renames with aliases, bindings and history following along. `/profile undo` jumps back to the previous profile after a slip. |
| 🔌 **MCP stays connected** | MCP server logins belong to the machine, not the account: switching profiles doesn't make you re-authenticate Linear, Notion, Vercel... |
| 📟 **Detailed status line** | A coloured band above the input box: profile, 5h/7d bars, reset times and a running-out warning (`/profile statusline` to toggle). |
| 🎨 **Coloured output** | Errors red, success green, an aligned `list` table with 5h and 7d reset times. Readable at a glance. |
| 🔤 **Aliases** | Tired of typing `work-company-production-2`? Call it `w` and run `/profile w`. |
| 🎛️ **Interactive picker** | `/profile pick` lets you choose with `↑` `↓`, for people who can't remember their own profile names. |
| ⚖️ **Load balancing** | Spread the work across accounts with `least-used` (whoever has the most quota left) or `round-robin` (take turns). No account carries the team alone. |
| 🔔 **Webhooks** | Ping Telegram, Discord, Slack or any webhook when you hit a threshold or switch accounts. Your phone buzzes, you know. |
| 💰 **Budgets** | Set a monthly spending cap per profile (`/profile budget`). Your wallet says thanks. |
| 🛡️ **Masking & safe sharing** | Emails show as `us***@domain.com` while you screen-share, and config exports leave tokens out (`/profile mask`, `/profile share`). |
| ⌨️ **Tab completion** | Completion scripts for Bash, Zsh and Fish (`/profile completion`). Type half a word, hit Tab. |
| 🚀 **Parallel sessions** | `/profile run <name>` starts a separate Claude Code on another account. Two Claudes, two accounts, nobody steps on anybody. Your skills, agents, plugins, settings and memory are shared. |
| 🔑 **Setup-token & API key** | Create a profile straight from a token, no browser needed (`/profile add-token`). Reads from `stdin` too, so the token stays out of your shell history. |
| 🚫 **Time off** | `/profile disable <name>` benches a profile from auto-switch without deleting it. |
| 🌿 **Git branch binding** | `work-*` branches use the company account, `feat/*` use the dev one, automatically. No more side projects billed to your employer by accident. |
| 📁 **Folder binding** | Open a project and its profile turns on by itself (via a `.claude-profile` file). |
| 📈 **Forecast** | Measures burn rate in %/hour and predicts when you'll run dry (`/profile forecast`). It can predict everything except your deadline. |
| ⏱️ **Cooldown & auto-return** | Counts down to the 5-hour quota reset, then moves you back to your primary profile once it has recovered. |
| 🤖 **Auto-switch** | Hit the % threshold or a rate limit and it jumps to the account with the most quota left or the earliest reset. You just keep coding. |
| 🚨 **7-day safeguard** | Won't jump into an account that has nearly used up its weekly quota (default 85%). |
| 🧠 **Model affinity** | Opus on this account, Sonnet on that one (`/profile affinity`). |
| 🩺 **Doctor & cleanup** | Checks for expired tokens, expired MCP logins, duplicate accounts and broken files (`/profile doctor`, `/profile cleanup`). A GP for your credentials. |
| ☁️ **Encrypted sync** | Push and pull AES-256 encrypted backups between machines (`/profile sync push` / `pull`). |
| 💻 **Shell prompt & Tmux** | Shows the active profile and usage % in Starship, Zsh, Bash or Tmux, in under 5 ms. |
| ⏳ **Borrow** | Borrow a profile for `30m` or `1h` and it hands itself back. Like borrowing a coworker's charger, except this time something reminds you to return it. |
| 📊 **JSON output** | `--json` on `list`, `current` and `disabled`, for scripts and CI. |
| 🌐 **Bilingual** | Vietnamese or English, `/profile lang [vi\|en]`. |
| ⚡ **Zero token cost** | Every `/profile` command runs locally through a plugin hook. **Nothing goes to the model and no turns are used.** |

---

## 📦 Install

Run this inside Claude Code:

```bash
/plugin install profile-swap --marketplace thangvofastboy/claude-swap
```

*(Press `y` when Claude asks about adding the marketplace, then pick an install scope.)*

To try it straight from source without installing:

```bash
claude --plugin-dir /path/to/claude-swap
```

Already installed and want the latest? `/profile upgrade`. The plugin reloads itself (`/reload-plugins`), no need to leave the session.

---

## 🚀 Quick start

Four steps, done before your coffee cools:

1. Log in with your first account (`claude` → `/login`) and save it:
   ```text
   /profile new work
   ```
2. `/login` to the second account and save that too:
   ```text
   /profile new personal
   ```
3. See what you've got:
   ```text
   /profile list    # list with usage % bars
   /profile web     # or open the dashboard
   ```
4. Switch whenever you like:
   ```text
   /profile work
   ```

That's it. You no longer need to remember which password goes with which account.

---

## 🌐 Web Dashboard

For days when your eyes want something nicer than a terminal:

```bash
/profile web              # open the dashboard at http://127.0.0.1:3737
/profile web --port 8080  # pick another port
/profile web stop         # stop the background dashboard
```

- **Everything at a glance:** 5h and 7d quota for every account, countdowns to the next reset, dark mode included.
- **One click to switch accounts.**
- **📈 Stats tab:** 5h/7d quota usage over time for every account, profile switches per day (manual / automatic / per project), your most-used account, a forecast of when each one runs dry, and recent switch history. Charts are hand-drawn SVG, still 0 dependencies.
- **🧰 Features tab:** every `/profile` command gets its own form: aliases, tags, folder and Git branch bindings, model affinity, borrowing, budgets, webhooks, encrypted backup / sync, shell snippets… Fill it in, hit ▶, and the output shows up right there. Backup passwords travel over stdin, never on the command line.
- **Settings with a mouse:** auto-switch threshold, 7-day safeguard, load balancing, webhooks, budgets, email masking.
- **Built-in docs,** so you don't have to come back to this README.

The dashboard only listens on `127.0.0.1`, rejects foreign requests, and creates a fresh secret token every time it starts. The token sits after the `#` in the link `/profile web` prints, so only your browser knows it. Your neighbour on the same Wi-Fi, or another user on the same machine, can't switch accounts for you. Closed the tab? Run `/profile web` again to get the link.

---

## 📋 `/profile` commands

This part is a bit more serious, because typos in commands aren't fun.

### 📌 Managing & switching

| Command | Description |
| --- | --- |
| `/profile` | Show the full help. Lost? Type this |
| `/profile list [--json]` | Roll call: an aligned table with 🟢/⚪, email, 5h/7d quota bars, reset times and tags 🏷️ |
| `/profile current [--json]` | The philosophical question "who am I?", answered with the active profile name |
| `/profile <name\|alias>` | Switch to profile or alias `<name>`. Claude won't even notice it changed owners |
| `/profile pick` | Pick with `↑` `↓`, for people who can't remember their own profile names |
| `/profile alias <name> <p>` | Give a profile a nickname (e.g. `/profile alias w work`). One letter beats a whole sentence |
| `/profile unalias <name>` | Drop a nickname. The profile itself is perfectly fine |
| `/profile aliases` | Your nickname phone book |
| `/profile new <name> [--force]` | Snapshot the logged-in account and file it as a new profile |
| `/profile save <name> [--force]`| Write the logged-in account into a profile, handy right after a fresh `/login` |
| `/profile rename <old> <new>` | Rename a profile. Aliases, project/branch bindings, history and budgets follow it, nothing is left behind |
| `/profile delete <name>` | A clean break: delete the profile and everything that belongs to it. There is no recycle bin |
| `/profile folder` | Open the profiles folder. Look, don't touch |
| `/profile lang [vi\|en]` | Show or change the language. Bilingual, no interpreter needed |
| `/profile version` | Which version am I running? |

### 🚀 Web, load balancing & utilities

| Command | Description |
| --- | --- |
| `/profile web [--port <p>]` | Open the Web Dashboard, for days when typing feels like too much |
| `/profile web stop` | Put the dashboard to bed |
| `/profile balance [on\|off]` | Turn load balancing on / off. When on, auto-switch picks the next profile by `mode` (instead of `auto order`) |
| `/profile balance mode <least-used\|round-robin>` | Pick a strategy: most quota left goes first, or everyone takes turns |
| `/profile balance pool <tag\|all>` | Only balance within a tagged group |
| `/profile balance next` | Pass the ball to the next profile right now |
| `/profile webhook [status]` | Which alert channels are on |
| `/profile webhook set <telegram\|discord\|slack\|generic> <url>` | Wire up alerts to Telegram, Discord, Slack or any URL |
| `/profile webhook unset <type>` | Mute one alert channel |
| `/profile webhook test` | Fire a test message to make sure the line works |
| `/profile budget [status]` | Show monthly spending caps |
| `/profile budget set <name> <amount>` | Set a spending cap for a profile. Your wallet says thanks |
| `/profile budget unset <name>` | Remove a spending cap. Live free, own the consequences |
| `/profile mask [on\|off]` | Mask emails while you screen-share (`us***@domain.com`) |
| `/profile share [file.json]` | Export config for teammates, without the house keys (tokens) |
| `/profile completion [bash\|zsh\|fish]` | Type half a word, hit Tab, let the shell do the rest |

### ⚡ Parallel sessions & tokens

| Command | Description |
| --- | --- |
| `/profile run <name> [-- cmd]` | Start another Claude Code on a different account, side by side, no toe-stepping. Shares skills, agents, plugins, settings, memory |
| `/profile add-token <tok> [name]` | Create a profile straight from a setup-token or API key, no browser needed |
| `echo $TOK \| node swap.js add-token - [name]` | Feed the token via `stdin` so it stays out of your shell history |
| `/profile upgrade` | Pull the latest version and reload it, no restart needed |
| `/profile disable <name>` | Send a profile on leave: auto-switch won't wake it up |
| `/profile enable <name>` | Leave is over, back into the auto-switch rotation |
| `/profile disabled [--json]` | Who's on leave |

### 🤖 Auto-switch & quota

| Command | Description |
| --- | --- |
| `/profile usage` | 5h, 7d and per-model quota (Opus, Sonnet, Haiku…), down to the percent |
| `/profile auto` | How auto-switch is set up right now |
| `/profile auto on` / `off` | Switch accounts automatically past the threshold. Turn it on and keep coding |
| `/profile auto threshold <%>` | Usage % that triggers a switch (default `95%`) |
| `/profile auto order <list>` | Who steps in first (e.g. `work,personal,backup`) |
| `/profile auto pool <tag\|all>`| Only switch within a tagged group |
| `/profile auto safeguard [on\|off\|<%>]` | Don't jump into an account that has nearly burned its weekly quota (default `85%`) |
| `/profile auto return [on\|off]` | Go back to the primary profile once it has recovered |
| `/profile auto primary <name>` | Choose "home" for auto-return |
| `/profile auto check` | Don't wait for the next prompt: check now, switch if over the line. Each prompt only asks for the current profile's quota, and asks everyone's only when it has to pick a replacement |
| `/profile forecast` | Predict when you'll run dry, based on your real burn rate |
| `/profile cooldown` | Countdown to the 5h quota coming back |
| `/profile doctor` | Full checkup: OAuth tokens, MCP logins, config files, connectivity |
| `/profile cleanup [--force]` | Find duplicate email/UUID profiles and broken tokens. Add `--force` to actually clean up |

### 📁 Projects, Git branches, tags & models

| Command | Description |
| --- | --- |
| `/profile bind [name]` | Bind a profile to this folder (`.claude-profile` file). Open the project, get the right account |
| `/profile unbind` | Unbind: this folder is free again |
| `/profile bind-branch <pat> [name]` | Bind a profile to a Git branch pattern (e.g. `feat/*`, `hotfix-*`). Checkout is a switch |
| `/profile unbind-branch [pat]`| Untie a branch |
| `/profile branch-bindings` | Which branch goes with which account |
| `/profile tag <name> <tag>` | Tag profiles into groups (e.g. `/profile tag work corp`) |
| `/profile untag <name> <tag>` | Peel the tag off. The profile won't hold a grudge |
| `/profile tags` | Who belongs to which group |
| `/profile affinity <model> <name>` | Give a model its own account (e.g. `opus`, which eats quota for breakfast) |
| `/profile affinity apply <model>` | Jump to the account assigned to that model |
| `/profile unaffinity <model>` | This model goes back to sharing with everyone |
| `/profile affinities` | Which model goes with which account |

### ⏳ Borrowing, history & backups

| Command | Description |
| --- | --- |
| `/profile temp <name> [time]` | Borrow a profile with a due time (e.g. `30m`, `1h`). It hands itself back |
| `/profile untemp` | Return it early, keep your reputation, back to your own profile |
| `/profile statusline` | Toggle the detailed status line: profile, 5h/7d bars, reset times, running-out warning (on by default) |
| `/profile prompt [shell]` | Snippets so `starship`, `zsh`, `bash`, `tmux`, `powershell` know who you are |
| `/profile notify [on\|off]` | Desktop notification on switch (off by default, for your sanity) |
| `/profile undo` | Swapped by mistake? Jump back to the previous profile (run it again to go forward) |
| `/profile history [n]` | Switch diary: who, when, why (10 lines by default) |
| `/profile stats` | How many manual, automatic and per-project switches |
| `/profile sync setup <path>` | Choose where the sync safe lives (a Dropbox folder, a network drive…) |
| `/profile sync push` | Send the encrypted safe to the sync spot |
| `/profile sync pull` | Bring the safe to this machine and open it |
| `/profile export <file>` | Lock every profile in an AES-256-GCM safe. Forget the password and it's gone |
| `/profile import-enc <file>` | Open the safe and bring the profiles home. Right password only |
| `/profile import <folder> [--force]` | Move raw profiles in from another folder |

> 🔑 **Backup passwords are never written to disk.** Provide one with `--password-stdin` (safest: `echo "$PW" | node swap.js export f.enc --password-stdin`), the `CLAUDE_SWAP_PASSWORD` environment variable, or `--password <pw>` (which leaves it in your shell history, so use it only if you trust that history).

---

## 🖥️ What it looks like

### `/profile list`:

```text
   PROFILE   EMAIL                5H                 7D                 RESET 5H  RESET 7D
───────────────────────────────────────────────────────────────────────────────────────────
🟢 work      work@company.com     [███░░░░░]  32%    [█████░░░]  64%    2h10m     3d4h
⚪ personal  user@gmail.com       [███████░]  85%🔥  [███░░░░░]  40%    48m       1d9h  🏷️ side
⚪ dev       dev@example.com      —                  —                  —         —     (disabled)
```

The reset columns tell you how long until each quota window recovers, so you know whether to wait or switch.

*Bar colours, traffic-light style:*
- 🟢 green `< 50%`: relax
- 🟡 yellow `< 80%`: keep an eye on it
- 🟠 orange `< 95%`: start rationing, from `80%` you also get a 🔥
- 🔴 red `≥ 95%`: auto-switch is putting its shoes on

### Detailed status line (`/profile statusline`):

On by default, a multi-colour band right above the input box (not Claude Code's own one-colour status line, which can only draw plain text). It refreshes whenever you send a prompt, and the bars and percentages change colour with the load:

```text
● work │ 5h [███░░░░░] 32% ⏳2h10m │ 7d [█████░░░] 64% ⏳3d4h │ ⚠ 5h ~12p
```

`⏳` is the time left until the reset. `⚠ 5h ~12p` only appears when the burn rate says this profile will reach the auto-switch threshold within about 30 minutes. Type `/profile statusline` to toggle it.

### Colours in the output

Human-facing commands (`swap`, `undo`, `history`, `stats`, `forecast`, `tag`, `alias`...) are coloured by meaning: errors red, success green, profile names yellow, titles cyan. Commands that the hook or your shell has to parse (`current`, `statusline`, `auto check`, `--json`) always stay plain. To turn colour off: `--no-color` or the `NO_COLOR=1` environment variable.

### From a regular terminal, outside Claude Code:

```bash
node swap.js list
node swap.js swap work
node swap.js usage
node swap.js balance on
node swap.js web
```

---

## 🔀 Parallel sessions

Two accounts, two windows, at the same time, without fighting over tokens:

```bash
# Start a separate Claude Code for the work profile
node swap.js run work

# Or run any command in the work profile's environment
node swap.js run work -- claude --model sonnet
```

Each session lives in `~/.config/claude-cli-profiles/.sessions/<name>` with its own `CLAUDE_CONFIG_DIR`. Skills, agents, plugins, settings, `CLAUDE.md` and memory are symlinked in from `~/.claude`, so the extra session still has all your tools; only the login is per profile. When it ends, refreshed tokens are synced back into the profile. If someone logs into a different account inside that session, the plugin won't copy it into the profile by mistake.

---

## 🧠 Under the hood

Each profile is a file `~/.config/claude-cli-profiles/<name>.json` (mode `0600`, folder `0700`, so nobody else can read it), containing:

- The login keys from `~/.claude.json`: `oauthAccount`, `primaryApiKey`, `customApiKeyResponses`.
- The OAuth token from `~/.claude/.credentials.json`, or the Keychain on macOS.

Skills, agents, plugins, settings and memory live in `~/.claude/` and **belong to no profile**: switching accounts doesn't lose any of them.

**When you switch:**
- Only those login keys are replaced. **Project settings, preferences and history in `~/.claude.json` stay as they are.** We swap the car keys, not the car.
- Before switching, the current profile's latest token is saved, in case Claude Code quietly refreshed it.
- Every file is written to a temp file and then renamed (atomic write), with a `.bak` copy. A power cut mid-write won't cost you a profile.
- The credentials file also holds `mcpOAuth`, the MCP servers' own logins. Those belong to the machine, not the account, so a switch keeps the live ones instead of restoring the profile's old snapshot. That's why MCP doesn't ask you to log in again.
- If you set `CLAUDE_CONFIG_DIR`, the plugin works with that folder instead of `~/.claude`.
- On macOS the token goes into the Keychain via `stdin`, never on the command line, so `ps` can't see it.

**Keeping secrets secret:**
- Tokens, credentials and backup passwords never appear on a child process's command line, never get printed, and never reach the dashboard.
- Webhook URLs (which carry a Telegram bot token or a Discord/Slack secret) are stored in full, but the dashboard only shows the domain. Type a new URL to change one; leave the field empty to keep it.
- A corrupt profile reports "invalid JSON" instead of quoting the file in the error, so no token fragment ends up in your terminal.
- `.bak` copies are created `0600` from the very first byte, with no window for anyone else to peek.

---

## 🩹 Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Ran `/profile upgrade` but still see the old UI | Claude Code only reloads the installed copy. Since v0.4.1 the plugin calls `/reload-plugins` itself after an update. If you are on an older version, type `/reload-plugins` once (or restart); later upgrades are automatic. |
| `/profile foo bar` prints "Usage: ..." | `foo` isn't in the version you're running. Check `/profile version`, then `/profile upgrade`. |
| Odd text like `[38;5;248m` before an email | The chat box doesn't understand some colour codes. Since v0.4.2 the plugin only uses codes verified to draw. Upgrade to fix it. |
| MCP asks to log in again after a switch | Since v0.4.0 MCP logins are kept across switches. `claude.ai ...` connectors are tied to the account, so they change with it and can't be kept. Run `/profile doctor` to see which MCP logins expired with no refresh token. |
| `list` shows `—` in a quota column | No data for that profile yet (quota not fetched, token expired, or an API key). `/profile list --refresh` asks again. |
| Status line is missing | The coloured band needs v0.4.3 or newer. You may have turned it off: type `/profile statusline` to enable it. It refreshes when you send a prompt. |
| Want the new dashboard | `/profile web stop`, then `/profile web`, and open the link that includes `#token`. |

---

## 🌐 Languages

Speaks **Vietnamese** by default, and **English** too:

```bash
/profile lang           # which language is active
/profile lang en        # switch to English
/profile lang vi        # back to Vietnamese
```

Or force it with an environment variable:
```bash
export CLAUDE_SWAP_LANG=en
```

(A few rare messages are still Vietnamese-only. Consider it a free language lesson.)

---

## 🛠️ Development & testing

```bash
npm test                   # 66 unit tests for swap.js & web.js (node --test)
claude plugin validate .   # validate the manifest and hooks
claude plugin test .       # 11 plugin hook tests
```

Tests use temp folders and fake tokens, so you can run them as often as you like without touching your real accounts.

### Project layout:

```text
claude-swap/
├── swap.js               # All the logic: profiles, credentials, sync, usage, CLI
├── web.js                # Web Dashboard, REST API and built-in docs
├── package.json          # Metadata and test script
├── hooks/
│   ├── hooks.json        # Hook registration for Claude Code
│   ├── register.tsx      # session.start, prompt.submit and the /profile command
│   └── register.test.ts  # Plugin hook tests (15 tests)
├── test/
│   └── swap.test.js      # Unit tests for swap.js & web.js (66 tests)
├── LICENSE               # MIT
└── .claude-plugin/       # Plugin manifest & marketplace
```

---

## 📄 License

[MIT](LICENSE). Use it freely, just don't use it to get around Anthropic's terms of service.
