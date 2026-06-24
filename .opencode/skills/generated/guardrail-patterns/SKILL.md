---
name: guardrail-patterns
description: Guardrail patterns for opencode-swarm — pattern structure, bypass surfaces, regex anti-patterns, and test conventions for checkDestructiveCommand()
source_knowledge_ids:
  - 00cc0fba-5ed8-4e2c-9a3c-96675e09d175
  - b02ac9d7-9f2b-4ac0-9afe-5ee5f35f54c3
generated_at: 2026-06-22T00:00:00.000Z
status: active
version: 2
skill_origin: generated
provenance_note: >
  Re-linked to current knowledge entries (version 2). The original 4 source IDs
  (098926ef, 2c1e4689, 54c33fa4, 4f51d11a) are no longer present in the
  active knowledge store. The skill body and behavior are unchanged.
  New source_knowledge_ids reference current lessons about lint-script
  false positives (testing) and refactoring guards to separate functions
  (architecture), both directly relevant to guardrail patterns.
---

# Skill: Guardrail Patterns for opencode-swarm

**Source knowledge:** `098926ef`, `2c1e4689`, `54c33fa4`, `4f51d11a`

Load this skill **before** modifying `src/hooks/guardrails.ts` — adding, removing, or changing guardrail blocks in `checkDestructiveCommand()`. It documents the pattern structure, known bypass surfaces, regex anti-patterns, and test conventions used across 41 guardrail test files and the ~3900-line guardrails.ts file.

## When to load this skill

Load before any change to:
- `src/hooks/guardrails.ts` — especially `checkDestructiveCommand()` or `dcNormalizeCommand()`
- `tests/unit/hooks/guardrails*.test.ts` — any guardrail test file
- Adding a new section (currently Sections 1–22) to `checkDestructiveCommand()`
- Adding regex patterns for shell command blocking

## Architecture overview

### `checkDestructiveCommand()` — the shell command guard

Located at `src/hooks/guardrails.ts` (line 1304). This is the **only** function that blocks destructive shell commands. It is invoked by the `toolBefore` hook in `guardrails.ts` before every `bash` or `shell` tool call.

**Pipeline (in order):**
1. `dcNormalizeCommand()` (line ~627) — NFKC normalization + evasion collapse: collapses `""` (doubled double-quotes) and `''` (doubled single-quotes). Single-quote splice like `m'v'` remains OPEN.
2. `dcStripOneWrapper()` (line ~664) — detects and strips individual shell wrappers: `bash`, `sh`, `zsh`, `dash`, `fish`, `pwsh`, `powershell`, `cmd` (with `-c`/`-Command`), `sudo`, `nohup`, `time`, `nice`, `env VAR=val`, `call` (batch), `Invoke-Command -ScriptBlock`, `& { }` script blocks, `wsl`, `iex`
3. `dcUnwrapWrappers()` (line ~737) — loops `dcStripOneWrapper` until no more wrappers remain (max depth 10)
4. `dcSplitSegments()` (line ~753) — splits compound commands on `&&`, `;`, `|`, newlines
5. Per-segment loop — each segment evaluated against 22+ guardrail sections
6. `dcValidateTargets()` — runtime `lstat`-ancestor walk on destructive targets

### Key normalization functions

| Function | Line | What it normalizes |
|---|---|---|
| `dcNormalizeCommand` | ~627 | NFKC, caret escapes (`^`), backtick escapes, collapsed `""` and `''` |
| `dcStripOneWrapper` | ~664 | Detects/strips a single shell wrapper (bash/sh/zsh/pwsh/cmd/powershell/wsl etc) |
| `dcUnwrapWrappers` | ~737 | Loops `dcStripOneWrapper` until no more wrappers (max depth 10) |
| `dcSplitSegments` | ~753 | Splits on `&&`, `;`, `|`, `\n` for per-segment checking |

**Known wrapper unwrapping limitation:** `sh -c` and `bash -c` with **single-quoted** inner commands (`sh -c 'mv ...'`) are NOT unwrapped because `dcStripOneWrapper` uses `"?` (optional double-quote). Only double-quoted inner commands are properly stripped.

## Adding a new guardrail block

### Step 1 — Determine the pattern placement

Inside `checkDestructiveCommand()`, the per-segment `for` loop evaluates each segment against sections 1–22. A new section should be added after the last existing section and before the closing `}` of the `for` loop (currently after Section 22 at approximately line 1733).

### Step 2 — Choose the regex pattern structure

There are three patterns used in the codebase:

**Pattern A — Simple inline regex (single condition):**
```typescript
// Good for: single-command blocking with no complex extraction
if (/^blockedcommand\b.*\.swarm[\x5c/\s]?/i.test(seg)) {
  throw new Error(`BLOCKED: "blockedcommand" targeting .swarm/ detected — ...`);
}
```

**Pattern B — Multi-condition (flag check + path check):**
```typescript
// Good for: archive tools with flags + .swarm/ path (prevents argument-order bypass)
if (
  /^toolname\b.*--dangerous-flag\b/i.test(seg) &&
  /\.swarm(?:[\x5c/\s]|$)/i.test(seg)
) {
```
This is **recommended** because it handles both `tool --flag .swarm/path` and `tool .swarm/path --flag` argument orders.

**Pattern C — Argument extraction + stripped check:**
```typescript
// Good for: commands where you need argument isolation (e.g., `mv` with arg capture)
if (/^\\?command\s/i.test(seg)) {
  const match = seg.match(/^\\?command\s+(.+)$/i);
  if (match) {
    const argsStr = match[1].replace(/["']/g, '');
    if (/\.swarm(?:[\x5c/\s]|$)/.test(argsStr)) {
      throw new Error(`BLOCKED: ...`);
    }
  }
}
```

### Step 3 — Handle all platform variants

POSIX, Windows cmd.exe, and PowerShell often use different commands for the same operation. All three must be covered:

```typescript
// POSIX section
if (/^\\?posix-cmd\s/i.test(seg) && /\.swarm/i.test(strippedArgs)) { ... }

// Windows cmd section (case-insensitive, optional .exe)
if (/^\\?(?:cmd-cmd|cmd-cmd-alias)(?:\.exe)?\s/i.test(seg) && /\.swarm/i.test(argsStr)) { ... }

// PowerShell section (case-insensitive, all aliases)
if (/^\\?(?:PowerShell-Cmdlet|alias1|alias2)\b.*\.swarm/i.test(seg)) { ... }
```

### Step 4 — Handle the `.swarm` path separator

Always use `\x5c` (backslash) for cross-platform path matching — `\` alone is the regex escape character.

```typescript
// Correct: matches both / and \
/\.swarm[\x5c/]/

// More complete: also matches .swarm followed by whitespace or end-of-string
// (catches whole-directory targeting like `mv .swarm /tmp/`)
/\.swarm(?:[\x5c/\s]|$)/
```

### Step 5 — Handle backslash-prefixed command evasion

Commands prefixed with `\` (e.g., `\mv`) bypass simple `^command\s` anchors. Always add `\\?`:

```typescript
// Correct: catches both mv and \mv
if (/^\\?mv\s/i.test(seg)) { ... }

// Correct for rm (uses \b instead of \s)
if (/^\\?rm\b/i.test(seg)) { ... }
```

## Known bypass surfaces (must document in adversarial tests)

These are documented bypass vectors that the current regex-based approach cannot fully close. Every new guardrail section should include adversarial tests for these patterns:

| Evasion | Example | Status | Mitigation |
|---|---|---|---|
| Backslash prefix | `\mv .swarm/file` | **CLOSED** | Add `^\\?` to command anchor |
| Quote splicing | `m'v' .swarm/file` | **OPEN** | Requires NFKC normalization change |
| Quoted command name | `"mv" .swarm/file` | **OPEN** | Requires NFKC normalization change |
| Shell wrapper (double-quoted) | `sh -c "mv .swarm/file"` | **CLOSED** | dcUnwrapWrappers handles `"` |
| Shell wrapper (single-quoted) | `sh -c 'mv .swarm/file'` | **OPEN** | dcUnwrapWrappers regex uses `"?` |
| Relative path prefix | `mv ./swarm/file` | **OPEN** | Requires path normalization |
| Env var expansion | `mv $SWARM_DIR/file` | **OPEN** | Requires variable resolution |
| Unicode fullwidth | `ｍｖ .swarm/file` | **OPEN** | Requires NFKC normalization |

## Regex anti-patterns (from prior bugs)

### Anti-pattern 1: `[^-]` consuming path characters
```typescript
// WRONG — [^-] consumes the first character of the path
if (/^rm\s+(?!\s*-)(?!-)[^-].*\.swarm/i.test(seg)) {
  // "rm .swarm/file" → [^-] consumes '.' → "swarm/file" doesn't match "\.swarm"
}

// CORRECT — use negative lookahead for flag exclusion
if (
  /^rm\b/i.test(seg) &&
  !/^rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/i.test(seg) &&
  /\.swarm(?:[\x5c/\s]|$)/i.test(seg)
) {
  // "rm .swarm/file" → BLOCKED ✓
  // "rm -rf .swarm/" → Section 3 handles ✓
  // "rm -v .swarm/file" → BLOCKED ✓
}
```

### Anti-pattern 2: Negative lookahead too broad (`(?!-\S)`)
```typescript
// WRONG — (?!-\S) excludes ALL flag-prefixed rm commands,
// but Section 3 only catches recursive/force flags
if (/^rm\s+(?!-\S).*\.swarm/i.test(seg)) {
  // "rm -v .swarm/file" → NOT blocked by S19 (excluded by lookahead)
  // "rm -v .swarm/file" → NOT blocked by S3 (no -r/-f flags)
}

// CORRECT — use three-part condition
```

### Anti-pattern 3: `.exec()` confused by SAST
```typescript
// WRONG — SAST confuses RegExp.prototype.exec() with child_process.exec()
const match = /^command\s+(.+)$/i.exec(seg);  // SAST false positive

// CORRECT — use String.prototype.match()
const match = seg.match(/^command\s+(.+)$/i);  // No SAST false positive
```

### Anti-pattern 4: Argument-order dependent patterns
```typescript
// WRONG — .swarm/ must appear AFTER the flag in the command string
if (/^tool\b.*--flag\b.*\.swarm/i.test(seg)) {
  // "tool --flag .swarm/" → BLOCKED ✓
  // "tool .swarm/ --flag" → NOT BLOCKED ✗
}

// CORRECT — split flag check and path check
if (/^tool\b.*--flag\b/i.test(seg) && /\.swarm(?:[\x5c/\s]|$)/i.test(seg)) {
  // Both argument orders BLOCKED ✓
}
```

## Test conventions

### Test file structure

```typescript
// Positive tests: "command → BLOCKED"
test('mv .swarm/evidence/file.json /tmp/ → BLOCKED', async () => { ... });

// Negative tests: "command → ALLOWED (reason)"
test('ls .swarm/evidence/ → ALLOWED (read-only)', async () => { ... });

// Bypass when feature is disabled
test('mv .swarm/file /tmp/ → ALLOWED when block_destructive_commands=false', async () => { ... });
```

### Test infrastructure pattern

```typescript
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';

const TEST_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'guardrail-pattern-')));

function defaultConfig(overrides?: Partial<GuardrailsConfig>): GuardrailsConfig {
  return {
    enabled: true,
    max_tool_calls: 200,
    max_duration_minutes: 30,
    idle_timeout_minutes: 60,
    max_repetitions: 10,
    max_consecutive_errors: 5,
    warning_threshold: 0.75,
    profiles: undefined,
    block_destructive_commands: true,
    ...overrides,
  };
}

function makeBashInput(sessionID = 'test-session', command: string) {
  // Note: command is accepted but passed to makeBashOutput, not makeBashInput
  return { tool: 'bash', sessionID, callID: 'call-1' };
}

function makeBashOutput(command: string) {
  return { args: { command } };
}
```

### Required test categories

Every new guardrail section MUST have tests for:
1. **Positive** — command targeting `.swarm/` is blocked
2. **Negative** — same command with non-`.swarm/` path is allowed
3. **Read-only** — read-only commands (ls, cat, find) are not blocked
4. **Config bypass** — verified unblocked when `block_destructive_commands: false`
5. **Platform variants** — POSIX, Windows cmd, PowerShell forms where applicable
6. **Adversarial** — documented bypass surfaces (one test per known evasion type)

### Key testing rules

- Use `bun:test` only (no Jest/Vitest)
- Use `rejects.toThrow(/BLOCKED/)` for positive assertions
- Use `resolves.toBeUndefined()` for negative assertions
- No hardcoded `/tmp` — use `os.tmpdir()` + `mkdtempSync`
- No hardcoded `C:\` strings
- Wrap `mkdtempSync` in `realpathSync` for macOS compatibility

## Section pattern reference (current guardrail sections 1–22)

| Section | Line | Commands blocked | Notes |
|---|---|---|---|---|
| 2 | ~1347 | Junction/symlink CREATION out-of-cwd | `dcCheckJunctionCreation` — creation of junctions/symlinks targeting outside cwd |
| 3 | ~1353 | `rm -r[Ff]*`, `rm -f -r`, etc | Recursive + force only (`[rRfF]+` flag set) |
| 4 | ~1378 | `rmdir /s`, `rd /s` | Windows cmd, recursive |
| 5 | ~1400 | `del /s` | Windows cmd |
| 6–7 | ~1418 | `Remove-Item -Recurse` + pipeline form | PowerShell |
| 8 | ~1457 | Ransomware-grade | vssadmin, wbadmin, diskpart, bcdedit, sdelete, fsutil, takeown, cipher, format, robocopy /MIR |
| 9 | ~1510 | `chmod -R 000`, `chattr +i`, `icacls /deny` | Permission denial-of-service |
| 10 | ~1529 | `dd` with /dev/zero/null/urandom | Data wipe |
| 11 | ~1538 | Git destructive | push --force, reset --hard, reset --mixed, clean -fd, worktree remove --force |
| 12 | ~1567 | `rsync --delete(-before/-after/-during/-delay)` | Mirror/sync with delete |
| 13 | ~1576 | `kubectl delete`, `docker system prune` | Cluster/container |
| 14 | ~1590 | `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE TABLE` | SQL DDL |
| 15 | ~1604 | `mkfs` | Disk format |
| 16 | ~1615 | `mv` | POSIX — blocked on `.swarm/` |
| 17 | ~1635 | `move`, `ren` | Windows cmd — blocked on `.swarm\` |
| 18 | ~1652 | `Move-Item`, `Rename-Item`, aliases | PowerShell — blocked on `.swarm/` |
| 19 | ~1667 | `rm` (non-recursive) | Blocked on `.swarm/` (recursive → Section 3) |
| 20 | ~1682 | `cp` + `rm` chain | Secondary defense (rm guard is primary) |
| 21 | ~1697 | `rsync --remove-source-files`, `tar --remove-files`, `zip -m`, `7z -sdel` | Archive tools with delete-source flags |
| 22 | ~1728 | `git clean -fd`, `git worktree remove --force` | Verified existing patterns cover `.swarm/` |

## Task checklist for adding a new guardrail block

- [ ] Pattern chosen (A/B/C) and placed in correct section order
- [ ] Command anchor includes `^\\?` (backslash prefix)
- [ ] `.swarm` path check uses `(?:[\x5c/\s]|$)` (whole-root + subpath)
- [ ] Argument-order independent (split flag check from path check)
- [ ] Platform variants covered (POSIX + cmd + PowerShell)
- [ ] `.exec()` → `.match()` to avoid SAST false positives
- [ ] Positive test: `.swarm/` path blocked
- [ ] Negative test: non-`.swarm/` path allowed
- [ ] Read-only test: read commands not blocked
- [ ] Config bypass test: `block_destructive_commands: false`
- [ ] Adversarial tests: document known bypasses
- [ ] `bun run build` succeeds
- [ ] `bunx biome ci .` clean
- [ ] All guardrail test suites pass
