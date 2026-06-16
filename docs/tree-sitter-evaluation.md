# Tree-Sitter Migration Evaluation for Repo Graph

> Date: 2026-04-12 | Status: Research-only | Issue: #470

## Summary

Tree-sitter is the right long-term architecture for import parsing and symbol extraction in the repo graph, but the current bounded source-scanner implementation is sufficient for the startup graph path (TypeScript/JavaScript/Python only). Adopt tree-sitter when expanding language support beyond the current three or when import extraction accuracy becomes a blocker.

## Current State

| Aspect | Status |
|--------|--------|
| Dependencies | `web-tree-sitter@0.25.0`, `@vscode/tree-sitter-wasm@0.3.0` |
| WASM Grammars | 18 languages available |
| Runtime | `src/lang/runtime.ts` — parser cache, async grammar loading |
| Current Usage | `syntax-check.ts` — syntax validation with ERROR node extraction |
| Repo Graph | Bounded source scanning in `src/tools/repo-graph/*`; stores imports, exports, ontology facts, package boundaries, and preflight-packet data |

As of issue #1337, repo graph ontology facts cover file roles, route facts, data
operations, security-related detections, conventions, and findings. These facts
are extracted during the same bounded graph scan used by startup and `repo_map
action="build"`. The extractor does not load tree-sitter grammars during plugin
initialization; this preserves the fail-open startup contract while still
surfacing richer context to agents.

## Go Criteria

Adopt tree-sitter when:

- Repo graph needs to support 5+ languages (currently TS/JS/Python only)
- Import extraction accuracy >95% required (regex misses dynamic imports, re-exports)
- Need to track re-exports, dynamic imports, or type-only imports
- Plan to add call graph (function-level dependencies) — requires AST
- SAST rules need semantic analysis beyond pattern matching

## No-Go Criteria

Do NOT adopt when:

- Current regex parsing meets accuracy requirements (it does for MVP)
- Only TypeScript/JavaScript/Python support needed long-term
- Performance-critical path can't tolerate 2-5x parse time increase
- Memory-constrained environment (~2-5MB per language parser)
- No testing bandwidth for regression validation

## Performance Comparison

| Metric | Regex | Tree-Sitter |
|--------|-------|-------------|
| WASM Init | N/A | ~50-100ms once (already paid by syntax-check) |
| Grammar Load | N/A | ~20-50ms per language (cached) |
| Parse Time (1KB) | ~1ms | ~5-10ms |
| Parse Time (100KB) | ~10ms | ~30-50ms |
| Accuracy | ~85% | ~99% |

**Key insight:** The codebase already pays WASM init cost when `syntax-check.ts` runs, but repo graph cannot rely on that cache being warm during startup or `repo_map action="build"`. A tree-sitter repo-graph migration must therefore treat WASM init and grammar loading as additional bounded work on the graph path.

## Recommended Migration Path

1. **Phase 1**: Create query infrastructure in `src/lang/queries/` with import extraction patterns per language
2. **Phase 2**: Add tree-sitter extractors alongside regex with feature flag (`USE_TREE_SITTER=true`)
3. **Phase 3**: Run both extractors on 100+ files, compare output, fix discrepancies
4. **Phase 4**: Gradual rollout — default to tree-sitter for new languages, keep regex as fallback

## Decision

**DEFERRED** - Tree-sitter migration for repo graph import/symbol extraction is deferred until language expansion or accuracy requirements justify the investment. The current bounded scanner is sufficient for the startup graph and ontology MVP.
