# Advanced Features (Batch 2) Design Specification

## Overview

This specification details the architecture and requirements for the second batch of advanced features for `claude-swap`:
1. **Cooldown Watcher & Auto-Return**: Track quota reset countdowns and automatically switch back to the primary account once recovered.
2. **Profile Doctor & Health Check**: Comprehensive diagnostics for token validity, OAuth expiry, JSON integrity, and rate limits.
3. **7-Day Exhaustion Safeguard**: Protect weekly quotas by preventing auto-switching into accounts nearing their 7-day limit.
4. **Shell & Prompt Integrator**: Fast statusline output (<5ms) and prompt configuration snippets for Starship, Zsh, Bash, and Tmux.
5. **Ephemeral / Temporary Swap**: Borrow a profile for a limited time (e.g. `30m`, `1h`) with automatic reversion upon expiry.

## Global Constraints
- Pure Node.js built-ins only (zero external npm dependencies).
- Fast execution (no slow blocking calls in prompt/statusline hooks).
- Fully covered by automated tests (`npm test` and `claude plugin test .`).

---

## Detailed Specifications

### 1. Cooldown Watcher & Auto-Return
- **File**: `~/.config/claude-cli-profiles/.auto-switch.json`
- **Config Fields**:
  - `autoReturn: boolean` (default `false`)
  - `primaryProfile: string | null` (default `null`, fallback to `order[0]` or current profile at configuration time)
- **Functions**:
  - `formatCooldowns(home)`: Formats countdowns for all profiles based on `limits` or `resets_at_epoch`.
  - `checkAutoReturn(home, cache)`: Evaluates if primary profile has reset below threshold and switches back.
- **CLI Commands**:
  - `/profile cooldown`: Display reset timers for all profiles.
  - `/profile auto return [on|off]`: Toggle auto-return to primary profile.
  - `/profile auto primary [name]`: Set primary profile for auto-return.

### 2. Profile Doctor & Health Check
- **Function**: `diagnoseProfiles(home)`
- **Checks per profile**:
  - Valid JSON syntax and required `claude_json` field.
  - OAuth credentials inspection (`claudeAiOauth.expiresAt`).
  - Active rate limits (`retry_at` in cache).
  - 5h & 7d quotas >= 95%.
  - Sync state with active `~/.claude.json`.
- **CLI Command**:
  - `/profile doctor`: Run diagnosis and print colored status and action items.

### 3. 7-Day Exhaustion Safeguard
- **Config Field**: `safeguardThreshold: number | null` (default `85`, range `1-100` or `null`/`0` to disable)
- **Behavior**:
  - In `findNextProfile`, filter out any candidate whose 7-day utilization (`limits['7 ngày']`) >= `safeguardThreshold`.
  - In `autoCheckAndSwap`, trigger switch if current profile 7-day quota >= `safeguardThreshold`.
- **CLI Command**:
  - `/profile auto safeguard [on|off|<%>]`: Toggle or configure 7-day safeguard.

### 4. Shell & Prompt Integrator
- **Functions**:
  - `getStatusline(home)`: Returns string `[Claude: 🟢 <profile> (<util>%)]` or `[Claude: ⚪ (none)]` reading only local files (0 network requests).
  - `generatePromptSnippet(shell)`: Generates config snippets for `'starship'`, `'zsh'`, `'bash'`, `'tmux'`.
- **CLI Commands**:
  - `/profile statusline`: Print statusline string.
  - `/profile prompt [starship|zsh|bash|tmux]`: Output integration instructions and snippets.

### 5. Ephemeral / Temporary Swap
- **State File**: `~/.config/claude-cli-profiles/.temp-profile.json`
  ```json
  {
    "tempProfile": "work",
    "originalProfile": "personal",
    "expiresAt": 1728400000000
  }
  ```
- **Duration Parser**: `parseDuration(str)` parses `30s`, `15m`, `2h`, `1d` to milliseconds.
- **Functions**:
  - `tempSwap(home, name, durationStr)`: Saves state, performs swap.
  - `checkTempExpiry(home)`: Checks if temp profile expired, reverts to `originalProfile` if needed.
  - `cancelTempSwap(home)`: Manually reverts temp swap.
- **Hooks**:
  - Check `checkTempExpiry` in `prompt.submit` and `session.start`.
- **CLI Commands**:
  - `/profile temp <tên> <thời_gian>`: Switch temporarily.
  - `/profile untemp`: Revert temporary switch immediately.
