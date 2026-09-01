# repo-graph: symbol-level graph facts & context packing (schemas 1.2.0–1.6.0)

> Status: implemented. Schema 1.2.0 introduced traversal coordinates; schema
> 1.5.0 adds stable identity, confidence, resolution, and evidence; schema
> 1.6.0 (KG-14, issue #1535) persists declaration kinds and powers the expanded
> graph query actions.
> Audience: contributors implementing the next slice of structural intelligence in opencode-swarm.

For the broader graph-backed repository memory contract, support matrix,
confidence vocabulary, and ordered roadmap, see
`docs/repo-memory-graph-plan.md`.

## Background

PR #1468 (issue #1409) added schema **1.1.0** to the native `src/tools/repo-graph/`
module: per-edge `usedSymbols` (which exported names an importer actually
references) and per-node `exportLines` (exported symbol → definition line), plus
the `repo_map` actions `callers` and `dead_exports`. That work deliberately used
the module's existing **conservative regex scanner** and covered only TS/JS/Python
(`SUPPORTED_EXTENSIONS` at `src/tools/repo-graph/builder.ts:140`).

Two ceilings remain, and they are exactly what an external "codebase memory" MCP
server claims to break through:

1. **Answers are file-level.** Edges are file→file (`GraphEdge`, `types.ts:269`).
   The graph can say "file A references symbol `foo` from file B" but not
   "function `bar()` calls `foo()`". Agents still open whole files to act, which
   is where context burden actually accrues.
2. **Coverage is TS/JS/Python only**, while the repo documents **13 first-class
   languages** in `src/lang/profiles.ts` (TypeScript, JavaScript, Python, Rust, Go,
   Java, Kotlin, C#, C/C++, Swift, Dart, Ruby, PHP) and already ships tree-sitter
   grammars for every one of them (`src/lang/runtime.ts:99`).

This document specifies schema **1.2.0**: a **symbol-level call graph** built on the
existing tree-sitter language layer, covering all 13 documented languages, plus a
`context_pack` query that returns a token-budgeted slice of source instead of a
file list.

## Goal / non-goals

**Goals**
- Re-platform repo-graph symbol/import extraction onto `src/lang/` tree-sitter,
  retiring the private TS/JS/Python regex scanner.
- Cover all **13** documented profile languages.
- Add per-symbol source ranges (`exportRanges`) and **symbol→symbol edges**.
- Add `repo_map action="context_pack"`: a minimal, deduped, budgeted bundle of
  source spans for a target symbol (definition + transitive callers/callees,
  periphery as signatures).
- Keep schema **additive and back-compatible** — 1.0.0/1.1.0 graphs still load and
  every existing action still works.

**Non-goals**
- 158-language coverage, neural/semantic embeddings, or a persistent external
  index. Those remain on the user-configured external-MCP track (see
  `docs/repo-graph-call-graph.md`).
- Whole-program type-based call resolution. Analysis stays conservative
  (advisory), as today.

## Why tree-sitter, and why now

The "no AST/tree-sitter" stance in `docs/repo-graph-call-graph.md` is scoped to the
**plugin-init path** (invariant 1), not the whole plugin. Tree-sitter is already a
first-class, **on-demand** dependency used at tool time:

- `src/diff/ast-diff.ts` parses + queries 19 languages (`loadGrammar` →
  `parser.parse` → `new Query` → `query.matches`), with a 500 ms parse timeout and
  `tree.delete()` cleanup.
- `src/tools/syntax-check.ts` and `src/tools/placeholder-scan.ts` follow the same
  pattern with bounded concurrency.

`loadGrammar(languageId)` (`src/lang/runtime.ts:196`) is lazy, memoized, request-
coalesced, and 10 s-bounded. Crucially, **`src/index.ts` never imports the
tree-sitter runtime** — init is triggered only by query-time tools, so this work
adds **zero** init-path cost. Regex cannot give reliable declaration boundaries or
reference attribution across 13 languages; tree-sitter is both the accuracy upgrade
and the only sane way to hit the documented-language contract without hand-writing
13 parsers (which would also duplicate `src/lang/backends/*.extractImports`).

## Architecture

```
src/lang/runtime.ts  loadGrammar(grammarId) → Parser   (lazy, cached; already exists)
        │
        ▼
src/lang/symbol-graph.ts  (NEW)  per-grammar .scm queries → per-file facts:
        │     defs[]    { name, kind, exported, visibilityInfo?, startLine, endLine }
        │     imports[] { specifier, importType, bindings:[{imported,local}] }
        │     refs[]    { identifier, line, enclosingDecl }
        ▼
src/tools/repo-graph/builder.ts  (REWIRED, async path only for symbol data)
        │     scanFile() calls symbol-graph instead of the regex extractors
        │     incremental.ts re-parses only changed files (already calls scanFile)
        ▼
schema 1.2.0  GraphNode.exportRanges + RepoGraph.symbolEdges
        ▼
src/tools/repo-graph/query.ts  getContextPack() + transitive symbol slicing
        ▼
src/tools/repo-map.ts  action="context_pack" + action="graph_health"
```

### New language layer: `src/lang/symbol-graph.ts`

A single language-agnostic entry point, modeled on `ast-diff.ts`'s `QUERIES` map:

```ts
export interface FileSymbolFacts {
  defs: Array<{
    name: string;
    kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'method';
    exported: boolean;
    visibilityInfo?: SymbolVisibilityInfo;
    startLine: number;
    endLine: number;
  }>;
  imports: Array<{ specifier: string; importType: ImportType; bindings: Array<{ imported: string; local: string }> }>;
  refs: Array<{ identifier: string; line: number; enclosingDecl: string | null }>;
}

// Async because the first grammar load is async; parse itself is synchronous.
export async function extractFileSymbols(grammarId: string, source: string): Promise<FileSymbolFacts | null>;
```

- One inline `.scm` query set per grammar (definitions, imports, references),
  keyed by language id — mirror the `QUERIES` shape in `src/diff/ast-diff.ts:36`.
  Definitions reuse the existing `@func.def`/`@class.def`/`@type.def` capture
  conventions and add `endLine` from `node.endPosition.row + 1`.
- `src/lang/symbol-visibility.ts` is the shared visibility/export semantics API.
  It exports `SymbolVisibilityInfo`, metadata value sets, `collectCommonJsExports`,
  and `getSymbolVisibilityInfo`. Import it directly from that module; do not use
  the `src/lang/index.ts` barrel for init-sensitive code.
- `defs[].exported` is the backward-compatible graph-consumer boolean: true for
  file-level symbols addressable outside the local file/module according to the
  language (explicit ESM/CommonJS exports, Python top-level public names or
  literal `__all__`, Rust `pub*`, Go capitalized top-level identifiers,
  visibility-modifier/module-public types/functions, C/C++ non-static top-level
  declarations, Ruby public-by-default declarations, and Dart non-underscore
  top-level names). `defs[].visibilityInfo` explains the decision with
  `visibility`, `exportedReason`, and `apiSurfaceKind`.
- Method/member definitions are not promoted into file-level graph exports by
  convention-only visibility. They may carry `visibilityInfo`, but `exported`
  stays false unless an explicit export construct already made them exported.
  This avoids simple-name collisions in `exportLines`. `exportRanges` DOES admit
  JVM/.NET members (issue #1529) and resolves collisions by the three-rule policy
  documented under "Per-language `exportRanges` scope" below.
- `visibilityInfo` is extraction-time metadata only. It is not persisted in
  `RepoGraph` schema 1.2.0; persisted graph fields remain `exports`,
  `exportLines`, and `exportRanges`.
- `enclosingDecl` (the nearest top-level declaration containing a reference) is
  computed by walking ancestors of the captured identifier node; this is what
  turns file→file edges into symbol→symbol edges.
- Returns `null` on grammar-load failure/timeout (fail-open). Always
  `tree.delete()` in a `finally`. Wrap parse in a per-file timeout (500 ms, per
  ast-diff precedent).
- Consolidates import extraction so repo-graph stops drifting from
  `src/lang/backends/*.extractImports`.

### Schema 1.2.0 data model (`src/tools/repo-graph/types.ts`)

Additive, all optional — old graphs load unchanged.

```ts
// GraphNode (add)
exportRanges?: Record<string, { startLine: number; endLine: number }>; // 1-based inclusive span per symbol; see per-language scope below

// RepoGraph (add) — symbol→symbol call graph, cross-file
symbolEdges?: SymbolEdge[];

export interface SymbolEdge {
  fromFile: string;    // resolved absolute path (matches GraphNode.filePath keys)
  fromSymbol: string;  // enclosing top-level decl, or '<module>' for module-scope refs
  toFile: string;      // resolved target path
  toSymbol: string;    // exported symbol referenced
  id?: string;         // stable SHA-256 edge identity (1.5.0)
  fromId?: string;     // stable source symbol identity
  toId?: string;       // stable target symbol identity
  kind?: 'CALLS' | 'REFERENCES' | 'USES_TYPE' | 'INSTANTIATES' | 'IMPLEMENTS' | 'OVERRIDES';
  confidence?: number; // advisory 0..1
  resolution?: 'exact' | 'import_binding' | 'same_file_scope' | 'unique_name' | 'type_resolved' | 'lsp' | 'scip' | 'heuristic' | 'unresolved';
  evidence?: Array<{ file: string; line: number; column?: number; snippetHash: string; extractor: string }>;
}

// Result types for the new query
export interface ContextPackSpan { file: string; symbol: string; startLine: number; endLine: number; mode: 'full' | 'signature'; }
export interface ContextPackResult {
  schemaSupported: boolean;
  target: { file: string; symbol: string };
  spans: ContextPackSpan[];   // deduped, budget-ordered
  truncated: boolean;
  estimatedTokens: number;
  note?: string;
}
```

### Schema 1.5.0 confidence, identity, and provenance

New async builds retain the four legacy coordinates and add a complete v2 fact.
Symbol IDs hash a canonical repository label, workspace-relative path, qualified
name, and the graph identity role (`symbol` or `module`). Paths use forward
slashes and NFC Unicode while preserving case, so Linux case-distinct files do
not collide. The repository label comes from the canonical workspace basename;
renaming that directory intentionally changes the repository identity.

Current tree-sitter extraction proves a reference through an import binding but
does not prove call or type semantics. It therefore emits `kind: REFERENCES`,
`resolution: import_binding`, and confidence `0.9` when a real source line is
available. If an extractor supplies no honest line, the edge remains traversable
with confidence `0`, resolution `unresolved`, and empty evidence. It never
invents a location. Evidence contains only a relative path, position, extractor,
and SHA-256 logical-line hash—never source text.

Confidence below `0.5` is reported as low confidence by `graph_health`; it does
not block traversal or agent behavior. `unresolvedSymbolEdgeCount` reports only
complete v2 facts whose resolution is `unresolved`. Legacy four-field edges are
still normalized and traversed, but are unscored; health emits a rebuild note
instead of falsely counting every old edge as low-confidence or unresolved.

On load and save, complete v2 IDs are recomputed from canonical coordinates and
must match the persisted values. Partial v2 records, unknown enums, confidence
outside 0..1, unsafe evidence, and semantic ID mismatches are corruption. A
schema 1.2.0 graph remains readable; normalization is in-memory until an
existing caller explicitly saves it, and neither its schema version nor legacy
coordinates are rewritten.

Schema 1.2.0 originally introduced these coordinates; the current
`GRAPH_SCHEMA_VERSION` is `1.6.0`. Context queries still
self-gates with `isSchemaVersionAtLeast(graph.schema_version, '1.2.0')` and returns
`{ schemaSupported: false, note: 'rebuild with repo_map action="build"' }` on older
graphs (the `getDeadExports` pattern, `query.ts:257`).

### Schema 1.6.0 declaration kinds (KG-14, issue #1535)

`GraphNode.exportKinds` maps symbol name → declaration kind
(`function|class|const|type|interface|enum|method`). Two "kind" axes exist and
they are deliberately distinct:

- **Declaration kind** (this map): WHAT a symbol is. Every def has one. This
  powers `symbol_search`'s kind filter and the identity blocks of
  `symbol_context`/`graph_explain`.
- **Relationship kind** (`SymbolEdge.kind`, 1.5.0): HOW two symbols connect
  (CALLS/REFERENCES/…). Only cross-file-referenced symbols have edges, so
  relationship kinds cannot answer "list all classes".

Population rules mirror `exportRanges`: same builder loop, same widening and
duplicate-name policies, but only at real declaration sites — re-export
bindings add an `exportRanges` entry WITHOUT a kind (the symbol is declared
elsewhere), so `exportKinds` keys are a subset of `exportRanges` keys. The map
is optional: pre-1.6.0 graphs load unchanged and queries degrade with
`kind: null` hits; a `kind` filter on an old graph returns
`kindSupported: false`, empty hits, and an explicit rebuild warning (the
`context_pack` schema-gate precedent — never silently unfiltered results).
`graph_health.kindCoverage` reports how many nodes carry kind data.

### `context_pack` query (`src/tools/repo-graph/query.ts`)

`getContextPack(graph, file, symbol, { maxDepth, maxTokens, includeSource, sourceMode })`:
1. Gate on schema ≥ 1.2.0.
2. Seed with the target's own span from `exportRanges`.
3. Traverse `symbolEdges` both directions to `maxDepth` (forward callees + reverse
   callers), building a new symbol-keyed index in `buildReverseIndex` (`query.ts:63`).
4. Emit each reached symbol's span as `mode: 'full'`; demote the periphery (depth
   == maxDepth) to `mode: 'signature'` (first line of the range).
5. Order by relevance (target → direct neighbors → periphery), accumulate an
   `estimatedTokens` budget, set `truncated` when `maxTokens` is hit.
6. Legacy fallback: on a < 1.2.0 graph, return `schemaSupported: false` (callers
   should fall back to `callers` + manual read).
7. Internal-symbol fallback: a BFS-reached symbol with no `exportRanges` entry is
   NOT dropped — it is emitted as `startLine: 1, endLine: 1, mode: 'signature'`
   with `note: 'internal symbol — span unavailable'`. A caller slicing by that
   span reads line 1 of the file, not the symbol. This is pre-existing behavior
   for any symbol the graph knows about but has no range for; for
   java/kotlin/csharp it no longer fires for extracted member defs, which now
   carry real spans. The lookup is own-property guarded, so a symbol named after
   an `Object.prototype` member (`constructor`, `toString`) takes this path
   rather than resolving to an inherited function.

#### Source-bearing packs (KG-12, issue #1533)

`include_source: true` embeds extracted source text in spans and adds a parallel
`snippets` array with provenance. `include_source` is the sole gate; `source_mode`
only refines extraction once source was requested (`source_mode` without
`include_source` produces a warning and is ignored).

- `source_mode`:
  - `mixed` (default) — body text for near spans (span mode `full`), signature
    text for periphery spans (span mode `signature`);
  - `body` — range text for every span with an export range, capped at 80 lines
    (a capped body is returned as snippet mode `summary`, not complete source);
  - `signature` — signature text for every span with an export range.
- Snippet `mode` describes the returned text, independent of span mode:
  `full` (whole range), `signature` (signature-only), `summary` (body capped at
  80 lines).
- Signature rule (deterministic, language-agnostic): from the span's
  `startLine`, skip up to 3 leading decorator lines (`@…` — Python
  `decorated_definition` ranges start at the first decorator), then scan at most
  3 lines, stopping at the first trimmed line ending `{` or `:`; with no
  terminator (Ruby `def foo(x)`), emit only the first non-decorator line.
- Each snippet carries `hash` (sha256 hex of the returned text — a content
  fingerprint; summary-mode hashes are cap-dependent because the text itself is
  truncated, and text/hashes reflect the file's on-disk line endings, so CRLF
  and LF checkouts of the same commit hash differently) and `confidence`
  (resolution-quality score: `1.0` exact target, `0.8` resolved neighbor; real
  edge confidence arrives with KG-11/#1532).
  Spans whose read failed, fell outside the workspace, or lack an export range
  produce no snippet.
- Token budget: span-only packs keep the line-based estimate (12 tokens/line
  full, 10 signature). With `include_source`, each span's cost is REPLACED by a
  char-based estimate of the extracted text (`ceil(len / 3.5)`), and
  `estimatedTokens` reports that sum. Packing is deterministic: spans are
  greedily admitted in relevance order (target → depth → file → symbol) and the
  target span is always included, even if it alone exceeds `max_tokens` (a
  warning states this when it happens).
- Containment: source reads resolve canonically (`isCanonicalPathWithinRoot` —
  both sides realpath'd with a nearest-existing-ancestor walk), so symlinks or
  junctions pointing outside the workspace fail closed with span note
  `source outside workspace` + warning (missing in-workspace files still fail
  open with `source read failed`). Query-time source reads are additionally
  bounded by the per-file ceiling `DEFAULT_MAX_SOURCE_BYTES` (1 MiB): a
  graph-referenced file larger than the cap is never loaded — its span is
  admitted with note `source too large` + warning and no text. The graph
  builder shares this default through its `maxFileSizeBytes` option, but a
  build that raised the option above 1 MiB still gets `source too large` at
  query time, because the query layer always enforces the shared constant.
- `coverage` (present on every result): `reachedSymbols` / `returnedSymbols` /
  `omittedByBudget` (reached − returned, including `top_n` drops applied by the
  tool handler) plus `unresolvedEdges` and `lowConfidenceEdges` — distinct
  destination SYMBOLS (symbol-keyed sets, not edge instances) whose edge target
  file is absent from the graph, or whose target file exists but lacks an
  own-property export range (the same predicate as the internal-symbol span
  fallback, so coverage and spans agree — the seeded target symbol is
  classified too when it itself lacks a range).
- `warnings` (always an array): bounded and deduplicated — aggregate count
  strings for budget omissions / unresolved / low-confidence destinations, and
  at most 5 per-span failure details (`source read failed for <file>:<symbol>`,
  `source outside workspace for <file>:<symbol>`,
  `source too large for <file>:<symbol>`) followed by
  `... and N more` aggregates. The tool handler also merges staleness
  (`freshnessNote`) and `source_mode`-without-`include_source` advisories into
  `warnings`. Warnings (and `estimatedTokens`) describe the query-layer result
  BEFORE the handler's `top_n` slice — a warning may reference a span that
  `top_n` dropped (`budget.dropped` / `coverage.omittedByBudget` disclose the
  drop count); `truncated: true` likewise covers both budget exhaustion and
  `top_n` capping (pre-existing semantics).

### Tool wiring (`src/tools/repo-map.ts`) — all five surfaces

Per the `callers`/`dead_exports` precedent, a new action is incomplete until it
touches **every** one of these (no unwired code):

1. `VALID_ACTIONS` array (`repo-map.ts:60`).
2. The duplicated zod `action` enum + its `.describe()` (`repo-map.ts:245`).
3. The tool `description` action catalog (`repo-map.ts:60`).
4. The args schema — add `max_depth`/budget handling to `RepoMapArgs` if needed
   (`repo-map.ts:68`,`162`).
5. The dispatch branch in `execute` (file+symbol required → after the `!a.file`
   guard, reusing `validateFile`/`validateSymbol`/`toRelativeGraphPath`).
   `getContextPack` must be imported and **re-exported through the barrel**
   `src/tools/repo-graph.ts` or `repo-map.ts` cannot reach it.

## The sync/async + #1144 parity decision

`loadGrammar` is async; the sync `buildWorkspaceGraph` (`builder.ts:3032`) cannot
await it. Investigation shows the production build hook already defaults to
`buildWorkspaceGraphAsync` (`src/hooks/repo-graph-builder.ts:177`), and
`loadGraphSync` only **reads** persisted JSON (`src/hooks/repo-graph-injection.ts:105`).

**Decision:** symbol-level data (`exportRanges`, `symbolEdges`) is populated **only
by the async builder**. The sync builder remains for the homedir-guard tests and
any sync caller, producing file-level data only (it keeps a lightweight fallback
for `imports`/`exports` so its existing contract holds). The issue #1144 parity
test is **redefined**: sync and async must agree on all **file-level** fields
(`nodes` minus symbol fields, `edges`); symbol-level fields are asserted
**async-exclusive** (absent in sync, present and deterministic across two async
runs). This preserves #1144 for everything it currently guards while allowing
async-only symbol extraction.

## Language coverage

All **13** profile languages, resolved via `getProfileForFile(path)` →
`profile.treeSitter.grammarId` (`src/lang/profiles.ts`), each with a grammar in
`LANGUAGE_WASM_MAP` (`runtime.ts:99`). Each language needs a `.scm` query set in
`symbol-graph.ts`. `SUPPORTED_EXTENSIONS`/`EXTENSION_TO_LANGUAGE`/`getLanguage` in
the builder are replaced by a lookup through the language registry so the supported
set is driven by the profiles, not a hard-coded list. Files whose grammar is
unavailable or that exceed the size cap degrade to a file-level node (fail-open),
never crashing the build.

**Java, Kotlin, C#** (`.java`, `.kt`, `.kts`, `.cs`, `.csx`) are hardened as
follows:

- Class/interface/enum/record declarations are extracted as defs. **Java and C#
  explicit constructors** are extracted too, typed `method` (deliberately, to
  avoid colliding with `Object.prototype.constructor`). Kotlin constructors are
  **not** extracted at all — primary or secondary — because the Kotlin defs
  query carries no constructor pattern; nor are primary-constructor and record
  canonical-constructor forms in any of the three languages, which fold into the
  enclosing class/record def. A nested (non-top-level) type declaration is
  visibility-classified rather than defaulting to private.
- Member methods declared inside a class/interface/enum/record/struct/object
  container are typed `method` (not `function`), matching the Python/Rust
  convention.
- Visibility is modifier-derived per language, falling back to a
  container-kind-aware default only when no explicit modifier is present: Java
  members with no access modifier are **package-private**; Kotlin members are
  **public by default** (top-level Kotlin declarations are also public by
  default, correcting the previous `internal` default); C# members default to
  **internal** at file scope and **private** inside a class/struct/enum body,
  matching the language's actual default.
- Package (Java/Kotlin `package ...;`) and namespace (C# `namespace N;` or
  `namespace N { }`) declarations are read from source and become the graph's
  package/namespace boundary metadata, in preference to a path-only guess.
- `import`/`using` declarations produce real bindings (imported symbol → local
  name), including Java static imports and Kotlin/C# aliases, so import edges
  and best-effort symbol edges can form the same way they do for TS/JS/Python.

### Per-language `exportRanges` scope (issue #1529)

`exports` and `exportLines` are **exported-only in every language**. A JVM/.NET
member is deliberately not a file-level module export, and that contract did not
change.

`exportRanges` is scoped differently:

| grammars | contents |
|---|---|
| java, kotlin, csharp, cpp, swift (#1530), dart, ruby, php (#1531) | extracted defs including non-exported members, subject to the collision rules and the malformed-range guard below |
| all others | exported defs only (scope unchanged) |

"Including non-exported members" is not "every def": a name collision keeps one
entry (so a member and a same-named nested type do not both appear), and a
malformed range is skipped.

The widening exists so `context_pack` can return a real span for a Java method
instead of the `internal symbol — span unavailable` placeholder. It is gated on
the grammar id, so **the widening** changes no other grammar's `exportRanges`
scope.

That is not the same as "no other payload changes". A separate fix in this same
change added the missing `method_definition` capture to the `javascript` defs
query (it was present for `typescript`/`tsx` only), so `.js` payloads DO change:
class members now appear in `exports`, `exportLines` and `exportRanges`, and an
`exportLines[name]` that previously pointed at a top-level function can now point
at a same-named member. See the release fragment for the consumer-facing note.

Duplicate names inside the widened grammars resolve in three cases, chosen so
`exportRanges` can never disagree with the exported-only `exportLines`:

1. an exported def outranks a non-exported one;
2. two exported defs (a C# partial class) take the **last**, matching `exportLines`;
3. two non-exported defs (a constructor and its class, or overloads) take the
   **first**, and never appear in `exportLines` at all.

A malformed range (non-positive or inverted) is skipped rather than written,
because `validateGraphNode` throws on one and runs inside the scan; the async
builder catches that and drops the whole **file**, so one bad def would cost
every def in it. The guard also rejects non-integer bounds. That guard is scoped to the widened
grammars so other languages keep their previous behavior exactly.

### Registry / profile extension parity

`src/lang/profiles.ts` declares the extensions a language owns;
`src/lang/registry.ts` declares what `getParserForFile` / `isSupportedFile`
accept. These had drifted: `.csx` (C#), `.pyw` (Python) and `.rake` / `.gemspec`
(Ruby) were declared by a profile but missing from the registry, so those files
were walked by the graph builder yet reported unsupported by the parser registry.
All four are now registered.

Downstream effect worth knowing: `getParserForFile` also backs
`src/tools/placeholder-scan.ts` and `src/tools/syntax-check.ts`, so those tools
now parse these four file classes where they previously skipped them —
`syntax_check` can report diagnostics on files it used to ignore.

`tests/unit/lang/profile-registry-extension-parity.test.ts` closes the class by
checking every profile extension resolves through the real `extname()` lookup.

### Dotted-module probe precedence

Resolution runs three probes, each sweeping **every** conventional source root
before the next probe begins:

1. the full dotted path as a **file** (a type);
2. the full dotted path as a package/namespace **directory**, resolved to a
   representative member;
3. the **parent** path as a file — a nested type (Java/Kotlin only, see below).

**Probe specificity outranks root specificity.** A package-directory match under
`src/main/java` beats a parent-as-file match at the repository root. This also
changed Java behavior: `import z.Outer.Inner;` with both `z/Outer.java` and
`src/main/java/z/Outer/Inner/` present now resolves to a member of the package
directory rather than to `z/Outer.java`. A real directory at the full dotted
path is strong evidence the specifier names a package, so the more specific
probe is preferred — but it is a change, and it is pinned by test.

Interleaving the probes per-root (the original shape) let the weakest probe win
from the `''` root before a deeper root was ever considered, which is how
`using App.Models;` resolved to an unrelated `App.cs`.

### Known limitation: C# nested-type imports do not resolve

Dotted-module resolution runs three probes, the last of which reads the PARENT
path as a file so a Java nested type resolves (`a.b.Outer.Inner` ->
`a/b/Outer.java`). That probe is **Java and Kotlin only**.

A Java non-wildcard import names a type, so the probe is the normal nested-type
syntax there. A C# `using X.Y;` names a *namespace*, and C# reaches a nested
type through `using static X.Y.Z;` or a using-alias — neither distinguishable
from a namespace import by the specifier string alone. Running the probe for C#
fabricated edges to unrelated type files: `using Serilog.Sinks;` resolved to a
local `Serilog.cs` that the source never referenced.

Concretely, every C#/`.csx` specifier `X.Y.Z` where `X/Y/Z` is neither a file
nor a directory but `X/Y.cs` exists now yields no edge. That covers both
using-aliases and `using static`. A missing edge is preferred to a false one;
closing the gap properly would need type resolution, which is an explicit
non-goal.

### Known limitation: `packageBoundary` and nested Kotlin block comments

`sourceBoundaryForLanguage` reads the `package` / `namespace` declaration from
comment-stripped source, and masks multi-line string literals so a line-initial
declaration inside a C# verbatim string, a C# raw string, or a Java/Kotlin text
block does not win.

This is a lexical approximation, not a parser, and it is stated that way
deliberately: six successive review rounds each found one more input where an
earlier absolute claim here was false. The masker handles the forms pinned in
`tests/unit/tools/repo-graph-package-boundary.test.ts`; the known remaining gaps
are listed below. It reads `stripComments` output, so it also inherits that
helper's defects.

Raw-literal delimiters are measured by **run length**, not assumed to be three
quotes. A C# raw string opens on a run of N ≥ 3 — that form exists so content
can contain `"""` — so closing on a hard-coded `"""` terminated such a literal
on its own content and resumed the scan inside the string. Java and Kotlin only
ever open with three.

The closing fence is taken as the **last N quotes** of a run of at least N. For
Kotlin that is the language rule. For C#, a closing run longer than N is a
compile error (CS8998), so on compilable input this is indistinguishable from
requiring an exact-length run; the looser rule is chosen because on malformed or
generated input, requiring exactness makes the scan skip the run and hunt
forward, blanking real code in between.

Escape handling applies to **Java only**. A text block is the one raw form with
escape sequences (JLS 3.10.6), and `\"""` is the JEP 378 idiom for embedding a
text block inside a text block — only two of those quotes are unescaped, so it
must not terminate, while `\\"""` (escaped backslash) must. C# raw strings and
Kotlin raw strings have no escapes, so applying the same rule to them would be
wrong in the opposite direction.

The masker is a single left-to-right scan that consumes ordinary strings and
char literals rather than ignoring them, because a regex has no notion of
already being inside a literal. Its consume is bounded to one line, since none
of the three languages permits a raw newline in the literal **text** of an
ordinary string or char literal. (A C# interpolated string may span lines inside
an interpolation hole — verified against .NET 10 — but a hole holds code, not
literal text, so leaving it unmasked is the correct outcome.) An unpaired quote — a C# preprocessor message such as
`#warning check "` or `#region Customer's data` is arbitrary
input-characters and is never string-tokenized — is emitted as an ordinary
character rather than consumed to EOF.

Two gaps remain, deliberately not fixed here. First, an **unterminated**
multi-line literal (`"""` or `@"` with no partner) emits the rest of the file
untouched rather than blanking to EOF. That is the right trade — a later real
declaration must still be findable — but it means a truncated, generated, or
templated file leaves the remainder unmasked. Second: `stripComments` does not track
**nested** block comments. Java and C# block comments do not nest (JLS 3.7), so
for those languages the current behavior is correct — the first `*/` really does
close the comment. **Kotlin block comments do nest**, so a declaration inside a
nested comment can still be read as live code.

A second, separate `stripComments` defect compounds this, in **C# only**
(measured: the Java and Kotlin analogues resolve correctly, because the trigger
syntax is C#-specific): its string state treats a backslash as an escape, but a C# verbatim
literal has no backslash escapes. A Windows path such as `@"C:\dir\"` therefore
swallows its own terminator, the scanner never leaves the string state, and a
block comment below it is never stripped — so a declaration inside that comment
can win. The string-masking remedy above consumes `stripComments` output, so it
cannot compensate for this. Closing either would require
changing a shared pre-existing helper used by all ontology extraction; the impact
is limited to a grouping/display key, so it is recorded here rather than patched
under this issue.

### Known limitations: dotted resolution and `packageBoundary` (round-2 feedback)

Recorded rather than fixed, with the measurement behind each:

- **Nested multi-module roots are not probed.** `JVM_DOTNET_DOTTED_ROOTS` holds
  fixed top-level prefixes, so a Gradle/Maven layout such as
  `moduleA/src/main/java/...` yields no edge. This fails CLOSED — a missing
  edge, never a fabricated one — which is why it is recorded rather than
  guessed at with a glob.
- **A C# file with two namespaces collapses to the first.** `packageBoundary` is
  a single string per file, so a file declaring `namespace First;` and
  `namespace Second;` reports `First`. There is no correct single answer for
  that file; the alternative would be to report nothing.
- **Dotted resolution is uncached.** Measured: repeat lookups of the same
  specifier stay flat at ~0.33 ms (no memoization), and an adversarial synthetic
  workspace (2300 files, 1800 unresolved probes, a 2000-entry package
  directory) spent ~10% of build time in the probes — the rest is tree-sitter
  parsing. Cost is bounded by the four fixed roots and `statSync` ENOENT
  short-circuits before any `readdirSync`, so this is a scaling safeguard to
  consider later, not a present defect.
- **Probes run before containment validation.** `statSync`/`readdirSync` touch a
  candidate path before `safeRealpathSync` and the workspace-boundary check
  reject it, so a symlink planted inside the workspace can cause a directory
  listing outside it to be read. The escaped path is still rejected and never
  reaches graph output; this is an internal confused-deputy oracle, and it
  requires write access to the scanned workspace to trigger.
- **Import resolution and the walker apply different filters.** A file inside a
  `SKIP_DIRECTORIES` entry resolves but is never indexed. Such edges are now
  reclassified `targetKind: 'asset'` at graph assembly so no edge claims a node
  that does not exist; the dependency itself is preserved.

## Invariant audit (for the implementing PR)

- **1 (plugin init): touched, must be proven safe.** Tree-sitter is async/lazy and
  off the init path (`src/index.ts` imports no runtime). Add a test asserting init
  never loads a grammar; keep the `repro-704` ~400 ms deadline green.
- **2 (runtime portability): touched.** Rides the existing `web-tree-sitter` WASM
  loader already validated by `package-check` (grammar assets in the tarball). No
  new `bun:`/`Bun.*`. `symbol-graph.ts` must pass the same purity bar as backends.
- **3 (subprocesses): not touched.** Tree-sitter parses in-process; no spawn.
- **4 (.swarm containment): not touched.** Graph still persists to
  `.swarm/repo-graph.json`; the design doc is a committed deliverable (docs
  exception).
- **7 (test writing): touched.** New `bun:test` suites, `_internals` DI seam, temp
  dirs under `os.tmpdir()`/`process.cwd()`; no `mock.module`.
- **11 (tool registration): touched (action only).** `context_pack` is internal to
  `repo_map`, so — like `callers`/`dead_exports` — no new top-level tool, no
  `TOOL_NAMES`/agent-map change; the five `repo-map.ts` surfaces above must all be
  wired and tested.
- **12 (release/cache): touched.** Ship a `docs/releases/pending/<slug>.md`
  fragment; confirm `package-check` still validates grammar assets.

## Performance & limits

- Lazy grammar load (cached, coalesced) + synchronous `parser.parse`; per-file
  parse timeout (500 ms) and `tree.delete()` cleanup (ast-diff precedent).
- Bounded concurrency for the async parse pass (syntax-check uses `pLimit(8)`).
- Incremental rebuild (`incremental.ts`) already re-parses only changed files via
  `scanFile`, so steady-state cost is per-edit, not per-repo.
- Existing walk budgets (`DEFAULT_WALK_FILE_CAP` 10 000, `DEFAULT_WALK_BUDGET_MS`
  5 000) and the 2 MB/file cap still apply. A perf gate at ~10 k files is a release
  criterion before the regex path is removed.

## Milestones

1. `src/lang/symbol-graph.ts` + `.scm` query sets for all 13 grammars (defs +
   imports + refs), with per-language tests. Behind a flag; nothing else changes.
2. Rewire the async builder's `scanFile` onto `symbol-graph.ts`; reconcile
   `usedSymbols`/`exportLines`; keep TS/JS/Python output equivalent-or-better.
   Redefine the #1144 parity test.
3. Schema 1.2.0: `exportRanges` + `symbolEdges` + validators + barrel exports;
   storage `validateLoadedGraph` extended to iterate `symbolEdges`.
4. `getContextPack` + transitive symbol slicing + symbol-keyed query index.
5. `context_pack` tool action wired through all five `repo-map.ts` surfaces, with
   tool-level tests and docs/release-fragment.
6. `graph_health` tool action reports freshness and bounded diagnostics collected
   during async graph builds; old graphs without diagnostics remain readable and
   return a rebuild note.

## Usage

```text
repo_map { "action": "build" }                                  # populates 1.6.0 symbol facts (async build)
repo_map { "action": "graph_health" }                           # freshness + extraction diagnostics + KG-14 summaries
repo_map { "action": "callers", "file": "src/foo.ts", "symbol": "doThing" }
repo_map { "action": "context_pack", "file": "src/foo.ts", "symbol": "doThing", "max_depth": 2, "top_n": 40 }

# KG-14 expanded graph queries (issue #1535)
repo_map { "action": "symbol_search", "symbol": "calcul", "kind": "class", "top_n": 25 }
repo_map { "action": "symbol_context", "file": "src/foo.ts", "symbol": "doThing", "include_source": true }
repo_map { "action": "symbol_context", "symbol_id": "<64-hex stable id>" }
repo_map { "action": "impact_cone", "file": "src/foo.ts", "symbol": "doThing", "max_depth": 3 }
repo_map { "action": "diff_context", "diff": "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@ ..." }
repo_map { "action": "diff_context", "files": ["src/foo.ts", "src/bar.ts"] }
repo_map { "action": "graph_explain", "file": "src/foo.ts", "line": 42 }

# KG-15 change-risk packs (issue #1536)
repo_map { "action": "route_trace", "route_path": "/api/users", "method": "POST" }
repo_map { "action": "route_trace", "file": "app/api/users/route.ts" }
repo_map { "action": "data_trace", "entity": "user" }
repo_map { "action": "data_trace", "entity": "API_BASE_URL" }
repo_map { "action": "test_pack", "file": "src/foo.ts" }
repo_map { "action": "test_pack", "diff": "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ ..." }
repo_map { "action": "retrieve", "question": "Who calls createSession?", "symbol": "createSession" }
repo_map { "action": "retrieve", "question": "Find exact string SWARM_FOO" }
```

## KG-14 expanded graph query actions (issue #1535)

Implemented in `src/tools/repo-graph/symbol-query.ts` (stateless, read-only;
`extractSignatureText` is shared with `query.ts` so pack and identity
signatures cannot diverge). Every action was wired through all five
`repo-map.ts` surfaces, emits `{ success, action, ...payload }` JSON with
`budget {returned, dropped}` envelopes, spreads the freshness metadata, and
returns workspace-relative forward-slash paths.

| Action | Input | Output (bounded) |
| --- | --- | --- |
| `symbol_search` | `symbol` (term) + optional `kind`/`visibility`/`language`/`file`/`top_n` (25) | tiered hits (`exact`>`prefix`>`substring`>`subsequence`) with kind/visibility/line; kind filter degrades on < 1.6.0 graphs |
| `symbol_context` | `symbol_id` OR `file`+`symbol`, optional `include_source`/`top_n` (25) | identity (stable id, kind, visibility, lines), signature, hashed source, depth-1 callers/callees; `symbolIdScan {computed, capped}` (scan cap 10 000) |
| `impact_cone` | `file` + optional `symbol`, `max_depth` (3), `top_n` (50) | direction-scoped cone entries with relationshipKind/confidence/resolution, `fileImpact` = verbatim `getBlastRadius` (risk semantics identical to `blast_radius`), tests/routes/data/security facts (≤20 each), boundaries, fixed-vocabulary riskNotes |
| `diff_context` | `files` OR `diff` (≤ 50 000 chars; only `\r\n\t` whitespace allowed), `max_depth` (2), `top_n` (25) | hunk→symbol mapping with `changedLines` (or file-granularity with a note), per-file impact union with risk; caps: 50 files, 200 hunks, 50 changed lines/symbol; unsafe diff paths are skipped with a warning |
| `graph_explain` | `file` + optional `symbol`/`line`/`top_n` (20) | `resolvedSpan` (smallest containing range), definition, reasons (`definition`/`referenced_by`/`references`/`imported_by`/`imports`) with ≤3 evidence records each; legacy edges warn |

`graph_health` additionally returns (all optional-but-always-populated on the
result, zero-valued when data is absent): `symbolEdgeSummary`, `resolutionBreakdown`
(includes `unrecorded` for legacy edges), `staleSummary` (`null` without a
probe; `probeTruncated` is the freshness walk, distinct from build-time
`walkTruncated`), `extractionFailureSummary`, and `kindCoverage`.

## KG-15 change-risk packs: routes, data, security, tests (issue #1536)

Implemented in `src/tools/repo-graph/pack-query.ts` (stateless, read-only,
same conventions as `symbol-query.ts`). Packs join the file-level ontology
facts to their subjects via the additive schema 1.7.0
`GraphNode.ontology.links` array:

| Link kind | Extracted from | Subject | Symbol-bound | Confidence |
| --- | --- | --- | --- | --- |
| `HANDLES_ROUTE` | each `RouteFact` | `'<METHOD> <path>'` | `handler_export` → the method-named export; `router_call` → named handler arg when present | high / medium / low by source |
| `READS` / `WRITES` / `DELETES` | entity-bearing `DataOperationFact`s | entity/table name | file-level | medium (low for transaction/migration → WRITES) |
| `VALIDATES` / `AUTHORIZES` | `input_validation` / `authorization` security facts | — (file-level) | file-level | inherits fact confidence |
| `CONFIGURES` | `process.env.X`, `process.env['X']`, `import.meta.env.X`, `Deno.env.get('X')` | env/config key | file-level | medium; ≤20 keys/file, deduped |
| `TESTS` / `USES_FIXTURE` | **derived at query time** (never persisted) from import edges + colocated-name heuristics; materialized in `test_pack` output as association records (`kind`/`fromFile`/`toFile`/`evidence`/`confidence`, ≤200) | — | — | high (explicit import) / medium (colocated) |

Link extraction runs inside `extractFileOntology` on comment-stripped source,
after the fact arrays are capped (order invariant: roles → routes → data →
security → conventions → findings → links; ≤200 links/file). Validation:
`subject` is bounded (≤200 chars, identifier-first, no `..` path segment, no quotes/
backslash — but deliberately NOT character-whitelisted, because router-call
paths legally carry `{param}`/`<int:id>`/query-string punctuation and a
validation failure would drop the whole node); `kind`/`confidence` are
enum-checked; `line` must be a positive integer; `evidence`/`symbol` are
control-character-checked (bounded at extraction time).

| Action | Input | Output (bounded) |
| --- | --- | --- |
| `route_trace` | `route_path` (normalized: `[id]`→`:id`, `[...slug]`→`:slug*`) OR `file` OR `symbol` (HTTP method or link-bound handler; symbol-only search is restricted to `api_route`-role files), optional `method` and `symbol` filters (they compose with every target form; routes stored as `ALL` match any method), `top_n` (25) | per matched route: `route` fact, handler file, `handlerSymbol`+`handlerConfidence` (from the HANDLES_ROUTE link — the last-argument named handler for router calls; `handler_export` falls back to the method-named export at `confidence: null` on old graphs), depth-1 `services` (non-test nodes, deduped/sorted), `dataOperations`/`security` from handler+services (≤20 each), `handlerEvidence` (the link's evidence line; null without a link), handler-file `findings` (e.g. `api_route_without_detected_auth` — the unguarded-mutating-route surface), `tests` (test-file importers) |
| `data_trace` | `entity` (entity/table/config/env key; case-insensitive) OR `file` OR `symbol`, optional `top_n` (25) | `readers`/`writers`/`deleters`/`configurers` (each entry carries kind/line/evidence/confidence and `via: 'link' \| 'fact'`), touching `routes` (≤20), `tests`, fixed-vocabulary `riskNotes` (no tests detected; delete-ops coverage; cross-boundary writes) |
| `test_pack` | `file` OR `files` OR `symbol` OR `diff` (unified diff; parsed via `getDiffContext`), optional `top_n` (25) | `tests` (`basis: 'import'` high / `'colocated'` medium, `evidence` = import specifier or colocated rationale, `coveredSymbols` = edge imported∪used ∩ target exports), `fixtures` (fixture-pattern files imported by ≥1 discovered test, with `usedBy` + `confidence`/`evidence`), `helpers` (non-fixture deps shared by ≥2 discovered tests), `uncoveredExports`, `riskNotes`, `associations` (materialized TESTS/USES_FIXTURE records, ≤200) |

## KG-16 hybrid retrieval router (issue #1537)

`retrieve` requires `question` and accepts the existing optional target fields
(`file`, `files`, `symbol`, `diff`, `route_path`, `method`, `entity`), `top_n`,
and `max_tokens`. It returns the deterministic mode, executed actions, bounded
context, explanations, graph hit/miss, explicit fallback reason, warnings, and
requested/used/omitted budget counters. The `semantic` mode is an intent class
implemented by the zero-embedding `fuzzy_graph` algorithm (vocabulary expansion,
IDF, and PageRank); it never claims embedding similarity.

Explicit target hints intentionally take precedence over natural-language cues,
except for an exact-string cue, which always selects literal verification. Route/entity
hints otherwise select security packs, change/file scope selects hybrid or test packs,
and file/symbol targets select graph queries. This keeps a caller's concrete scope
deterministic while ensuring exact-string requests cannot be satisfied by unrelated
graph evidence.

Fixture patterns (module path, lowercase): a `fixtures?` / `__fixtures__` /
`mocks?` / `factories` path segment, or a basename containing `fixture` /
`mock` / `factory` / `test-utils` / `test-helpers` / `testing-utils`.

### Degradation and caveats

- Pre-1.7.0 graphs still answer: facts/edges-derived sections populate, and
  route/data packs carry `linksSupported: false` plus an explicit rebuild
  warning; `data_trace` entity matching falls back to `DataOperationFact`
  entities (`via: 'fact'`, `confidence: null`). `test_pack` derives everything
  from edges and works on every schema (no flag).
- The schema bump invalidates freshness fingerprints (`EXTRACTOR_STAMP`
  includes `GRAPH_SCHEMA_VERSION`), so the first probe after upgrade reports
  drift until a rebuild.
- Entity extraction is limited to `prisma.`/`db.`/`database.` receivers
  (`repository.X`/`model.X` are not seen); entity-less data facts remain
  per-file facts and are not linked.
- Derived TESTS/USES_FIXTURE associations age exactly with the graph's edges:
  a stale snapshot misses them just as it misses the edges themselves.
- Packs are advisory and heuristic. They never execute test frameworks, never
  claim security proofs, and mirror the ontology extractor's conservative
  posture. `impact_cone` is unchanged; deeper route/data/test views are these
  dedicated actions.
- `max_tokens` bounds packed retrieval context only. Router metadata is returned
  alongside that context and is accounted for separately by
  `metadataOverheadTokens`; when the requested context budget is too small to
  carry even a compact action marker, the response is intentionally empty and
  includes `context_budget_too_small` rather than silently implying coverage.
- The unguarded-route advisory is a FILE-level heuristic: the auth/validation
  sweep covers the whole handler file, so a guarded sibling route suppresses
  the advisory for every route in that file — and absence of the advisory is
  NOT evidence that an individual route is guarded. Regex-constrained router
  paths (`router.get('/user/:id(\d+)', h)`) are captured verbatim, backslash
  escapes included. `CONFIGURES` evidence lines may capture secret-bearing
  source (e.g. a hardcoded fallback next to `process.env.X`); graph files stay
  workspace-local as with all evidence fields.

## Limitations (by design)

- Conservative, advisory analysis. Tree-sitter sees syntax, not types: dynamic
  dispatch, reflection, and runtime-computed symbol access are invisible.
  `dead_exports`/`context_pack` are aids, never delete/edit directives.
- Reference attribution resolves by name within scope, not by full type
  resolution; overload-heavy (C++/Java) and highly dynamic (Ruby/Python) languages
  are best-effort.
- Symbol data requires an async rebuild; the sync builder yields file-level data
  only.
- **Overload resolution is conservative.** The graph is name-keyed: overloaded
  methods (Java/C# same-name, different-signature methods) share a single
  symbol name and are not disambiguated by parameter list or return type.
- **No inheritance or dynamic/virtual dispatch resolution.** Extraction does no
  type resolution (an explicit non-goal), so a call through an interface,
  abstract base, or virtual/override method is not resolved to a specific
  overriding implementation.
- **Kotlin extension-function dispatch is syntactic only.** An extension
  function's receiver type is read from its declaration text, not resolved, so
  calls are attributed by name, not by the actual receiver type at a call
  site.
- **C# partial classes are not merged.** Each `partial class` declaration is
  extracted as its own, separate type declaration per file; members declared
  in a different partial-class file are not unified into one logical type.
- **Generated code is invisible.** No build tool is invoked (Java annotation
  processors, C# source generators, etc.), so extraction only sees what is
  written in the source file, never generated output.
- **Dotted-module import resolution is best-effort.** Java/Kotlin/C# imports
  are resolved against conventional source-root layouts on disk
  (filesystem-based, not a build-tool classpath/package resolution). An import
  naming a *type* that does not map to a file under a detected source root
  produces no edge rather than a wrong one.
- **A package/namespace import resolves to a representative file.** `import
  a.b.*;` and `using App.Data;` name a directory, not a file. As with Go
  package imports — which this codebase already resolves the same way — the
  edge points at a representative member of that directory (a same-named file
  where that convention exists, otherwise the first by code-unit order). Read
  such an edge as "depends on this package", not as "references this exact
  file". Consumers needing precise per-symbol attribution should use symbol
  edges, which are only emitted for imports that bind a specific name.

### Native language limitations (C/C++ and Swift)

Extraction for C/C++ (`.c`, `.h`, `.cpp`, `.hpp`, `.cc`, `.cxx`) and Swift
(`.swift`) is syntax-only and deliberately conservative. No compiler or
SourceKit is invoked (an explicit non-goal), so everything below is derived
from the tree-sitter parse alone.

- **Include resolution is quoted-only.** A quoted include (`#include
  "util.h"`) resolves relative to the including file and produces a file edge.
  An angle include (`#include <vector>`) is treated as external/unresolved and
  produces no edge: real include paths come from the build system (`-I` flags,
  CMake/VCPkg/Xcode search paths), which are not known to the extractor.
- **Overload collapse is conservative.** All C++ overloads of a name are
  extracted, but the graph is name-keyed: `exportRanges` holds one span per
  name (resolved by the three-rule duplicate-name policy — an exported def
  outranks a non-exported one; two exported defs take the last; two
  non-exported defs take the first), so `context_pack` cannot distinguish
  overload signatures.
- **Macros can hide definitions and references.** A definition or reference
  manufactured by the preprocessor (`#define MAKE_FN(name) ...`) is invisible
  to the syntactic pass.
- **Templates are best-effort.** A `template <typename T>` function or class
  is extracted as a plain symbol; template instantiations and specializations
  are not resolved, and ranges cover only the declaration as written.
- **C++ access specifiers are not tracked.** `public:`/`protected:`/`private:`
  sections carry no per-member visibility: class members default by container
  kind (class → private, struct/union → public) and are never file-level
  exports. Before this hardening they were not extracted at all; the
  conservative non-exported representation avoids advertising
  access-restricted members as public API.
- **`static` and anonymous namespaces are internal.** A `static`
  file-scope function and anything inside `namespace { … }` is marked
  not-exported (internal linkage), mirroring the linker's view.
- **Swift struct/enum are modeled as class kind.** The tree-sitter Swift
  grammar parses `struct`, `enum`, and `extension` blocks all as
  `class_declaration`; kind discrimination is not modeled, so a struct or enum
  def carries kind `class` and an extension contributes a `type` def for the
  extended type. Members inside any of them (including extensions) are
  attributed as `method`.
- **Swift `init`/`deinit` and stored properties are not extracted.**
  Constructors have no name node in the grammar, and properties are outside
  the issue's symbol scope; only functions, classes/structs/enums, protocols,
  extensions, and typealiases are represented.
- **Swift module resolution is conservative.** `import Foundation` records a
  module-level import; kind-qualified imports (`import class Foo.Bar`) split
  into module specifier + named binding. Module names never resolve to
  workspace files (a Swift module spans many files and needs build metadata
  to map), so Swift imports produce no file-level edges — `context_pack` on a
  Swift symbol is served by the target file's own spans. Xcode
  project-specific resolution is out of scope.
- **C++ operator overloads, conversion operators, and destructors are not
  extracted.** Their names parse as dedicated grammar nodes
  (`operator+`, `operator int`, `~Foo`), not plain identifiers, and the
  query set does not model them. Regular member/static/free functions are
  unaffected.
- **Swift extension blocks augment, never re-export.** An `extension Foo`
  emits a non-exported def for `Foo` so the type's own declaration keeps its
  `exportRanges` span and `exports[]` entry; extension members are still
  extracted and attributed as methods.

### Dynamic language limitations (Dart, Ruby, PHP — issue #1531)

Extraction for Dart (`.dart`), Ruby (`.rb`, `.rake`, `.gemspec`), and PHP
(`.php`, `.phtml`, `.blade.php`) is syntax-only and deliberately conservative.
Tree-sitter queries remain the primary source; a regex augmentation layer
(`augmentNativeDynamicDefs` in `src/lang/symbol-graph.ts`) adds facts the
queries cannot express (Ruby visibility sections/constants/singleton methods,
PHP method visibility/namespaces/enums, Dart mixin/enum/extension). Commented
and string-literal text is masked before augmentation (length-preserving, so
line/offset arithmetic is exact and CRLF-safe — the #1526 bug class). The
line scanners advance offsets by the actual separator width, so CRLF and LF
sources produce identical facts. Modifier-keyword quantifiers are bounded
(an unbounded `(?:(kw)\s+)*` star measured ~8s at 1MB — quadratic
backtracking). No language runtime, Flutter, Bundler, or Composer tooling is
invoked (explicit non-goals).

- **Dart visibility is the `_`-prefix convention.** Public-by-default names are
  exported; `_`-prefixed names are private and never file-level exports.
- **Dart `show`/`hide`/`as` clauses.** `show` imports produce named bindings;
  `hide` is intentionally unhandled (the import is recorded as a namespace
  import of everything minus the hidden names — correct for graph purposes);
  `as` prefix imports are namespace imports with no named binding, including
  when a `show`/`hide` clause follows the prefix (`import 'x' as p show A;`).
  `export 'x' show A` produces a re-export edge with exported bindings. A show
list split across lines is parsed whole. Conditional imports
(`import 'a' if (dart.library.io) 'b';`) record BOTH URIs — resolution
happens at runtime, so either target can carry an edge.
- **Dart type declarations include Dart 3 forms.** `class`/`mixin`/`enum`/
  `extension`/`typedef` and `extension type` (extension types capture the
  type's name) are extracted as defs; Dart 3 class modifiers
  (`base`/`final`/`interface`/`sealed`/`abstract`) do not change the captured
  name. Unnamed `extension on X` carries no def (there is no name to record).
- **Dart class members are not def-captured as methods.** Only top-level
  `function_signature` defs and type defs exist. Flutter widget `build`
  methods are therefore invisible as method defs; the enclosing widget class
  def carries the span. `package:` URIs are recorded as import specifiers but
  do not resolve to workspace files (pub package layout is external).
- **Ruby singleton methods keep their `self.` prefix in the name.** A
  `def self.build` is keyed as `self.build` in `exportRanges` and
  `context_pack` lookups — query it as `self.build`, not `build`.
- **Ruby visibility sections are line-tracked with nesting restore.** Bare
  `private`/`protected` statements switch the section for the remainder of the
  class body; entering a nested `class`/`module` pushes a fresh public section
  and closing it (approximate `end`-keyword balance) restores the outer one.
  The symbol-argument form (`private :a, :b`) marks the named methods in place
  without switching the section. `private_class_method` and per-definition
  `private def x` forms are not modeled.
- **Ruby heredoc bodies are skipped.** A literal `private` or a `def`/`class`
  line inside a heredoc body is string data, not code — it neither flips the
  visibility section nor creates defs; the opener line's own declarations
  (e.g. `QUERY = <<~SQL`) still count. Openers are context-anchored (line
  start, after `=`/`(`/`,`/`[`, or a value-position keyword like `puts`), so
  the binary shift operator (`arr <<item`, `x << y`) never opens a heredoc.
  An unterminated heredoc (invalid Ruby) silently degrades augmentation after
  the opener; tree-sitter query defs still survive.
- **Ruby dynamic constructs are invisible by design.** `send`, `const_get`,
  `define_method`, `method_missing`, and metaprogramming-generated methods
  produce no facts. `include`/`extend`/`prepend` mixin composition is not an
  import or symbol edge. Constants are extracted from simple `NAME = value`
  lines only.
- **Ruby requires bind no names.** `require`/`require_relative` produce file
  edges only (`require_relative 'x'` normalizes to `./x`); there are no named
  bindings, so no Ruby symbol edges arise from imports.
- **PHP method visibility comes from modifiers** (`public`/`protected`/
  `private`, defaulting public), and `_`-prefixed names are treated private.
  Trait declarations are extracted typed `interface` (matching the Rust
  trait→interface precedent). Namespaces (`namespace X;` and brace form) are
  extracted as `type` defs. PHP 8.1 `enum` declarations are extracted as
  `enum` defs with their methods.
- **PHP `use` semantics.** An aliased `use A\B\C as D` binds the SHORT name
  (`C`) to `D` — what body expressions spell. A non-aliased `use A\B\C;` is a
  namespace import with no bindings, and its FQN specifier does not resolve to
  a workspace file: mapping namespaces to paths requires composer PSR-4
  awareness, which is out of scope. Grouped `use A\B, C\D;` statements are
  skipped entirely (known limitation). A `use TraitName;` INSIDE a class or
  trait body is a trait inclusion, not an import — it produces no edge.
- **PHP dynamic constructs are invisible by design.** Variable functions
  (`$f()`), variable classes (`new $cls`), `call_user_func`, and string-built
  symbol references produce no facts.
- **Blade templates are best-effort.** `.blade.php` files parse through the
  PHP path; Blade directives (`@foreach`, `{{ }}`) are opaque to the extractor
  and `@php` blocks are scanned as ordinary PHP. See `docs/php-laravel.md`.
- **Augmented defs carry a binary `apiSurfaceKind`.** Regex-augmented defs
  populate `apiSurfaceKind` as `public`/`private` only (there is no AST node
  to run the full visibility classifier against); the `visibility` field
  remains precise (e.g. `protected` from a modifier).
- **`dart`, `ruby`, `php` are `RANGE_WIDENED_GRAMMARS`.** Non-exported member
  defs (Ruby/PHP methods) enter `exportRanges` so `context_pack` can serve
  member spans; `exports[]`/`exportLines` stay exported-only. The sync
  `buildWorkspaceGraph` fallback also collects exports for these languages
  via the regex extractors, so an AST timeout does not lose export metadata.
- **Import resolution is importer-language aware.** An extensionless relative
  specifier probes the importing file's own language family first: a Ruby
  `require_relative 'foo'` resolves `foo.rb` even when a sibling `foo.ts`
  exists.
- **The `symbols` tool qualifies Dart class members** as `TypeName.member`
  with kind `method` (mirroring the Swift extractor), so same-named members of
  different classes do not collapse.
