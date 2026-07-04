# repo-graph: harden TypeScript and JavaScript symbol extraction

## What changed
- Added `.mjs` and `.cjs` to the language registry so they route through the JavaScript parser.
- Extended tree-sitter TS/JS symbol extraction to report side-effect imports and re-export statements (named/default/`export *`/`export * as`).
- Improved async repo-graph output: re-exports produce graph edges, exported alias ranges, and symbol edges — improving `callers`, `dead_exports`, and `context_pack` accuracy for re-export chains.

## Why
TypeScript/JavaScript is the most common Swarm target language. Re-export tracking (barrel files, `export *`, default re-exports) was incomplete, causing `dead_exports` false positives and inaccurate `context_pack` spans for re-export-heavy codebases.

## Migration steps
None. The change is transparent — existing repo-graph queries return more accurate results for re-export patterns.

## Known caveats
- Star and namespace re-exports (`export *`, `export * as ns`) remain conservative: namespace names appear in `exports` but per-symbol edges to `*` are not synthesized.
- Statement-level type-only re-exports (`export type { Foo } from`) are recognized as type-only (no runtime edges).
