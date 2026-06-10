## fix: repo-graph startup scan no longer hangs large projects (#1144)

**What changed.** The repo dependency-graph build that runs at plugin startup is
now O(N) instead of O(N²). The two workspace build loops in
`src/tools/repo-graph/builder.ts` previously called `upsertNode`/`addEdge` once
per file/edge, and each call recomputed `graph.metadata`
(`Object.keys(nodes).length`, O(nodes)) while `addEdge` also did an O(edges)
linear `.some()` dedup. They now insert nodes/edges in O(1) via internal
bulk-insert helpers with a loop-local `Set` for edge dedup, and compute metadata
once at the end (as both loops already did).

**Why.** On large projects this O(N²) construction took tens of seconds of
CPU. Because the scan runs on the single-threaded event loop (deferred since
#704, but only yielding every 200 files), the super-linear chunks starved
OpenCode's startup, so users saw the editor hang ~30s before it became usable.

**Impact.** Building the graph for a 4,000-file workspace dropped from ~4.0s to
~0.5s in the repro harness (`bun run repro:1144`), and scaling is now linear.
Graph output is unchanged — nodes, edges, dedup, and ordering are byte-identical
(verified by a new sync/async equivalence test asserting full edge-array and
node deep-equality, including paths/specifiers containing spaces).

**Migration.** None. No configuration, API, schema, or on-disk format change.
The deferral, timeouts, walk budgets, and fail-open behavior from #704 are
unchanged. The public `upsertNode`/`addEdge` helpers are unchanged (incremental
updates still use them).

**Caveats.** The 10,000-file / 5s walk cap is unchanged; this fix addresses the
post-walk graph-assembly cost, which was the dominant term behind the 30s stall.
