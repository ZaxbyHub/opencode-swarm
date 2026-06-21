# repo-graph: call-site usage & dead-export analysis

> Status: implemented (schema 1.1.0). Origin: issue #1409.
> Audience: contributors extending structural intelligence in opencode-swarm.

## Background: the #1409 decision

Issue #1409 proposed bundling [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
(cbm) — a third-party static binary providing a persistent code knowledge graph
(158-language tree-sitter + LSP, call graphs, dead code, Cypher subset, Louvain
community detection, neural-embedding semantic search, IaC links) — and bridging
its output into the swarm memory core.

After evaluation we **did not** bundle cbm. The decision and its evidence:

- **Most proposed value was already native.** `src/tools/repo-graph/` already
  provides the import graph, blast radius, symbol consumers, key files,
  localization context, package boundaries, and a regex ontology.
- **Bundling conflicted with hard invariants.** cbm stores state in
  `~/.cache/` (AGENTS.md invariant 4 requires `.swarm/`), indexing cannot run on
  the ~400 ms plugin-init path (invariant 1), and a `curl | bash` third-party
  binary install is a Windows/offline/cache-hygiene problem (invariants 2, 3,
  12). The proposed memory bridge also conflicted with the curated, opt-in,
  proposal-only memory design.
- **The genuinely new, native-feasible slice** was function/symbol-level usage
  (call-site granularity) and dead-export detection. That slice is what this
  feature delivers. The heavy polyglot/semantic capabilities remain available to
  users who want them by configuring cbm as their own external MCP server — not
  as a swarm-owned, auto-installed dependency.

See the issue thread for the full comparison.

## What was added

Graph schema `1.1.0` (see `GRAPH_SCHEMA_VERSION` in `repo-graph/types.ts`):

| Surface | Location | Purpose |
| --- | --- | --- |
| `GraphEdge.usedSymbols?` | `types.ts` | Target exports actually referenced by the source file |
| `GraphNode.exportLines?` | `types.ts` | Exported symbol → definition line |
| `getCallers(graph, file, symbol)` | `repo-graph/query.ts` | Files referencing an exported symbol (call-site granularity) |
| `getDeadExports(graph, options?)` | `repo-graph/query.ts` | Advisory unreferenced-export candidates |
| `repo_map action="callers"` | `repo-map.ts` | Tool surface for `getCallers` |
| `repo_map action="dead_exports"` | `repo-map.ts` | Tool surface for `getDeadExports` |

### `usedSymbols` extraction

Computed at build time in `scanFile` (async builder) and the inline loop of
`buildWorkspaceGraph` (sync builder) — the two paths are kept byte-for-byte
equivalent, locked by the issue #1144 equivalence suite.

The scan is conservative and alias-aware:

- Imports are parsed into `{ imported, local }` bindings (`parseImportBindings`).
  `import { a as b }` binds `imported: "a", local: "b"`; default imports bind
  `imported: "default"`.
- For each binding, the comment-stripped file content is scanned for the *local*
  name. Because a well-formed import statement mentions the local name exactly
  once, a count `> 1` means at least one body reference. The matched *exported*
  name is recorded.
- Named re-exports (`export { x } from`) count all re-exported symbols as used.
- Namespace / side-effect / require / dynamic imports leave `usedSymbols`
  absent — per-symbol usage is not statically resolvable there.
- String literals are intentionally **not** stripped, biasing toward "used" so
  ambiguity never yields a false "dead" result.

### `dead_exports` precision scoping

`getDeadExports` is advisory-only and deliberately narrow to keep signal high:

1. Requires schema `>= 1.1.0`; otherwise returns `schemaSupported: false` and
   asks for a rebuild (the loader does not version-gate, so the query does).
2. Only considers files imported by `>= 1` other in-repo file — a file with no
   importers is a likely public-API entry, CLI, or test, not dead code.
3. Skips any file reached via an unresolvable import (namespace/etc.).
4. Excludes framework-invoked roles: `api_route`, `cli_command`, `test_file`,
   `agent`, `hook`, `middleware`, and the synthetic `default` export.

## Limitations (by design)

- TS/JS/Python only, regex-based — no AST/tree-sitter (AGENTS.md invariant 1).
- Cannot see dynamic dispatch, string-keyed/computed property access, or usage
  through namespace and barrel re-export chains.
- `dead_exports` output is a list of **review candidates**, never a directive to
  delete. Verify before acting.
- The combined `import foo, { bar } from './m'` form (default + named in one
  statement) is not parsed by the import scanner, so usage of the named part is
  invisible — a symbol used only through such a statement can be a false
  `dead_exports` candidate. Splitting it into separate `import` lines (the
  repo's own convention) avoids this.
- Not an intra-file, function-to-function call graph and not method-dispatch
  resolution — those need real parsing and remain on the external-MCP track.

## Usage

```text
# Refresh the graph (populates schema 1.1.0 data)
repo_map { "action": "build" }

# Who actually uses an exported symbol?
repo_map { "action": "callers", "file": "src/foo.ts", "symbol": "doThing" }

# Advisory: exports nothing references in-repo
repo_map { "action": "dead_exports", "top_n": 50 }
```

## Future direction

If deeper structural intelligence is needed (true call graphs, polyglot
coverage, semantic search), prefer consuming cbm — or another tool — as a
**user-configured external MCP server**, keeping swarm as the orchestrator. Do
not bundle or auto-install an external binary into the plugin; it would reopen
the invariant conflicts catalogued above.
