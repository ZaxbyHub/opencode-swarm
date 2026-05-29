---
name: subprocess-safety
description: Guidelines for safe subprocess calls in opencode-swarm. Load before adding, modifying, or reviewing any file that calls spawn, spawnSync, bunSpawn, or child_process. Covers the six required properties, Windows portability, _internals DI seam pattern, and verification grep.
---

# Subprocess Safety

Read, in order:

1. `AGENTS.md` (Invariant 3: subprocesses)
2. `docs/engineering-invariants.md` (subsection 3)
3. `.agents/skills/writing-tests/SKILL.md` if tests are touched
4. `.opencode/skills/generated/mock-to-internals-migration/SKILL.md` if converting mock.module to _internals

Codex-specific execution notes:
- This skill consolidates AGENTS.md Invariant 3 into an actionable checklist.
- The canonical spawn shape and six required properties are non-negotiable per AGENTS.md.
- The CI quality job enforces these via `scripts/check-invariants.sh` (Check 1: subprocess timeout).
- Violations are advisory in CI but blocking in code review.

## When to use this skill

- You are adding, modifying, or reviewing a subprocess call (`bunSpawn`, `spawn`,
  `spawnSync`, `child_process.execFile`, etc.)
- You are writing or updating tests that exercise subprocess-dependent code
- A PR review flags a subprocess call missing timeout, cwd, or cleanup

## Scope

This skill applies to all files that spawn child processes:
- `src/utils/git*.ts`
- `src/hooks/*.ts`
- `src/tools/*.ts`
- `src/services/*.ts`
- `src/plugins/*.ts`
- `src/index.ts` (init-path subprocesses)
- Any test file (`tests/**`) that stubs or exercises subprocess code

## Canonical spawn shape

Every subprocess call MUST follow this pattern:

```typescript
const PER_CALL_TIMEOUT_MS = 10_000; // module-level constant (choose an appropriate value)

const proc = bunSpawn(['git', '-C', dir, 'rev-parse', '--show-toplevel'], {
  stdin: 'ignore',
  cwd: dir,
  timeout: PER_CALL_TIMEOUT_MS,
  // stdout/stderr: piped, bounded, or ignored
});
try {
  const result = await proc;
  // process result
} finally {
  proc.kill(); // best-effort cleanup
}
```

## Six required properties

| Property | Required | Rationale |
|----------|----------|-----------|
| Array-form args | Yes | No shell-string commands (injection risk, quoting hell) |
| `cwd` or `git -C` | Yes | Never rely on inherited process.cwd() |
| `stdin: 'ignore'` | Yes | A never-closed stdin pipe under Bun/Windows can block child exit (v7.3.3) |
| `timeout: <ms>` | Yes | No subprocess is "always fast" on every platform |
| stdout/stderr bounded | Yes | Never leave piped stream unattended on long-running child |
| `proc.kill()` in `finally` | Yes | Outer withTimeout lets awaiter proceed but doesn't abort child |

## execFile callback vs execFileSync distinction

`child_process.execFile` (callback form) and `child_process.execFileSync` have different
default stdio behavior:

| API | Default stdin | Risk |
|-----|---------------|------|
| `execFileSync` | `'inherit'` | Child inherits parent stdin — **v7.3.3 vector** on Windows/Bun if stdin is never closed |
| `execFile` (callback) | `'pipe'` | Child gets an internal pipe — lower risk but still not ideal for defense-in-depth |

**Key differences from the canonical spawn pattern:**

1. **`proc.kill()` in `finally` (line 69)**: Not applicable to callback-form `execFile`.
   The function does not return a `ChildProcess` reference. Instead, the `timeout`
   option triggers internal `SIGTERM` when exceeded. The callback is invoked only
   after the process exits — no zombie risk.

2. **`stdin: 'ignore'` (line 66)**: Technically default-safe for callback `execFile`
   (stdin is piped, not inherited). However, always add `stdio: ['ignore', 'pipe', 'pipe']`
   for defense-in-depth and consistency with `execFileSync` calls. Note: Bun's
   TypeScript definitions do not include `stdio` in `ExecFileOptions` — use
   `execOpts as any` when passing stdio to callback-form `execFile`.

3. **`execFileSync` should always use `stdio: ['ignore', 'pipe', 'pipe']`** to
   prevent the stdin-inheritance hang on Windows/Bun (v7.3.3).

## Windows-specific notes

- `.cmd` extensions: npm/bun binaries on Windows are `.cmd` wrappers. Resolve
  the executable path explicitly using `which`/`where` or the project's
  cross-platform helper. Do NOT enable `shell: true` or shell-mediated
  execution to work around PATH resolution.
- PATH differences: `cmd.exe` and PowerShell resolve PATH differently. Test on
  Windows, not just macOS/Linux.
- `child_process.spawn('bin', ...)` does not behave identically to running
  under `cmd.exe`. Use array-form args and explicit `cwd`.
- `fs.renameSync` cannot overwrite existing directories on Windows. Use a
  remove-then-rename pattern or `fs.rename` with error handling.

## Testing pattern: `_internals` DI seam, NOT `mock.module`

`mock.module(...)` leaks across test files in Bun's shared test-runner process.
Use dependency injection instead:

```typescript
// --- source file (e.g. src/utils/gitignore-warning.ts) ---
import { bunSpawn } from './bun-compat';

export const _internals: { bunSpawn: typeof bunSpawn } = { bunSpawn };

// In production code, call _internals.bunSpawn(...) instead of bunSpawn(...)

// --- test file ---
import { _internals } from '../../src/utils/gitignore-warning';
const real = _internals.bunSpawn;
beforeEach(() => { _internals.bunSpawn = stub; });
afterEach(() => { _internals.bunSpawn = real; });
```

For the full migration protocol, load the `mock-to-internals-migration` skill.

## Verification grep

After changing any file with subprocess calls, run:

```bash
grep -n "bunSpawn\|spawn(\|spawnSync(" src/<changed>/*.ts
```

Every match MUST have all of:
1. `timeout` set to a concrete millisecond value
2. `stdin: 'ignore'` (unless intentionally interactive; note: callback-form `execFile` uses `stdio: ['ignore', 'pipe', 'pipe']` instead)
3. `cwd` or `git -C <directory>` for explicit working directory
4. `proc.kill()` in a `finally` block or equivalent cleanup path (exception: callback-form `execFile` manages cleanup internally via `timeout` option)

## Historical failures

- **v7.0.3 (#704)**: repo-graph Desktop hang -- unbounded filesystem scan on
  plugin init. No timeout, no kill path. Result: "no agents in TUI/GUI" with
  no error message.
- **v7.3.3 (#732)**: Git-hygiene startup regression -- `ensureSwarmGitExcluded`
  called git without timeout, stdin, or kill. Result: same silent failure on
  Windows.

Both caused OpenCode to silently drop the plugin manifest. Users saw no agents
and no error. Every subprocess call is a potential repeat of these failures
unless all six properties are enforced.
