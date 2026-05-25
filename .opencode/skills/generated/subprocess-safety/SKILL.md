---
generated: true
generator: skill-improver
generator_version: "2026-05-25"
source_entries:
  - AGENTS.md#invariant-3
  - docs/engineering-invariants.md#subsection-3
---

# Subprocess Safety

Load before modifying any file that calls `spawn`, `spawnSync`, `bunSpawn`,
or `child_process` from Node/Bun.

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
2. `stdin: 'ignore'` (unless intentionally interactive)
3. `cwd` or `git -C <directory>` for explicit working directory
4. `proc.kill()` in a `finally` block or equivalent cleanup path

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
