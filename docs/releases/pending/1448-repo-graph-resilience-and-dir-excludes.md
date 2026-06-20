# repo-graph: resilient builds + configurable directory excludes

## What

Fixes a crash where building the repo dependency graph aborted entirely with
`Invalid node: ontology contains control characters` when the workspace contained
a minified or generated JavaScript file (issue #1448, reported against
SvelteKit's `.svelte-kit/output/.../chunks/*.js`).

- **Resilient graph build.** A single file that fails node validation (for
  example, control characters in ontology evidence extracted from minified code)
  is now skipped individually instead of aborting the whole graph build. Both the
  synchronous and the async (plugin-startup) build paths are hardened, for node
  validation and edge validation alike: an invalid node drops just that file, and
  an invalid edge drops just that edge.
- **`.svelte-kit` skipped by default.** Added `.svelte-kit` to the built-in
  scan-skip list alongside the existing defaults (`node_modules`, `.git`, `dist`,
  `build`, `out`, `coverage`, `.next`, `.nuxt`, `.cache`, `vendor`, `.svn`,
  `.hg`).
- **New `repo_graph.exclude_dirs` config.** Lets users exclude additional
  directory names from indexing via `opencode-swarm.json`. Matching is by
  directory basename at any depth (the same mechanism as the built-in defaults);
  the exclude also applies to write-triggered incremental updates. Documented in
  `docs/configuration.md`.

## Why

The graph build validated each node/edge outside the per-file error handling, so
one pathological file (a minified bundle or generated chunk) threw and aborted
the entire build — leaving no graph saved and repo-graph features silently
degraded. The reported `.svelte-kit` directory is generated build output that
should never have been indexed, but the underlying defect was broader: a minified
`.js` in any non-skipped directory triggered the same crash. The resilience fix
addresses the root cause; the default skip and the configurable excludes address
the reporter's request to keep build directories out of indexing.

## Migration

No breaking changes. All changes are additive and backward-compatible:
- `repo_graph` is an optional config section; omitting it preserves prior
  behavior plus the new `.svelte-kit` default and build resilience.
- `exclude_dirs` is additive-only — it cannot un-exclude a built-in default.
- Public tool/agent surfaces are unchanged.

## Caveats

- `exclude_dirs` entries are directory names, not glob or path patterns.
  Matching is case-sensitive; specify each name exactly as it appears on disk.
  Surrounding whitespace is trimmed, and whitespace-only entries are rejected at
  config load (rather than silently ignored) so a typo surfaces as a clear
  validation error.
- A file that is skipped during the build is reflected only in the aggregate
  `[repo-graph] Scan stats` log line, not a per-file message.
- The incremental write-update path honors user `exclude_dirs`; built-in defaults
  are enforced at scan time, and a direct write into a built-in-skipped directory
  is caught and logged by the hook rather than crashing (pre-existing graceful
  degradation).
