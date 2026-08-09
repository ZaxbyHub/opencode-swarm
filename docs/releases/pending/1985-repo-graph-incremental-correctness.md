# repo-graph incremental update lifecycle correctness

## What

Resolves #1985 — six verified lifecycle defects in the repo-graph subsystem
(`src/tools/repo-graph/*`). The headline defect (A1) silently disabled
incremental updates for any workspace importing JSON/CSS/asset files by relative
path, forcing a full workspace rebuild on every agent write.

### A1 — asset edges no longer disable incremental updates (CRITICAL)

`resolveModuleSpecifier` resolves imports like `import data from './data.json'`
to real files, but only scannable source languages become graph nodes. The
incremental updater validated that *every* edge had nodes at both endpoints, so
one asset edge anywhere ⇒ `validationFailed` ⇒ silent fallback to a full rebuild
on every write, forever. The warning was gated behind `OPENCODE_SWARM_DEBUG=1`,
so it was invisible in production.

- `GraphEdge` gains an optional `targetKind: 'node' | 'asset'` field
  (schema `1.2.0` → `1.3.0`; older graphs still load — the loader only checks
  version presence, feature gating is per-query).
- Edges whose target is not a scannable source file are tagged `'asset'` at all
  four emission sites (`scanFile`, `scanFileAsync`, both builders).
- The incremental validation loop now requires only the *source* node for asset
  edges; node→node edges still require both endpoints. On a genuine orphan edge
  the specific offending edge (source, target, reason) is logged before the
  fallback, and an `incrementalFallbacks` diagnostics counter is bumped.
- Asset targets are excluded from `key_files` in-degree ranking and from
  importer / dependent lists (`getImporters`, `getKeyFiles`, `getBlastRadius`,
  `getCallers`, `getDeadExports`, `getSymbolConsumers`, package boundaries).
  Pre-1.3.0 graphs are handled via an extension-check fallback on untagged edges.

**Scope note:** this fixes the common JSON/CSS/asset case. A scannable file
that fails to become a node (binary, oversized, parse error) still triggers a
fallback rebuild by design — the rare case is correctly reconciled by the
rebuild.

### A2 — write-hook extension parity

The write hook's local `SUPPORTED_EXTENSIONS` (7 extensions) drifted from the
builder's `LANGUAGE_REGISTRY`-derived set, so `.rs`/`.go`/`.pyw` edits never
triggered an incremental update. Both now route through a single shared
`isScannableSourcePath` helper derived from the walker's set.

### A4 — cheaper concurrent-save recovery

The optimistic-concurrency check used to fall back to a full rebuild whenever
the on-disk graph mtime moved. It now reloads the freshest graph and replays the
update **once** (with a pre-save re-check); only a second concurrent shift falls
back to the full rebuild. Bounded — never loops. Once a mismatch is detected,
the stale pre-reload graph is never saved over the newer on-disk graph — any
reload/replay/stat failure after a detected mismatch routes to the terminal
full rebuild (the only broad `catch` is the initial mtime stat, which tolerates
transient I/O errors).

### Incremental re-scan hardening (review-driven)

Two latent incremental-path defects surfaced during independent review and are
fixed in the same pass:

- A previously-tracked source file whose re-scan returns `node: null` (it
  became oversized, binary, or unreadable) now has its stale node removed, so
  any dangling incoming node→node edge is caught by validation and triggers the
  documented fallback — instead of leaving an inconsistent graph (stale node,
  removed outgoing edges).
- `updateGraphForFiles` is a public entry point, so it now guards with
  `isScannableSourcePath` before mutating the graph, refusing to create an
  `'unknown'`-language node from an unsupported extension.
- Manifest-aware package boundaries stay consistent across incremental edits:
  the incremental re-scan re-derives a bounded `hasManifest` closure from the
  existing graph's node directories and forwards it to the scanner (including
  the tree-sitter fail-open fallback).

### A5 — realpath consistency

`toolAfter` computed the realpath for its security boundary check but passed
the non-realpath'd absolute path into the updater. Node keys originate from the
realpath'd walk, so on case-insensitive filesystems or symlink aliases this
could insert a duplicate node and strand the original. The realpath is now
forwarded.

### A7 — walk-truncation + fallback diagnostics

Walk truncation (file cap / wall-clock budget) was a debug log only;
`getGraphHealth` could not report it. `RepoGraphDiagnostics` gains
`walkTruncated`, `walkTruncationReason` (`'budget' | 'cap'`), and
`incrementalFallbacks`. `getGraphHealth` surfaces them with an explicit
`"Graph is INCOMPLETE: …"` note, and the `repo_map` `build` action reports
`truncated: boolean`.

### A8 — generic package-boundary inference

`boundaryForModule` hardcoded this repo's own layout (`src/tools/repo-graph`,
`packages/`, `crates/`). The rule is now generic and shared by ontology
extraction and the query-side no-ontology fallback via a pure
`inferPackageBoundary` helper: `packages|crates|apps|libs|services` as the first
segment, plus a manifest-driven rule (`package.json` / `Cargo.toml` /
`pyproject.toml` / `go.mod`) plumbed from the walker through an optional
`hasManifest` callback on `ExtractFileOntologyInput`. The ontology module stays
pure (no fs I/O).

### A6 — docs note

`exclude_dirs` case-sensitivity on case-insensitive filesystems remains
documented behavior in the schema JSDoc; no code change.

## Why

The repo-graph subsystem is the structural-awareness layer swarm agents use
before refactoring. A1 made incremental updates non-functional for a large
class of real user repos (any repo with a relative JSON/CSS import — measured
~158 s full rebuild on a 2,787-file repo, on every agent write), so the graph
was either permanently stale or permanently expensive. The other defects caused
silent staleness (A2), duplicate nodes (A5), invisible truncation (A7), and
repo-specific boundary guesses (A8).

## Impact

- Incremental updates now work for workspaces with asset imports — the common
  case. Agents editing an unrelated file no longer pay for a full rebuild.
- Rust / Go / `.pyw` edits now keep the graph current.
- `graph_health` honestly reports when a graph is incomplete, instead of
  confidently returning wrong blast radii and dead-export candidates.
- Package-boundary inference works on user repos, not just this one.
- Graph schema is additive (1.3.0); existing 1.0.0–1.2.0 graphs load and query
  unchanged.

## Verification

`bun test` (repo-graph suite, 251 tests across 17 files, each run in isolation
per AGENTS.md invariant 7), `bunx tsc --noEmit`, `bun run drift:check`, and
`bunx biome check` all green. New regression tests cover the A1 repro
(asset import no longer forces a fallback; asset targets excluded from queries;
genuine node→node orphans still fall back), A2 (`.rs`/`.go`/`.pyw` writes
trigger updates), A5 (realpath forwarded), A7 (truncation reason + fallback
counters surface in `graph_health`), A8 (generic boundaries + removed special
case), and 1.2.0 graph compatibility.
