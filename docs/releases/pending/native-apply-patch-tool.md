# Native apply_patch tool

## What changed

- Added a native `apply_patch` Swarm tool that parses and applies unified diffs in-process under Swarm's safety model
- Extended `scope-guard` to extract paths from array-based tool arguments (`files[]`, `paths[]`, `targetFiles[]`)

The `apply_patch` tool replaces shell-based `git apply` calls for swarm agents with a pure TypeScript implementation that:
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

Issue #1103: Swarm agents needed a safe, in-process patch application tool that works under Swarm's safety model without shell access or external binaries. The scope-guard had a first-match-wins gap where array-based path arguments (like `apply_patch`'s `files[]`) could bypass scope enforcement.

## Migration

No migration required. The tool is automatically available to `coder` agents via the manifest registration. Existing tools and agents are unaffected.

## Known caveats

- Line coverage is 69.87% — error recovery paths and some edge cases are untested.
