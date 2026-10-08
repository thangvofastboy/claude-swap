# Batch 2 Advanced Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 5 advanced features: Cooldown Watcher & Auto-Return, Profile Doctor, 7-Day Safeguard, Shell & Prompt Integrator, and Ephemeral/Temporary Swap.

**Architecture:** Pure Node.js built-ins in `swap.js`, hook integration in `hooks/register.ts`, CLI dispatcher, and automated test coverage.

**Tech Stack:** Node.js (v18+), `node:test`, `node:assert/strict`, `node:crypto`, `node:fs`, `node:path`.

**Spec:** `docs/superpowers/specs/2026-10-08-batch2-features-design.md`

## Global Constraints
- Zero external dependencies.
- No network requests during prompt submit or statusline calls (read local cache only).
- Non-blocking execution and atomic file writes.

## Review Focus
- Duration parsing: handle invalid strings gracefully (throw SwapError with clear message).
- Temp swap expiry: revert cleanly if original profile still exists; handle missing original profile gracefully.
- Cooldown formatting: handle dates in past or missing resets_at cleanly.
- Doctor check: handle corrupt JSON or missing files without unhandled exceptions.
- 7-Day safeguard: ensure fallback candidates exist when all exceed 7d limit.

---

### Task 1: Cooldown Watcher & Auto-Return

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] Write failing test for `formatCooldowns` and `auto return` config/switching in `test/swap.test.js`.
- [ ] Implement `formatCooldowns(home, cache)` in `swap.js`.
- [ ] Implement `autoReturn` and `primaryProfile` in `autoSwitchConfig` and `autoCheckAndSwap`.
- [ ] Add CLI commands `cooldown`, `auto return [on|off]`, `auto primary [name]`.
- [ ] Run `npm test` and verify tests pass.
- [ ] Commit Task 1.

---

### Task 2: Profile Doctor & Health Check

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] Write failing test for `diagnoseProfiles(home)` in `test/swap.test.js`.
- [ ] Implement `diagnoseProfiles(home)` in `swap.js` checking JSON validity, OAuth expiry, rate limits, and 5h/7d quotas.
- [ ] Implement `formatDiagnostics(diagnostics)` and CLI `case 'doctor'`.
- [ ] Run `npm test` and verify tests pass.
- [ ] Commit Task 2.

---

### Task 3: 7-Day Exhaustion Safeguard

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] Write failing test for 7-day safeguard filtering and auto-switch triggering in `test/swap.test.js`.
- [ ] Add `safeguardThreshold` to `loadAutoSwitchConfig` and `saveAutoSwitchConfig` (default 85%).
- [ ] Update `findNextProfile` to filter out candidates where 7d usage >= `safeguardThreshold`.
- [ ] Update `autoCheckAndSwap` to trigger if current 7d usage >= `safeguardThreshold`.
- [ ] Add CLI `auto safeguard [on|off|<%>]`.
- [ ] Run `npm test` and verify tests pass.
- [ ] Commit Task 3.

---

### Task 4: Shell & Prompt Integrator

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] Write failing test for `getStatusline` and `generatePromptSnippet`.
- [ ] Implement `getStatusline(home)` in `swap.js`.
- [ ] Implement `generatePromptSnippet(shell)` in `swap.js` supporting `starship`, `zsh`, `bash`, `tmux`.
- [ ] Add CLI `statusline` and `prompt [type]`.
- [ ] Run `npm test` and verify tests pass.
- [ ] Commit Task 4.

---

### Task 5: Ephemeral / Temporary Swap

**Files:**
- Modify: `swap.js`
- Test: `test/swap.test.js`

- [ ] Write failing test for duration parsing, `tempSwap`, `checkTempExpiry`, and `cancelTempSwap`.
- [ ] Implement `parseDuration(str)` in `swap.js`.
- [ ] Implement `tempSwap(home, name, durationStr)`, `loadTempProfile(home)`, `checkTempExpiry(home)`, `cancelTempSwap(home)`.
- [ ] Add CLI `temp <name> <duration>` and `untemp`.
- [ ] Run `npm test` and verify tests pass.
- [ ] Commit Task 5.

---

### Task 6: Hook Integration, Validation & Documentation

**Files:**
- Modify: `hooks/register.ts`
- Modify: `hooks/register.test.ts`
- Modify: `README.md`

- [ ] Wire `temp check` into `prompt.submit` and `session.start` hooks.
- [ ] Add subcommands `cooldown`, `doctor`, `statusline`, `prompt`, `temp`, `untemp` to `SUBCOMMANDS` and `USAGE`.
- [ ] Update `hooks/register.test.ts` to test new commands.
- [ ] Update `README.md` with complete documentation for all new features.
- [ ] Verify full test suite: `npm test && claude plugin validate . && claude plugin test .`.
- [ ] Commit Task 6.
