# Plugin TUI stability hardening

## What changed
Removed SIGINT/SIGTERM signal handlers from the plugin entry point and guarded previously unguarded `console.warn()` calls with `config.quiet` checks.

## Why
During multi-agent swarm sessions, the OpenCode host TUI can display "Abort" text on every output line — a rendering bug in the host (`anomalyco/opencode`). Investigation confirmed the plugin cannot produce this text, but two plugin behaviors could contribute to host TUI instability:

1. The plugin registered `process.once('SIGINT', () => { cleanupAutomation(); process.exit(130); })` and equivalent for SIGTERM. A plugin calling `process.exit()` inside the host process kills the entire host, short-circuiting the host TUI's terminal cleanup (alternate screen restore, cursor reset, raw mode disable).

2. Four `console.warn()` call sites (Config Doctor startup advisories, skill-propagation-gate logs) wrote directly to stderr without checking `config.quiet`, bypassing the host TUI's rendering pipeline.

## Changes

- **`src/index.ts`**: Removed `process.once('SIGINT', ...)` and `process.once('SIGTERM', ...)` handlers entirely. `process.on('exit', cleanupAutomation)` remains as the sole cleanup hook — the correct host-plugin contract.
- **`src/index.ts`**: Guarded Config Doctor advisory `console.warn()` calls (lines ~1150/1157) with `if (!config.quiet)`; when quiet, routes through `addDeferredWarning()` (visible via `/swarm diagnose`).
- **`src/index.ts`**: Guarded skill-propagation-gate `console.warn()` calls (lines ~1991/2025) with `if (!config.quiet)`. These per-invocation operational logs are suppressed (not deferred) when quiet — they are debug-level noise and have no deferred-buffer equivalent.
- **`tests/unit/plugin-tui-safety.test.ts`**: New regression tests asserting no signal handler registrations and all `console.warn` calls in `src/index.ts` are properly guarded. Scope: `console.warn` only; `console.error` and logger `error()` calls on exceptional paths (init failure, pr-monitor worker errors) are intentionally retained as unconditional stderr.

## Migration steps
`config.quiet` defaults to `true` (`schema.ts:2405`). Under the default, all four previously-unguarded `console.warn` calls are now suppressed or deferred instead of writing to stderr. Config Doctor advisories are deferred to `/swarm diagnose`; skill-propagation-gate logs are suppressed. When `config.quiet` is explicitly set to `false`, behavior is unchanged from before this PR.

## Breaking changes
None for `quiet: false` configurations. Under the default `quiet: true`, Config Doctor startup advisories no longer appear on stderr — use `/swarm diagnose` to view them.

## Known caveats
- This change mitigates but does not fix the "Abort" prefix TUI rendering bug. The rendering defect is in the OpenCode host (`anomalyco/opencode`) and requires an upstream fix.
- The connection between these plugin behaviors and the host TUI corruption is theoretical: the plugin emits no "Abort" text; the changes reduce stderr writes and prevent `process.exit()` calls that could short-circuit the host's terminal cleanup.
