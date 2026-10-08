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
| 🔤 **Aliases** | Tired of typing `work-company-production-2`? Call it `w` and run `/profile w`. |
| 🎛️ **Interactive picker** | `/profile pick` lets you choose with `↑` `↓`, for people who can't remember their own profile names. |
| ⚖️ **Load balancing** | Spread the work across accounts with `least-used` (whoever has the most quota left) or `round-robin` (take turns). No account carries the team alone. |
| 🔔 **Webhooks** | Ping Telegram, Discord, Slack or any webhook when you hit a threshold or switch accounts. Your phone buzzes, you know. |
| 💰 **Budgets** | Set a monthly spending cap per profile (`/profile budget`). Your wallet says thanks. |
| 🛡️ **Masking & safe sharing** | Emails show as `us***@domain.com` while you screen-share, and config exports leave tokens out (`/profile mask`, `/profile share`). |
| ⌨️ **Tab completion** | Completion scripts for Bash, Zsh and Fish (`/profile completion`). Type half a word, hit Tab. |
| 🚀 **Parallel sessions** | `/profile run <name>` starts a separate Claude Code on another account. Two Claudes, two accounts, nobody steps on anybody. |
| 🔑 **Setup-token & API key** | Create a profile straight from a token, no browser needed (`/profile add-token`). Reads from `stdin` too, so the token stays out of your shell history. |
| 🚫 **Time off** | `/profile disable <name>` benches a profile from auto-switch without deleting it. |
| 🌿 **Git branch binding** | `work-*` branches use the company account, `feat/*` use the dev one, automatically. No more side projects billed to your employer by accident. |
| 📁 **Folder binding** | Open a project and its profile turns on by itself (via a `.claude-profile` file). |
| 📈 **Forecast** | Measures burn rate in %/hour and predicts when you'll run dry (`/profile forecast`). It can predict everything except your deadline. |
| ⏱️ **Cooldown & auto-return** | Counts down to the 5-hour quota reset, then moves you back to your primary profile once it has recovered. |
| 🤖 **Auto-switch** | Hit the % threshold or a rate limit and it jumps to the account with the most quota left or the earliest reset. You just keep coding. |
| 🚨 **7-day safeguard** | Won't jump into an account that has nearly used up its weekly quota (default 85%). |
| 🧠 **Model affinity** | Opus on this account, Sonnet on that one (`/profile affinity`). |
| 🩺 **Doctor & cleanup** | Checks for expired tokens, duplicate accounts and broken files (`/profile doctor`, `/profile cleanup`). A GP for your credentials. |
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

Already installed and want the latest? `/profile upgrade`, then restart Claude Code.

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
| `/profile` | Show the full help |
| `/profile list [--json]` | List profiles with 🟢/⚪, email 👤, tags 🏷️ and usage bars |
| `/profile current [--json]` | Which profile is active |
| `/profile <name\|alias>` | Switch to profile or alias `<name>` |
| `/profile pick` | Pick a profile with `↑` `↓` |
| `/profile alias <name> <p>` | Set an alias (e.g. `/profile alias w work`) |
| `/profile unalias <name>` | Remove an alias |
| `/profile aliases` | List aliases |
| `/profile new <name> [--force]` | Create a profile from the logged-in account |
| `/profile save <name> [--force]`| Save the current login into a profile |
| `/profile delete <name>` | Delete a profile and clean up what belongs to it |
| `/profile folder` | Open the profiles folder |
| `/profile lang [vi\|en]` | Show or change the language |
| `/profile version` | Show the plugin version |

### 🚀 Web, load balancing & utilities

| Command | Description |
| --- | --- |
| `/profile web [--port <p>]` | Open the Web Dashboard |
| `/profile web stop` | Stop the Web Dashboard |
| `/profile balance [on\|off]` | Turn load balancing on / off. When on, auto-switch picks the next profile by `mode` (instead of `auto order`) |
| `/profile balance mode <least-used\|round-robin>` | Most quota left first, or take turns |
| `/profile balance pool <tag\|all>` | Only balance within a tagged group |
| `/profile balance next` | Switch to the next profile by the algorithm right now |
| `/profile webhook [status]` | Show webhook status |
| `/profile webhook set <telegram\|discord\|slack\|generic> <url>` | Set a webhook |
| `/profile webhook unset <type>` | Remove a webhook |
| `/profile webhook test` | Send a test message |
| `/profile budget [status]` | Show monthly budgets |
| `/profile budget set <name> <amount>` | Set a budget for a profile |
| `/profile budget unset <name>` | Remove a budget |
| `/profile mask [on\|off]` | Mask emails in list and dashboard |
| `/profile share [file.json]` | Export config without tokens |
| `/profile completion [bash\|zsh\|fish]` | Generate a Tab-completion script |

### ⚡ Parallel sessions & tokens

| Command | Description |
| --- | --- |
| `/profile run <name> [-- cmd]` | Run an isolated Claude Code session for a profile |
| `/profile add-token <tok> [name]` | Create a profile from a setup-token or API key |
| `echo $TOK \| node swap.js add-token - [name]` | Pass the token via `stdin` so it stays out of shell history |
| `/profile upgrade` | Update the plugin to the latest version |
| `/profile disable <name>` | Bench a profile from auto-switch |
| `/profile enable <name>` | Put it back on the team |
| `/profile disabled [--json]` | See who's benched |

### 🤖 Auto-switch & quota

| Command | Description |
| --- | --- |
| `/profile usage` | 5h, 7d and per-model quota (Opus, Sonnet, Haiku…) |
| `/profile auto` | Auto-switch status |
| `/profile auto on` / `off` | Turn auto-switch on / off |
| `/profile auto threshold <%>` | Usage % that triggers a switch (default `95%`) |
| `/profile auto order <list>` | Priority order (e.g. `work,personal,backup`) |
| `/profile auto pool <tag\|all>`| Only switch within a tagged group |
| `/profile auto safeguard [on\|off\|<%>]` | 7-day quota safeguard (default `85%`) |
| `/profile auto return [on\|off]` | Return to the primary profile once it recovers |
| `/profile auto primary <name>` | Set the primary profile |
| `/profile auto check` | Check quota now and switch if needed |
| `/profile forecast` | Burn rate and when you'll run out |
| `/profile cooldown` | Countdown to the 5h quota reset |
| `/profile doctor` | Check OAuth tokens, config files and connectivity |
| `/profile cleanup [--force]` | Find duplicate email/UUID profiles and broken tokens |

### 📁 Projects, Git branches, tags & models

| Command | Description |
| --- | --- |
| `/profile bind [name]` | Bind a profile to the current folder (`.claude-profile` file) |
| `/profile unbind` | Unbind the folder |
| `/profile bind-branch <pat> [name]` | Bind a profile to a Git branch pattern (e.g. `feat/*`, `hotfix-*`) |
| `/profile unbind-branch [pat]`| Unbind a branch pattern |
| `/profile branch-bindings` | List branch bindings |
| `/profile tag <name> <tag>` | Tag a profile (e.g. `/profile tag work corp`) |
| `/profile untag <name> <tag>` | Remove a tag |
| `/profile tags` | Which profiles carry which tags |
| `/profile affinity <model> <name>` | Assign a profile to a model (e.g. `opus`, `sonnet`) |
| `/profile affinity apply <model>` | Switch to the profile assigned to that model |
| `/profile unaffinity <model>` | Remove a model assignment |
| `/profile affinities` | List model assignments |

### ⏳ Borrowing, history & backups

| Command | Description |
| --- | --- |
| `/profile temp <name> [time]` | Borrow a profile for a while (e.g. `30m`, `1h`) |
| `/profile untemp` | Give it back now and return to your original profile |
| `/profile statusline` | Short status string for shell prompts (e.g. `[Claude: 🟢 work (32%)]`) |
| `/profile prompt [shell]` | Config snippet for `starship`, `zsh`, `bash`, `tmux`, `powershell` |
| `/profile notify [on\|off]` | Desktop notification on profile switch (off by default) |
| `/profile history [n]` | Recent switches (default 10) |
| `/profile stats` | Counts of manual, automatic and per-project switches |
| `/profile sync setup <path>` | Choose where encrypted sync backups live |
| `/profile sync push` | Push an encrypted backup |
| `/profile sync pull` | Pull and decrypt it |
| `/profile export <file>` | Export an AES-256-GCM encrypted backup |
| `/profile import-enc <file>` | Restore from an encrypted file |
| `/profile import <folder> [--force]` | Import raw profiles from another folder |

> 🔑 **Backup passwords are never written to disk.** Provide one with `--password-stdin` (safest: `echo "$PW" | node swap.js export f.enc --password-stdin`), the `CLAUDE_SWAP_PASSWORD` environment variable, or `--password <pw>` (which leaves it in your shell history, so use it only if you trust that history).

---

## 🖥️ What it looks like

### `/profile list`:

```text
🟢 work (Active)  👤 work@company.com  5h [███░░░░░] 32%   7d [█████░░░] 64%
⚪ personal       👤 user@gmail.com    5h [███████░] 85% ⚠   7d [███░░░░░] 40%
⚪ dev-account
```

*Bar colours, traffic-light style:*
- 🟢 `< 50%`: relax
- 🟡 `< 80%`: keep an eye on it
- 🟠 `< 95%`: start rationing
- 🔴 `≥ 95%`: auto-switch is putting its shoes on
- From `80%` up you also get a ⚠️, just to be sure.

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

Each session lives in `~/.config/claude-cli-profiles/.sessions/<name>` with its own `CLAUDE_CONFIG_DIR`. When it ends, refreshed tokens are synced back into the profile. If someone logs into a different account inside that session, the plugin won't copy it into the profile by mistake.

---

## 🧠 Under the hood

Each profile is a file `~/.config/claude-cli-profiles/<name>.json` (mode `0600`, folder `0700`, so nobody else can read it), containing:

- The login keys from `~/.claude.json`: `oauthAccount`, `primaryApiKey`, `customApiKeyResponses`.
- The OAuth token from `~/.claude/.credentials.json`, or the Keychain on macOS.

**When you switch:**
- Only those login keys are replaced. **Project settings, preferences and history in `~/.claude.json` stay as they are.** We swap the car keys, not the car.
- Before switching, the current profile's latest token is saved, in case Claude Code quietly refreshed it.
- Every file is written to a temp file and then renamed (atomic write), with a `.bak` copy. A power cut mid-write won't cost you a profile.
- If you set `CLAUDE_CONFIG_DIR`, the plugin works with that folder instead of `~/.claude`.
- On macOS the token goes into the Keychain via `stdin`, never on the command line, so `ps` can't see it.

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
npm test                   # 50 unit tests for swap.js & web.js (node --test)
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
│   ├── register.ts       # session.start, prompt.submit and the /profile command
│   └── register.test.ts  # Plugin hook tests (11 tests)
├── test/
│   └── swap.test.js      # Unit tests for swap.js & web.js (50 tests)
├── LICENSE               # MIT
└── .claude-plugin/       # Plugin manifest & marketplace
```

---

## 📄 License

[MIT](LICENSE). Use it freely, just don't use it to get around Anthropic's terms of service.
