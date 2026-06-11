# Guardrails disabled warning no longer leaks into TUI

## What changed

Guardrails disabled warnings are now emitted via the debug logger only (`OPENCODE_SWARM_DEBUG=1`) instead of directly to `console.warn()`. This prevents warnings from corrupting the TUI display while keeping them available for debugging.

## Why

When guardrails are disabled via configuration, a security warning is emitted at plugin initialization. Previously, this warning was always printed to `console.warn()`, which caused the TUI to display corrupted output with warning text overlaid on the normal UI. The acceptance criteria required that warnings should not leak into TUI.

## Migration

Users who have disabled guardrails and previously relied on the always-visible startup warning must set `OPENCODE_SWARM_DEBUG=1` to continue receiving it. The warning is no longer printed in normal operation; this is intentional to prevent TUI corruption caused by the plugin host capturing all console output.

## Known caveats

The security warning is now opt-in via `OPENCODE_SWARM_DEBUG=1`. Users with `guardrails.enabled: false` in their config will not see the warning in standard operation.
