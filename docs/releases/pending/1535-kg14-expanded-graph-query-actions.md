# repo map: expanded graph query actions for symbol, impact, diff, and explainability workflows

## What

- Five new `repo_map` actions (KG-14, issue #1535):
  - `symbol_search` — find symbols by name with tiered matching
    (exact/prefix/substring/fuzzy), filterable by declaration kind, language,
    file, and visibility (`top_n`, default 25).
  - `symbol_context` — focused definition-first context for one symbol:
    identity with a stable 64-hex `symbol_id`, signature, optional hashed
    source text, and direct callers/callees. Resolves by `symbol_id` or
    `file`+`symbol`.
  - `impact_cone` — structured impact of changing a file or symbol:
    symbol-level callers/callees by depth with relationship kind, confidence,
    and resolution; file-level blast radius and risk (identical semantics to
    `blast_radius`); affected test files; routes/data/security facts and
    package boundaries from cone-file ontology; fixed-vocabulary risk notes.
  - `diff_context` — map changed files or a unified diff to changed symbols
    (hunk line ranges intersected with definition spans) plus per-file impact
    and risk. Diff text is capped at 50 000 characters; file paths inside a
    diff must be workspace-relative and safe (unsafe paths are skipped with a
    warning).
  - `graph_explain` — explain why a file/symbol/span is graph-relevant:
    line-to-symbol span resolution, definition, incoming/outgoing symbol edges
    with provenance evidence (≤3 records per reason), and file-level
    importers/imports.
- `graph_health` gains detailed summaries: `symbolEdgeSummary` (total / v2 /
  low-confidence / unresolved), `resolutionBreakdown` (includes `unrecorded`
  for legacy edges), `staleSummary` (changed / removed / probe truncation),
  `extractionFailureSummary` by reason, and `kindCoverage`.
- Graph schema **1.6.0** (additive): per-node `exportKinds` — the declaration
  kind of every persisted symbol. `validateGraphNode` rejects malformed kind
  maps as corruption, mirroring `exportRanges`.
- Public API addition: `extractSignatureText` is now exported from
  `src/tools/repo-graph/query.ts` and re-exported through the
  `src/tools/repo-graph.ts` barrel (previously module-private). The five new
  query functions (`searchSymbols`, `getSymbolContext`, `getImpactCone`,
  `getDiffContext`, `explainGraphEntry`) live in the new
  `src/tools/repo-graph/symbol-query.ts` module and are exported through the
  barrel.

## Why

Agents had to infer symbol-level, impact, diff, and explainability answers
from generic file-level actions (`context_pack`, `importers`, `dependencies`).
The graph already persisted the data (symbol edges with confidence and
evidence, definition spans, ontology facts); KG-14 exposes it through bounded,
provenance-bearing query actions. Closes #1535.

## Migration

No breaking changes. All new fields and actions are additive:

- Old graphs (schema 1.0.0–1.5.0) load unchanged. New actions answer them with
  `kind: null` hits; a `symbol_search` kind filter on an old graph returns
  `kindSupported: false`, empty hits, and a rebuild warning — never silently
  unfiltered results. Rebuild with `repo_map action="build"` to persist
  declaration kinds.
- The schema bump does not affect the KG-13 SQLite index (its version is the
  storage migration number, independent of the graph schema).
- The symbol_id scan is capped at 10 000 id computations per call; the result
  reports `symbolIdScan {computed, capped}` when a scan ran.
- Existing actions, their outputs, and `repo-map.test.ts` contracts are
  unchanged.

## Caveats

- `impact_cone` symbol entries are direction-scoped (callers of callers /
  callees of callees); an edge is never double-counted by bouncing back
  through the target.
- `diff_context` parses diff text strictly; a diff with no parseable file
  headers returns a structured validation error. `+++ /dev/null` deletions map
  to file-granularity entries (no new-side line ranges exist).
- Declaration kinds come from tree-sitter defs; regex-fallback scans (when
  tree-sitter is unavailable) produce no kinds — visible via
  `graph_health.kindCoverage` and `kind: null` hits.
- `symbol_context`/`graph_explain` legacy (pre-1.5.0) edges surface with
  `null`/absent confidence and an aggregate warning rather than being dropped.
