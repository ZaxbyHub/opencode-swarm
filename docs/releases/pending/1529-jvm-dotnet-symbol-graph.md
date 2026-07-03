# Issue #1529: JVM (Java, Kotlin) and .NET (C#) symbol graph support

## What changed

Adds regex-based symbol extractors for Java, Kotlin, and C# to `src/tools/symbols.ts`, matching the existing Go/Rust pattern. Also adds JVM/.NET import parsing to `src/graph/import-extractor.ts` and fixes a Rust grouped-import correctness bug.

### Java, Kotlin, and C# symbol extraction

- `src/tools/symbols.ts` adds `extractJavaSymbols`, `extractKotlinSymbols`, and `extractCSharpSymbols`.
- **Java**: classes, interfaces, enums, records (Java 14+), with visibility (public/protected/package-private/private). Unmarked declarations default to package-private.
- **Kotlin**: top-level functions, classes, objects, companion objects, data classes, with visibility (public/internal/private/protected) and extension functions. Unmarked declarations default to `internal`.
- **C#**: classes, interfaces, structs, records, generic methods, with visibility (public/internal/private/protected) and constructors. Unmarked declarations default to `internal`.
- JVM/.NET string and char literals are skipped during brace matching, so class fields containing `{` or `}` characters no longer silently truncate method extraction.

### JVM/.NET import edges

- `src/graph/import-extractor.ts` adds `parseJavaImports` (with static imports), `parseKotlinImports` (with aliased imports), and `parseCSharpUsings` (with using aliases and static usings).
- Dotted module specifiers such as `com.example.Foo` resolve to workspace files under standard roots (`src/main/java`, `src/main/kotlin`, `src/`) via `tryResolveDottedModule` with symlink-safe `realpath`-based boundary checks.

### repo_map and context_pack

- `repo_map ontology` now reports `packageBoundary` from Java `package` and C# `namespace` declarations via `sourceBoundaryForLanguage`.
- `repo_map context_pack` returns multiple spans for overloaded methods (e.g., `run#1`, `run#2`) — `exportRangesForSymbol` expands `name#N` keys in query responses.
- Legacy repo graph builder (`scanFile`, `buildWorkspaceGraph`, `scanFileAsync`) refactored to use the unified `extractSymbolsForFile` dispatcher.

### Bug fix: Rust grouped import symbol resolution (F-012)

Rust grouped imports `use crate::{Item as Alias, ...}` previously emitted the alias name in `importedSymbols`; they now emit the underlying symbol name (`Item`). This is a correctness fix — consumers of Rust grouped import edges should expect symbol names, not aliases.

### Performance

`braceDepthBefore` (O(B×M) per class body) was replaced with a single-pass prefix depth array (O(B+M)). A 1 MB Java-style file with 5000 methods extracts in ~3 ms (was ~1.2 s) — a ~400× speedup. `findMatchingBrace` was made string- and char-literal-aware.

### Reverted: Python method export from parent class (F-003)

The `pythonParentClassExported` logic that was removed in this PR has been restored. Python methods on exported classes are again marked `exported: true` (unless `_`-prefixed or `__init__`). This restores the prior behavior on the base branch.
