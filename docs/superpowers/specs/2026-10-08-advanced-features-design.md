# Advanced Features Design Specification for claude-swap

**Goal:** Implement 5 advanced capabilities for the `claude-swap` Claude Code plugin:
1. **Per-Project Profile Binding** (`bind`, `unbind`, auto-switch on session start in project directory)
2. **Desktop & System Notifications** (`notify on|off`, OS native notifications on auto-switch)
3. **Profile Tagging & Pools** (`tag`, `untag`, `tags`, filtering auto-switch by pool)
4. **Encrypted Export & Import** (`export`, `import-enc` with AES-256-GCM using `node:crypto`)
5. **Swap History & Analytics** (`history`, `stats` tracking manual, auto, and project swaps)

---

## 1. Per-Project Profile Binding

### Behavior
- Users can bind a profile to the current working directory.
- Storage:
  - Local marker: `.claude-profile` in the project root containing the profile name.
  - Global registry fallback: `~/.config/claude-cli-profiles/.project-bindings.json` mapping canonical path -> profile name.
- When Claude Code starts a session (`session.start` in `register.ts`):
  - Checks if current directory (or ancestor containing `.claude-profile` / registered path) has a bound profile.
  - If bound profile exists and differs from current active profile:
    - Auto-switches to the bound profile.
    - Records history as `{ type: 'project' }`.
    - Updates status bar to `● <profile> (Project)`.
- Commands:
  - `/profile bind <profile>` (defaults to current active profile if omitted).
  - `/profile unbind`: removes binding for current directory.

---

## 2. Desktop Notifications

### Behavior
- When an auto-switch occurs during session (via `prompt.submit` or `/profile auto check`), sends an OS native notification if notifications are enabled.
- Platform implementations (non-blocking, spawned detached):
  - Linux: `notify-send "claude-swap" "Đã tự động chuyển từ '<from>' sang '<to>' (quota: <util>%)"`
  - macOS: `osascript -e 'display notification "Đã tự động chuyển từ \"<from>\" sang \"<to>\"" with title "claude-swap"'`
  - Windows: PowerShell `[Windows.UI.Notifications.ToastNotificationManager, ...]` or `msg` fallback.
- Config stored in `~/.config/claude-cli-profiles/.notification-config.json` (`{ enabled: true }`).
- Commands:
  - `/profile notify on|off`: toggles notifications.
  - `/profile notify`: views current status.

---

## 3. Profile Tagging & Pools

### Behavior
- Profiles can have zero or more tags (e.g. `work`, `personal`, `unlimited`, `backup`).
- Profile JSON format updated to store `"tags": ["work", "primary"]`.
- Auto-switch integration:
  - `/profile auto pool <tag>`: restricts auto-switching to only candidates carrying the given tag.
  - `/profile auto pool all`: allows all profiles.
- Commands:
  - `/profile tag <profile> <tag>`: adds a tag.
  - `/profile untag <profile> <tag>`: removes a tag.
  - `/profile tags`: lists all tags and their associated profiles.

---

## 4. Encrypted Export & Import

### Behavior
- Export all profiles and configurations into an encrypted container file.
- Cryptography using standard `node:crypto`:
  - KDF: PBKDF2 (SHA-512, 100,000 iterations, 32-byte salt).
  - Cipher: AES-256-GCM (12-byte random IV, 16-byte auth tag).
  - Container format: Single JSON container with `{ version: 1, kdf: "pbkdf2", salt, iv, tag, ciphertext }`.
- Export payload contains:
  - Map of profile names to profile JSON contents.
  - Auto-switch configuration.
  - Project bindings.
- Commands:
  - `/profile export <path> [--password <pwd>]` (prompts or takes argument).
  - `/profile import-enc <path> [--password <pwd>] [--force]`.

---

## 5. Swap History & Analytics

### Behavior
- Every profile change (manual `/profile <name>`, automatic auto-switch, or project directory auto-binding) appends an entry to `~/.config/claude-cli-profiles/.swap-history.json`.
- Entry format:
  ```json
  {
    "timestamp": "2026-10-08T12:00:00.000Z",
    "from": "work",
    "to": "personal",
    "type": "auto | manual | project",
    "reason": "threshold exceeded (96% >= 95%)",
    "cwd": "/path/to/project"
  }
  ```
- Maximum entries capped at 100 (FIFO pruning).
- Commands:
  - `/profile history`: displays the last 10 swaps formatted with timestamp, type icon (🔄 Auto, 👤 Manual, 📁 Project), and profile names.
  - `/profile stats`: summarizes total swaps, count per type, and most active profile.
