# TUI pollution sweep — console enforcement (PR5 of epic #1752)

## What changed

The final sweep migrated the issue-listed command, plan, worktree, parallel,
Lean Turbo, SDD, and SBOM warning sites to the debug logger or deferred
`advisoryWarn` channel. Biome now rejects new raw console calls in production
source unless the call has a narrowly documented exception.

The CLI, logger, and warning-buffer implementations retain narrow file-wide
Biome exemptions because writing or retaining terminal diagnostics is their
explicit responsibility. Elsewhere, intentional raw console calls remain only
for bounded fatal/security messages, quiet-mode parity warnings, one-time
download progress, and explicit debug diagnostics; each carries an inline
`biome-ignore` rationale. Normal plugin operation remains free of terminal
noise when debug mode is disabled.

## Why

Raw stdout/stderr writes can corrupt the Bubble Tea display while the OpenCode
plugin host owns the terminal. Diagnostic-only messages now use debug logging,
and recoverable conditions that require operator action are buffered for
`/swarm diagnose` without writing into the live TUI stream.

## Behavior and migration

No configuration or API migration is required. Operators can enable
`OPENCODE_SWARM_DEBUG=1` for diagnostic logs and use `/swarm diagnose` for
buffered advisories.

## Epic context

This was PR5 of epic #1752, following PRs #1758, #1789, #1829, and #1834.
