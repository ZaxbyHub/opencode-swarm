# Harden C/C++ and Swift Symbol Graph Support

## What

Hardens `src/lang/symbol-graph.ts` / `src/lang/symbol-visibility.ts` /
`src/tools/repo-graph/builder.ts` extraction for C/C++ (`.c`, `.h`, `.cpp`,
`.hpp`, `.cc`, `.cxx`) and Swift (`.swift`), which previously carried only a
thin baseline query set (issue #1530, KG-09):

- **Header-declared public symbols are represented.** C/C++ prototypes
  (`int add(int, int);`, including pointer-return forms like `char *concat()`)
  now produce exported function defs — a `.h` file previously yielded zero
  defs.
- **C/C++ include edges are represented.** Quoted includes (`#include
  "util.h"`) normalize to `./`-relative default imports that resolve to real
  file edges; angle includes (`#include <vector>`) stay external/unresolved
  namespace imports.
- **C++ class members, constructors, enums, and typedefs are extracted.**
  Method declarations/definitions inside class/struct/union bodies
  (`field_identifier` declarators), in-class constructors, out-of-class
  qualified definitions (`void engine::run()`), `enum`, and `typedef` are all
  captured; members are re-typed to `method` like the JVM/.NET languages.
- **C++ internals are conservative.** `static` file-scope functions and
  anything inside an anonymous `namespace { … }` block are marked
  not-exported; class/struct members default by container kind (class →
  private, struct/union → public) and are never file-level exports. Access
  specifier sections (`public:`) are not tracked (documented limitation).
- **Swift struct/enum/extension/typealias and protocol members are
  represented.** Extension blocks produce a `type` def for the extended type
  and their members are attributed as `method`; protocol requirements are
  extracted.
- **Swift visibility is correct in full.** `open`/`public` map to public,
  `internal` to internal, `fileprivate`/`private` to private; members without
  a modifier now default to Swift's implicit `internal` (previously forced to
  `public`); multi-line attributes (`@available(iOS 14, *)` on the line above
  a `public func`) no longer hide the modifier.
- **Swift imports split module vs symbol.** `import class Foo.Bar` yields
  specifier `Foo` with a named `Bar` binding (all kind keywords supported);
  attribute-prefixed imports (`@_testable import MyApp`) are no longer
  dropped.
- **`context_pack` serves C/C++ and Swift member spans.** `exportRanges` is
  widened to all defs for cpp/swift (mirroring the Java/Kotlin/C# widening),
  so internal and private symbols get real spans instead of the
  "span unavailable" placeholder.

## Why

A merged-but-discarded prior attempt never landed on current main, and the
remaining baseline missed explicit acceptance criteria of the graph-memory
roadmap: headers produced no symbols at all, Swift members were mis-typed and
mis-defaulted, and native-language imports carried no resolvable semantics.

## How to use

Rebuild the repo graph (`repo_map` action `build`) and query
`repo_map` action `context_pack` with a native-language `file`/`symbol`. See
`docs/repo-graph-symbol-graph.md` → "Native language limitations" for the
conservative-by-design caveats (quoted-only include resolution, overload
collapse, macro blindness, template best-effort, Swift module resolution).

## Migration

No migration required. Graph payloads gain `exportRanges` entries for
non-exported cpp/swift defs; schema is unchanged.
