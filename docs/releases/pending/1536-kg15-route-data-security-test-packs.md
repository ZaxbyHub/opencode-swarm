# KG-15: route, data, security, and test graph packs for `repo_map`

## What

- New `repo_map` change-risk pack actions (issue #1536), implemented in the new
  `src/tools/repo-graph/pack-query.ts`:
  - `route_trace` — given `route_path` (+ optional `method`), a handler
    `file`, or a handler `symbol`, returns the route fact, the bound handler
    symbol with confidence, depth-1 services, data operations and
    auth/validation facts from the handler and its services, handler-file
    ontology findings (e.g. `api_route_without_detected_auth` on an unguarded
    mutating route), and the tests covering the handler/services.
  - `data_trace` — given an `entity` (entity/table name or config/env key), a
    `file`, or a `symbol`, returns readers, writers, deleters, and
    configurers with evidence and confidence, touching routes, covering
    tests, and fixed-vocabulary risk notes (untested subject, delete-op
    coverage, cross-boundary writes).
  - `test_pack` — given a `file`, a `files` list, a `symbol`, or a unified
    `diff`, returns the associated tests (explicit-import and colocated-name
    heuristics, with `basis` and `confidence`), fixtures (`USES_FIXTURE`
    pattern) with their importing tests, helpers shared by multiple tests,
    covered/uncovered exports, and missing-test warnings. It never executes
    test frameworks.
- Graph schema 1.7.0: new optional `GraphNode.ontology.links` array. Seven
  kinds are extracted at build time inside `extractFileOntology` —
  `HANDLES_ROUTE`, `READS`, `WRITES`, `DELETES`, `VALIDATES`, `AUTHORIZES`,
  and `CONFIGURES` (comment-stripped source, deterministic order, ≤200
  links/file, CONFIGURES ≤20 deduped keys/file). `TESTS` and `USES_FIXTURE`
  are NEVER persisted: `test_pack` materializes them at query time as
  derived association records (`kind`, `fromFile`, `toFile`, `evidence`,
  `confidence`, capped at 200) from import edges plus colocated-name
  heuristics.
- Link validation: `validateOntologyStrings` now bounds `subject` (≤200 chars,
  identifier-first, no `..` path segment), enforces the kind/confidence enums, and rejects
  control characters and non-positive lines.
- New tool params: `route_path`, `method`, `entity` (with input validation);
  `test_pack` reuses the existing `files`, `symbol`, and `diff` params.

## Why

The graph already stored ontology facts (routes, data operations, security)
per file and symbol-level edges (KG-14), but nothing joined them: facts were
not keyed by their subject (route path, entity, config key) or bound to the
symbols that produce them, and test files had no association with the
implementations they cover. Reviewers, test engineers, and security agents
had to explore broadly to answer "what does this route touch", "who writes
this entity", or "which tests cover this change". The packs answer those
questions from the graph, advisory and evidence-backed.

## Migration

- Rebuild the graph once after upgrading: `repo_map action="build"`. The
  schema bump to 1.7.0 changes the freshness `EXTRACTOR_STAMP`, so the first
  probe after upgrade reports drift and serves the old graph with a
  freshness note until a rebuild.
- No action removals or renames; all existing actions are unchanged
  (`impact_cone` intentionally untouched — deeper route/data/test views are
  the new dedicated actions).

## Caveats

- Pre-1.7.0 graphs still answer: facts/edges-derived sections populate and
  packs carry `linksSupported: false` with an explicit rebuild warning;
  `data_trace` entity matching falls back to `DataOperationFact` entities
  (`via: 'fact'`, `confidence: null`). `test_pack` derives everything from
  edges and works on every schema.
- Entity extraction only recognizes `prisma.`/`db.`/`database.` receivers;
  `repository.X`/`model.X` are not seen. Entity-less data facts stay per-file
  facts without links.
- Handler-symbol binding is heuristic: `handler_export` routes bind the
  method-named export (high confidence), `router_call` routes bind a named
  handler argument when present (medium), and `file_path`-only routes remain
  file-level (low). Regex-based — no formal security proofs; findings are
  advisory review hints.
- Colocated-test association (`widget.ts` ↔ `widget.spec.ts` without an
  import) is a naming heuristic reported at medium confidence with an
  explicit risk note; fixture detection is path/basename-pattern based.
- The unguarded-route advisory is file-level: one auth/validation sweep per
  handler file, so a guarded sibling route suppresses it for the whole file,
  and absence of the finding does not prove an individual route is guarded.
- Regex-constrained router paths (`/user/:id(\d+)`) are captured verbatim
  (backslash escapes included) in route subjects.
