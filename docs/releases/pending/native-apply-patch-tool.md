# Native apply_patch tool

## What changed

- Added a native OpenCode `apply_patch` tool for `*** Begin Patch` / `*** Update File` edits
- Renamed the Swarm unified-diff patch tool from `apply_patch` to `swarm_apply_patch`
- Extended `scope-guard` to extract paths from array-based tool arguments (`files[]`, `paths[]`, `targetFiles[]`)

The `swarm_apply_patch` tool replaces shell-based `git apply` calls for swarm agents with a pure TypeScript implementation that:
- Parses unified diffs (`---`/`+++` headers, `@@` hunk headers, context/addition/removal lines)
- Rejects binary, rename, and copy patches
- Enforces workspace boundaries with canonical symlink protection (`realpathSync`)
- Blocks access to `.git/` and `.swarm/` directories (both lexical and canonical paths)
- Uses exact context matching with accumulated delta tracking for multi-hunk patches
- Performs per-file atomic writes via temp+rename
- Supports dry-run mode, `allowCreates` gate (default false), and `allowDeletes` gate (default false)
- Returns structured JSON results with per-file status and diagnostics
- Preserves CRLF line endings and trailing newlines

The scope-guard enhancement prevents scope bypass via multi-file tool calls by extracting paths from array arguments in addition to single-string arguments.

## Why

Issue #1103: Swarm agents needed a safe, in-process patch application tool that works under Swarm's safety model without shell access or external binaries. The scope-guard had a first-match-wins gap where array-based path arguments (like `swarm_apply_patch`'s `files[]`) could bypass scope enforcement.

## Migration

Update any Swarm-specific unified-diff tool references from `apply_patch` to `swarm_apply_patch`.

- Use `swarm_apply_patch` for standard unified diffs with `---` / `+++` headers and `@@` hunks.
- Use the native OpenCode `apply_patch` tool for `*** Begin Patch` / `*** Update File` edit payloads.
- Existing behavior is otherwise unchanged; the rename only disambiguates the two patch tools.

## Known caveats

- Line coverage is 69.87% — error recovery paths and some edge cases are untested.
