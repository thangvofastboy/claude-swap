# TypeScript Claude Swap Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Python script (`claude_swap.py`, `smoke_test.py`, `test_claude_swap.py`) and GUI entirely, rewriting all profile swap and usage features in native TypeScript for the Claude Code plugin.

**Architecture:** Pure TypeScript implementation consisting of `hooks/core.ts` for file-based profile management & macOS keychain support, `hooks/usage.ts` for Anthropic usage API queries & ANSI rendering, `hooks/register.ts` for Claude Code plugin lifecycle and `/profile` commands, and comprehensive tests in `hooks/register.test.ts`.

**Tech Stack:** TypeScript, Node.js built-ins (`node:fs`, `node:path`, `node:os`, `node:child_process`), standard Fetch API, `claude-code` plugin API and `claude-code/testing`.

**Spec:** Direct user instruction: "bỏ tính năng code python + gui chỉ giữ lại tính năng plugin cho claude thôi" with confirmed intent to migrate completely to native TypeScript.

## Global Constraints

- No external npm dependencies (rely only on Node built-ins and `claude-code` API).
- Zero Python requirements for end users.
- Profile storage path and format remain 100% compatible with existing profiles at `~/.config/claude-cli-profiles/`.
- All `/profile` subcommands (`list`, `<name>`, `new <name>`, `save <name>`, `delete <name>`, `usage`, `import <path>`, `folder`) must behave identically in CLI output and status line updates.
- Pass `claude plugin validate .` and `claude plugin test .`.

## Review Focus

- Corrupted or missing `~/.claude.json`: Graceful error message asking user to run `/login` first.
- Re-saving active profile token on swap: When swapping from profile A to B, automatically persist any refreshed token of profile A before loading profile B.
- Non-OAuth / API-key-only profiles: Clear credentials correctly so Claude doesn't leak prior account's OAuth token.
- Import path handling: Paths with spaces or unexpanded tildes correctly handled.
- Rate limits on Anthropic usage API (HTTP 429): Respect cached data and backoff rather than failing hard.

---

### Task 1: Core Profile Management in TypeScript (`hooks/core.ts`)

**Files:**
- Create: `hooks/core.ts`
- Test: `hooks/core.test.ts`

**Interfaces:**
- Produces:
  - `class SwapError extends Error`
  - `class ProfileExists extends SwapError`
  - `claudeJsonPath(home: string): string`
  - `credentialsPath(home: string): string`
  - `profilesDir(home: string): string`
  - `profilePath(home: string, name: string): string`
  - `listProfiles(home: string): string[]`
  - `currentProfile(home: string): string | null`
  - `profileEmail(home: string, name: string): string`
  - `saveProfile(home: string, name: string, force?: boolean): string`
  - `swapProfile(home: string, name: string): void`
  - `deleteProfile(home: string, name: string): void`
  - `importProfiles(home: string, folder: string, overwrite?: boolean): { added: string[], exists: string[], invalid: string[] }`
  - `openProfilesFolder(home: string): void`

- [ ] **Step 1: Write the failing test in `hooks/core.test.ts`**
  Covering create, list, current, swap (with active token persistence), delete, and import using a temporary directory.

- [ ] **Step 2: Run test to verify it fails**
  Run: `claude plugin test .`
  Expected: FAIL with missing module `core.ts`

- [ ] **Step 3: Implement `hooks/core.ts`**
  Implement core swap logic with atomic file writes, backup, JSON handling, and platform keychain / file credential support.

- [ ] **Step 4: Run test to verify it passes**
  Run: `claude plugin test .`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add hooks/core.ts hooks/core.test.ts
  git commit -m "feat(plugin): implement core profile management in TypeScript"
  ```

---

### Task 2: Usage Quota & Formatting in TypeScript (`hooks/usage.ts`)

**Files:**
- Create: `hooks/usage.ts`
- Test: `hooks/usage.test.ts`

**Interfaces:**
- Consumes:
  - `profilesDir`, `currentProfile`, `listProfiles`, `profileEmail`, `profilePath` from `hooks/core.ts`
- Produces:
  - `fetchUsage(token: string): Promise<any>`
  - `parseLimits(data: any): [string, number, string][]`
  - `profileUsage(home: string, name: string, active: boolean, options?: { fetch?: any, cache?: any, force?: boolean }): Promise<ProfileUsageRow>`
  - `usageReport(home: string, options?: { fetch?: any, force?: boolean, color?: boolean }): Promise<string>`
  - `profileListReport(home: string, options?: { color?: boolean }): string`

- [ ] **Step 1: Write failing tests in `hooks/usage.test.ts`**
  Test limit parsing (5h, 7d, model breakdown), usage caching, retry-after backoff, bar formatting, and ANSI colorized outputs.

- [ ] **Step 2: Run test to verify it fails**
  Run: `claude plugin test .`
  Expected: FAIL with missing `usage.ts`

- [ ] **Step 3: Implement `hooks/usage.ts`**
  Implement Anthropic usage API fetching, caching in `.usage-cache.json`, percentage bars, reset time formatting, and colorized reports matching the Python CLI styling.

- [ ] **Step 4: Run test to verify it passes**
  Run: `claude plugin test .`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add hooks/usage.ts hooks/usage.test.ts
  git commit -m "feat(plugin): implement usage fetching and ANSI reporting in TypeScript"
  ```

---

### Task 3: Hook Integration & Native Plugin Execution (`hooks/register.ts`)

**Files:**
- Modify: `hooks/register.ts`
- Modify: `hooks/register.test.ts`

**Interfaces:**
- Consumes:
  - `hooks/core.ts` and `hooks/usage.ts`
- Produces:
  - `register: Register` exporting `session.start` and `command.run` for `/profile`.

- [ ] **Step 1: Update `hooks/register.test.ts`**
  Update tests to test the native TypeScript plugin execution directly without mocking `python3 claude_swap.py`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `claude plugin test .`
  Expected: FAIL with old python calls

- [ ] **Step 3: Update `hooks/register.ts`**
  Replace `runSwap` (which spawned Python) with native invocations of `core.ts` and `usage.ts`. Handle status refresh, argument parsing, error messages, and folder opening.

- [ ] **Step 4: Run test to verify it passes**
  Run: `claude plugin test .`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add hooks/register.ts hooks/register.test.ts
  git commit -m "feat(plugin): wire native TypeScript implementation into register hook"
  ```

---

### Task 4: Remove Python & GUI Code and Clean Up Repository

**Files:**
- Delete: `claude_swap.py`
- Delete: `smoke_test.py`
- Delete: `test_claude_swap.py`
- Modify: `.gitignore`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `README.md`

- [ ] **Step 1: Remove Python files and test artifacts**
  Remove `claude_swap.py`, `smoke_test.py`, `test_claude_swap.py`.

- [ ] **Step 2: Update manifests and documentation**
  Update `README.md` to document the zero-dependency pure TypeScript plugin, remove GUI/Python prerequisites, and describe `/profile` command usage. Update `plugin.json` description.

- [ ] **Step 3: Verify plugin validity and all tests**
  Run: `claude plugin validate .` and `claude plugin test .`
  Expected: Validation passed, all test suites pass.

- [ ] **Step 4: Commit**
  ```bash
  git rm claude_swap.py smoke_test.py test_claude_swap.py
  git add .gitignore README.md .claude-plugin/
  git commit -m "chore: remove Python and GUI code, convert to pure TypeScript plugin"
  ```
