/**
 * Go backend.
 *
 * Phase 5 of language-agnostic plugin work. Overrides `extractImports`
 * with Go-specific import regexes — both single-line `import "x"` and
 * grouped `import (\n "a"\n "b"\n)` forms — so the test-impact analyzer
 * can build a graph for Go projects.
 *
 * Invariants identical to other backends — see `python.ts` and
 * `typescript.ts` for the rationale; backend-purity test enforces.
 */
import type { LanguageBackend } from '../backend';
declare function extractImports(_sourceFile: string, source: string): string[];
/**
 * Build the Go backend from the registered profile.
 */
export declare function buildGoBackend(): LanguageBackend;
export declare const _internals: {
    extractImports: typeof extractImports;
};
export {};
