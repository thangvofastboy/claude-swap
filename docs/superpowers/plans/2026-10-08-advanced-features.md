# Advanced Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 5 advanced features for `claude-swap`: project binding, desktop notifications, tagging/pools, encrypted export/import, and swap history & analytics.

**Architecture:** Extend `swap.js` with modular functions for each subsystem, expose them via CLI subcommands, wire directory checks and notification hooks into `hooks/register.ts`, and test thoroughly with unit and plugin test suites.

**Tech Stack:** Node.js standard modules (`node:crypto`, `node:fs`, `node:path`, `node:child_process`, `node:os`), `claude-code` plugin API and `claude-code/testing`.

**Spec:** `docs/superpowers/specs/2026-10-08-advanced-features-design.md`

## Global Constraints

- Zero external dependencies (only standard Node.js built-ins).
- 100% backward compatible with existing profiles and auto-switch configuration.
- Non-blocking execution for external notification commands (`notify-send`, `osascript`).
- Pass `npm test`, `claude plugin validate .`, and `claude plugin test .`.

---

### Task 1: Per-Project Profile Binding

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] **Step 1: Write failing tests in `test/swap.test.js`**
  Test `bindProfile`, `unbindProfile`, `getBoundProfile` across local `.claude-profile` and global mapping.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npm test`
- [ ] **Step 3: Implement project binding functions in `swap.js`**
  Implement `projectBindingsFile`, `loadProjectBindings`, `bindProfile`, `unbindProfile`, `getBoundProfile(dir)`. Add CLI `bind` and `unbind` commands.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npm test`
- [ ] **Step 5: Commit**
  ```bash
  git add swap.js test/swap.test.js
  git commit -m "feat: implement per-project profile binding"
  ```

---

### Task 2: Desktop & System Notifications

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] **Step 1: Write failing tests in `test/swap.test.js`**
  Test notification config toggle (`loadNotificationConfig`, `saveNotificationConfig`) and notification dispatch invocation.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npm test`
- [ ] **Step 3: Implement notifications in `swap.js`**
  Implement `sendNotification(title, message, options)` supporting Linux (`notify-send`), macOS (`osascript`), Windows (PowerShell). Add CLI `notify [on|off]` command.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npm test`
- [ ] **Step 5: Commit**
  ```bash
  git add swap.js test/swap.test.js
  git commit -m "feat: implement desktop notification system"
  ```

---

### Task 3: Profile Tagging & Pool Filtering

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] **Step 1: Write failing tests in `test/swap.test.js`**
  Test adding/removing tags on profiles, listing tags, and auto-switch filtering candidate profiles by pool.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npm test`
- [ ] **Step 3: Implement tagging and pool filter in `swap.js`**
  Implement `addProfileTag`, `removeProfileTag`, `getProfileTags`, `listAllTags`, update `findNextProfile` to respect `config.pool`. Add CLI `tag`, `untag`, `tags`, and `auto pool <tag|all>`.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npm test`
- [ ] **Step 5: Commit**
  ```bash
  git add swap.js test/swap.test.js
  git commit -m "feat: implement profile tags and pool filtering"
  ```

---

### Task 4: Encrypted Export & Import (AES-256-GCM)

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] **Step 1: Write failing tests in `test/swap.test.js`**
  Test exporting all profiles to encrypted file with password, decrypting and importing, and rejecting wrong password.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npm test`
- [ ] **Step 3: Implement encryption/decryption in `swap.js`**
  Implement `exportEncryptedProfiles(home, targetPath, password)` and `importEncryptedProfiles(home, sourcePath, password, overwrite)` using PBKDF2 + AES-256-GCM. Add CLI `export` and `import-enc` commands.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npm test`
- [ ] **Step 5: Commit**
  ```bash
  git add swap.js test/swap.test.js
  git commit -m "feat: implement AES-256-GCM encrypted export and import"
  ```

---

### Task 5: Swap History & Analytics

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] **Step 1: Write failing tests in `test/swap.test.js`**
  Test recording swaps, reading history, and calculating usage analytics.
- [ ] **Step 2: Run tests to verify failure**
  Run: `npm test`
- [ ] **Step 3: Implement history & analytics in `swap.js`**
  Implement `recordSwapHistory(home, entry)`, `loadSwapHistory(home)`, `formatSwapHistory(home)`, `formatSwapStats(home)`. Add CLI `history` and `stats` commands.
- [ ] **Step 4: Run tests to verify pass**
  Run: `npm test`
- [ ] **Step 5: Commit**
  ```bash
  git add swap.js test/swap.test.js
  git commit -m "feat: implement swap history tracking and analytics"
  ```

---

### Task 6: Hook Integration, Validation & Documentation

**Files:**
- Modify: `hooks/register.ts`
- Modify: `hooks/register.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Wire session.start project check & notification into `hooks/register.ts`**
  On `session.start`, check project binding and swap if needed. On auto-swap in `prompt.submit`, trigger desktop notification.
- [ ] **Step 2: Update `hooks/register.test.ts`**
  Add test cases for project binding check on `session.start` and new subcommands.
- [ ] **Step 3: Run full verification suite**
  Run `npm test`, `claude plugin validate .`, and `claude plugin test .`.
- [ ] **Step 4: Update `README.md`**
  Document the new commands and usage patterns.
- [ ] **Step 5: Commit**
  ```bash
  git add hooks/register.ts hooks/register.test.ts README.md
  git commit -m "feat: integrate advanced features into plugin hooks and update documentation"
  ```
