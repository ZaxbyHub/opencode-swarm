# repo-graph: native call-site usage + dead-export detection

## What

Extends the native repo-graph (`src/tools/repo-graph/`) with cross-file
symbol-usage analysis and two new `repo_map` actions, graph schema `1.1.0`:

- Each graph edge now carries an optional `usedSymbols` — the subset of a
  target's exported symbols that are actually *referenced* in the importing
  file's body (not merely imported). The scan is alias-aware (`import { a as b }`
  attributes usage of `b` back to `a`), handles default imports, and treats
  named re-exports (`export { x } from`) as usage. Namespace/side-effect/
  require/dynamic imports are left unresolved (`usedSymbols` absent).
- Each node now carries an optional `exportLines` map (exported symbol →
  definition line) so usage results can point at a location.
- `repo_map action="callers"` (needs `file` + `symbol`): files that reference a
  specific exported symbol, at call-site granularity rather than file-import
  granularity.
- `repo_map action="dead_exports"`: advisory list of exported symbols with no
  detected in-repo reference.

Both new fields are optional, so graphs written by older versions still load;
`dead_exports` self-gates on schema `>= 1.1.0` (via `isSchemaVersionAtLeast`) and
tells the caller to rebuild when the data is absent.

## Why

repo-graph previously answered file-level structural questions (importers,
blast radius, key files) but could not say *which exported symbol* a consumer
actually uses, nor surface exports that nothing references. This was the
native-feasible slice of the structural-intelligence gap raised in #1409 —
delivered without adding an external dependency, AST/tree-sitter parsing, or any
init-path work, keeping the module within its existing build budgets.

## Migration

No breaking changes. Additive only:
- New optional `GraphEdge.usedSymbols` and `GraphNode.exportLines` fields;
  existing `1.0.0` graphs load unchanged and degrade gracefully (`callers`
  falls back to import-level matching flagged `resolution: "imported"`).
- Two new `repo_map` actions; all existing actions and outputs are unchanged.
  No tool/agent-map/registration changes (actions are internal to `repo_map`).
- The graph schema version is now `1.1.0`; a rebuild (`repo_map action="build"`)
  populates the new data. Stale graphs keep working for every pre-existing
  action.

## Caveats

- Analysis is conservative regex-based (TS/JS/Python only), consistent with the
  module's deliberate no-AST design (AGENTS.md invariant 1). It **cannot** see
  dynamic dispatch, string-keyed/computed access, or usage through namespace and
  barrel re-exports. `dead_exports` is therefore an advisory list of *review
  candidates*, never a delete directive.
- To minimize false positives, `dead_exports` only considers files imported by
  at least one other in-repo file (so public-API entry points / CLIs / tests are
  not flagged), skips files reached via any unresolvable import, and excludes
  framework-invoked roles (routes, CLIs, tests, agents, hooks, middleware).
- The usage scan does not strip string literals, biasing toward "used" — a
  deliberate choice so ambiguity never produces a false "dead" result.
- The combined `import foo, { bar } from './m'` form (default + named in one
  statement) is not parsed by the import scanner, so a symbol used only through
  that form can appear as a false `dead_exports` candidate. Splitting into
  separate `import` lines avoids it.
