# Native apply_patch UX Restoration and swarm_apply_patch Rename

## Summary

The Swarm plugin no longer registers a plugin tool named `apply_patch`. This
restores the native opencode `apply_patch` tool to full visibility for all
agents — it was previously shadowed by the Swarm plugin's own unified-diff
handler, which caused the native tool's `*** Begin Patch / *** Update File`
format to be silently rejected.

## Changes

### `swarm_apply_patch` (renamed from `apply_patch`)

The Swarm unified-diff patch writer is now registered as **`swarm_apply_patch`**
instead of `apply_patch`. Its behavior is unchanged: it accepts standard unified
diffs (`--- a/file / +++ b/file / @@ hunks`), validates paths against workspace
boundaries, matches hunk context exactly, and writes atomically.

Agents (`coder`, `test_engineer`) that previously used `apply_patch` for
unified-diff patches should now use `swarm_apply_patch`.

### Native `apply_patch` restored

The native opencode `apply_patch` tool is now available without interference.
It handles `*** Begin Patch / *** Update File` style payloads produced by
opencode's built-in patch writer. It remains classified as a write-capable tool
in Swarm's guardrails (`WRITE_TOOL_NAMES`) so scope-guard and authority checks
continue to apply.

### Hard-fail on unsupported format

`swarm_apply_patch` now hard-fails with a clear error message when it receives
a `*** Begin Patch / *** Update File` style payload instead of silently
returning a no-op success. This prevents silent data loss when the wrong tool
is called with the wrong format.

### Guardrail preservation

- `apply_patch`, `swarm_apply_patch`, and `patch` are all covered by the
  scope-guard, authority checks, symlink/junction checks, universal-deny
  prefixes, and plan-state protection guardrails.
- `WRITE_TOOL_NAMES` now includes both `apply_patch` and `swarm_apply_patch`.
- Path extraction from patch payloads (`extractPatchTargetPaths`) handles all
  three tool names and also reads the `files[]` argument for `swarm_apply_patch`.

## Migration

| Before | After |
|--------|-------|
| `apply_patch` (Swarm unified-diff tool) | `swarm_apply_patch` |
| `apply_patch` (native opencode tool) | `apply_patch` (restored, no longer shadowed) |
