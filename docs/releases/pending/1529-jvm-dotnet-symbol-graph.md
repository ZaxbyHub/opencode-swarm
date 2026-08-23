# Harden Java, Kotlin, and C# Symbol Graph Support

## What

Hardens `src/lang/symbol-graph.ts` / `src/lang/symbol-visibility.ts` /
`src/tools/repo-graph/` extraction for Java, Kotlin, and C# (`.java`, `.kt`,
`.kts`, `.cs`, `.csx`), which previously carried only a thin, largely
non-functional baseline query set:

- **Member methods are typed `method`, not `function`.** Methods declared
  inside a class/interface/struct/object/enum/record container are now typed
  consistently with the existing Python/Rust convention.
- **Container-kind-aware member visibility.** Member visibility is derived
  from explicit modifiers first; when no modifier is present, the default now
  depends on the enclosing container kind and language (e.g. Java members
  default to package-private, Kotlin members default to public, C# members
  default to private inside a type body and internal at file scope), instead
  of the previous blanket fallback that reported everything as public.
- **Nested type declarations are no longer forced to private.** A non-top-level
  class/interface/enum/record/struct/object declaration now takes
  modifier-derived visibility with the same container-aware defaulting as
  members, rather than unconditionally falling through to a private default.
- **Annotation-aware modifier scanning.** Leading `@Annotation`/`@Annotation(...)`
  (Java/Kotlin) and `[Attribute]`/`[Attribute(...)]` (C#) lines no longer
  interfere with visibility-modifier detection on the declaration that follows.
- **Kotlin's default visibility is corrected to public**, matching the
  language's actual default (previously reported as `internal`).
- **Enum, record, and constructor declarations are now extracted** for Java
  and C# (`enum_declaration`, `record_declaration`, `constructor_declaration`),
  closing a gap where these declaration kinds were silently invisible to the
  graph. Kotlin `enum class` and extension functions were verified already
  working and are unchanged — an extension function is extracted under its
  bare name (`shout`), and the receiver type is not recorded. Qualifying the
  name was tried and reverted: import bindings are always a bare final
  segment, so a qualified key could never be matched by an import.
- **Package/namespace metadata is read from source**: Java/Kotlin `package`
  declarations and C# `namespace` declarations (both the block form and the
  C# file-scoped `namespace N;` form) now populate the graph's
  package/namespace boundary, instead of being derived purely from file path.
- **Import/using bindings are populated**, so Java `import`/static-import,
  Kotlin `import` (with aliases), and C# `using` (with aliases) directives
  carry real imported/local symbol bindings. This lets `repo_map`'s existing
  file-level import edges and best-effort symbol edges form for these
  languages the same way they already do for TypeScript/JavaScript/Python.
- **Dotted-module import resolution** for Java/Kotlin/C# is wired into the
  existing conventional-source-root resolution path, producing file-level
  import edges (and symbol edges, where a binding matches a reference) instead
  of silently dropping every JVM/.NET import.
- **`global using` (C# 10+) is now recognised.** The symbol-graph C# import
  parser previously matched only a bare `using`, so every entry in a .NET 6+
  `GlobalUsings.cs` was silently dropped.
- **`.csx` registry consistency fix**: `src/lang/registry.ts` now lists `.csx`
  alongside `.cs`, matching the C# profile's declared extensions. Scope note:
  `.csx` files were already walked and dispatched to the C# grammar via
  `LANGUAGE_REGISTRY`, so this corrects `getParserForFile` / `isSupportedFile`
  only — it does not unblock graph extraction, which already worked.

### Also fixed — found by the recurrence sweep, beyond the reported issue

The Phase 4.2 sweep for this defect class ("a language is registered but one of
the downstream extraction sites was never specialised for it, and nothing fails
loudly") surfaced four further live instances. All are fixed here rather than
deferred:

- **JavaScript class members were never surfaced as defs.** The `javascript`
  defs query omitted `method_definition` while `typescript`/`tsx` carried it,
  so methods in plain `.js`/`.jsx`/`.mjs`/`.cjs` files produced no symbol at
  all. Now at parity with TypeScript.
- **`.pyw` (Python) and `.rake` / `.gemspec` (Ruby)** were declared by their
  language profiles but missing from `src/lang/registry.ts`, so
  `getParserForFile` / `isSupportedFile` rejected files the graph builder
  accepts — the same divergence as the reported `.csx` bug.

  Downstream effect worth knowing: `getParserForFile` has two other production
  consumers, `src/tools/placeholder-scan.ts` and `src/tools/syntax-check.ts`.
  Adding these four extensions means those tools now parse `.csx`, `.pyw`,
  `.rake` and `.gemspec` files they previously skipped, so `syntax_check` can
  report diagnostics on files it used to ignore.

Two new guardrails close the class rather than just these instances:
`tests/unit/lang/language-extraction-coverage.test.ts` (per-language
member-typing and import-binding expectations, exhaustive over
`LANGUAGE_REGISTRY` by construction — a language with no entry fails the suite)
and `tests/unit/lang/profile-registry-extension-parity.test.ts`
(profile-vs-registry extension parity, checked through the real `extname()`
lookup).

## Why

Issue #1529 tracked hardening JVM/.NET symbol-graph support. A prior PR
(#1679) implemented this work but was merged into a stacked branch that was
never merged up to `main` (over 1,400 commits behind), so `main` still carried only
a thin, non-functional baseline. This change re-implements the hardening
directly against current `main`.

## Non-goals / scope calls

- **No type resolution.** Overload resolution, inheritance, and dynamic/virtual
  dispatch are not resolved — extraction stays name-keyed and syntactic, per
  the issue's explicit non-goals. See the new caveats in
  `docs/repo-graph-symbol-graph.md` (`## Limitations (by design)`).
- **`symbols` / `batch_symbols` tools are out of scope for this change.** They
  do not gain Java/Kotlin/C# support here; only the `repo_map`/repo-graph
  symbol-extraction path is hardened.
- **`context_pack` member spans are scoped to Java/Kotlin/C#.** Graph nodes for
  these three languages now carry `exportRanges` entries for members as well as
  exported types, so `context_pack` returns a real full span for a Java method
  instead of a signature-only placeholder. This closes the issue's
  "class/member ranges" requirement. The file's `exports` list is unchanged —
  a member is still not a file-level export.

  **Which languages change.** The widening is gated on java/kotlin/csharp, so
  TypeScript, Python, Rust, Go and the remaining grammars keep their previous
  exported-only `exportRanges` and are unchanged. **JavaScript payloads DO
  change**, for a separate reason described in the JavaScript bullet above:
  members of an exported JS class are now surfaced as defs and are
  `exported: true`, so they newly appear in `exports`, `exportLines` and
  `exportRanges`.

  **Name collisions** resolve in three cases, chosen so `exportRanges` can
  never disagree with the exported-only `exportLines`: an exported def outranks
  a non-exported one; two exported defs (a C# partial class) take the last,
  matching `exportLines`; two non-exported defs (a constructor and its class,
  or overloads) take the first, so a type's span is never displaced by a
  member's.

## Migration

No breaking changes. All changes are additive/corrective to existing
extraction behavior:

- Graphs built before this change remain loadable; a rebuild (`repo_map
  action="build"`) is needed to pick up corrected Java/Kotlin/C# visibility,
  member typing, and package/namespace/import data.
- No schema version change.

## Documentation

`docs/repo-graph-symbol-graph.md` is updated: `## Language coverage` now
describes the Java/Kotlin/C# extraction behavior above, and
`## Limitations (by design)` documents the overload-resolution,
inheritance/dynamic-dispatch, Kotlin extension-dispatch, C# partial-class, and
generated-code caveats required by the issue's acceptance criterion 7.

Closes: #1529
