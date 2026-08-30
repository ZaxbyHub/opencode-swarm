# repo-graph `context_pack` query-time source reads are bounded at 1 MiB per file

## What changed

`context_pack` with `include_source: true` no longer loads graph-referenced
source files of any size into memory at query time. Each source read is now
preceded by a size check against the shared per-file ceiling
`DEFAULT_MAX_SOURCE_BYTES` (1 MiB). A graph-referenced file above the cap is
never read: its span stays admitted with `span.note = 'source too large'`, a
bounded `source too large for <file>:<symbol>` warning is surfaced, and no
snippet is produced for it.

Previously (issue #2399), a stale or hand-edited `.swarm/repo-graph.json`
referencing a very large file caused the query path to allocate the whole file
in memory before slicing to the ≤80-line span, because the graph builder
deliberately skips files over ~1 MiB at build time while the query path trusted
the same paths with no limit.

## Why

Build-time and query-time now trust graph-referenced paths with the same
default limit, closing the asymmetric-trust gap where normal builder-produced
graphs were safe but pathological ones could exhaust memory on a single query.

## Notes

- The limit lives in one place (`DEFAULT_MAX_SOURCE_BYTES` in
  `src/tools/repo-graph/types.ts`): the builder uses it as the default of its
  `maxFileSizeBytes` option, and the query layer always enforces the same
  constant at read time. A graph built with `maxFileSizeBytes` raised above
  1 MiB still gets `source too large` for those files at query time — the
  behavior is documented in `docs/repo-graph-symbol-graph.md`.
- Files of exactly 1 MiB or smaller are unaffected and still read normally.
- The query path still fails individually per span: unreadable files keep the
  existing `source read failed` note, and no single oversized span can abort a
  pack.
