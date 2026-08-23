# repo-graph: symbol-level call graph & context packing (schema 1.2.0)

> Status: implemented (schema 1.2.0). Origin: follow-up to issue #1409 / PR #1468 (schema 1.1.0).
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
(`SUPPORTED_EXTENSIONS` at `src/tools/repo-graph/builder.ts:113`).

Two ceilings remain, and they are exactly what an external "codebase memory" MCP
server claims to break through:

1. **Answers are file-level.** Edges are file→file (`GraphEdge`, `types.ts:216`).
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

`loadGrammar(languageId)` (`src/lang/runtime.ts:185`) is lazy, memoized, request-
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

`GRAPH_SCHEMA_VERSION` (`types.ts:25`) bumps to `'1.2.0'`. Every new query
self-gates with `isSchemaVersionAtLeast(graph.schema_version, '1.2.0')` and returns
`{ schemaSupported: false, note: 'rebuild with repo_map action="build"' }` on older
graphs (the `getDeadExports` pattern, `query.ts:257`).

### `context_pack` query (`src/tools/repo-graph/query.ts`)

`getContextPack(graph, file, symbol, { maxDepth, maxTokens })`:
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

### Tool wiring (`src/tools/repo-map.ts`) — all five surfaces

Per the `callers`/`dead_exports` precedent, a new action is incomplete until it
touches **every** one of these (no unwired code):

1. `VALID_ACTIONS` array (`repo-map.ts:49`).
2. The duplicated zod `action` enum + its `.describe()` (`repo-map.ts:163`).
3. The tool `description` action catalog (`repo-map.ts:150`).
4. The args schema — add `max_depth`/budget handling to `RepoMapArgs` if needed
   (`repo-map.ts:68`,`162`).
5. The dispatch branch in `execute` (file+symbol required → after the `!a.file`
   guard, reusing `validateFile`/`validateSymbol`/`toRelativeGraphPath`).
   `getContextPack` must be imported and **re-exported through the barrel**
   `src/tools/repo-graph.ts` or `repo-map.ts` cannot reach it.

## The sync/async + #1144 parity decision

`loadGrammar` is async; the sync `buildWorkspaceGraph` (`builder.ts:1216`) cannot
await it. Investigation shows the production build hook already defaults to
`buildWorkspaceGraphAsync` (`src/hooks/repo-graph-builder.ts:110`), and
`loadGraphSync` only **reads** persisted JSON (`src/hooks/repo-graph-injection.ts:59`).

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

- Class/interface/enum/record declarations and constructors are extracted as
  defs; a nested (non-top-level) type declaration is visibility-classified
  rather than defaulting to private.
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
| java, kotlin, csharp | every extracted def, including non-exported members |
| all others | exported defs only (unchanged) |

The widening exists so `context_pack` can return a real span for a Java method
instead of the `internal symbol — span unavailable` placeholder. It is gated on
the grammar id, so no other language's payload changes.

Duplicate names inside the widened grammars resolve in three cases, chosen so
`exportRanges` can never disagree with the exported-only `exportLines`:

1. an exported def outranks a non-exported one;
2. two exported defs (a C# partial class) take the **last**, matching `exportLines`;
3. two non-exported defs (a constructor and its class, or overloads) take the
   **first**, and never appear in `exportLines` at all.

A malformed range (non-positive or inverted) is skipped rather than written,
because `validateGraphNode` throws on one and runs inside the scan — a single bad
def must not abort a whole graph build. That guard is scoped to the widened
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

### Known limitation: `packageBoundary` and nested Kotlin block comments

`sourceBoundaryForLanguage` reads the `package` / `namespace` declaration from
comment-stripped source, and masks multi-line string literals so a line-initial
declaration inside a C# verbatim string or a Java/Kotlin text block cannot win.

One gap remains, deliberately not fixed here: `stripComments` does not track
**nested** block comments. Java and C# block comments do not nest (JLS 3.7), so
for those languages the current behavior is correct — the first `*/` really does
close the comment. **Kotlin block comments do nest**, so a declaration inside a
nested comment can still be read as live code. Closing this would require
changing a shared pre-existing helper used by all ontology extraction; the impact
is limited to a grouping/display key, so it is recorded here rather than patched
under this issue.

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
repo_map { "action": "build" }                                  # populates 1.2.0 symbol data (async build)
repo_map { "action": "graph_health" }                           # freshness + extraction diagnostics
repo_map { "action": "callers", "file": "src/foo.ts", "symbol": "doThing" }
repo_map { "action": "context_pack", "file": "src/foo.ts", "symbol": "doThing", "max_depth": 2, "top_n": 40 }
```

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
