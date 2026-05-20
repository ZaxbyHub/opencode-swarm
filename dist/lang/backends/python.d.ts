/**
 * Python backend.
 *
 * Phase 5 of language-agnostic plugin work. Overrides `extractImports`
 * with Python-specific import regexes (`import x`, `from x import y`)
 * so the test-impact analyzer can build a graph for Python projects.
 * Other hooks (selectTestFramework, selectBuildCommand, parseTestOutput,
 * testFilesFor) inherit the registry-driven defaults.
 *
 * Invariants (same as typescript.ts):
 *   - No subprocess calls; defers binary checks to `isCommandAvailable`.
 *   - No `bun:` imports, no `Bun.*` calls.
 *   - Backend-purity test in `tests/unit/lang/backend-purity.test.ts`
 *     enforces both at PR time.
 */
import type { LanguageBackend } from '../backend';
declare function extractImports(_sourceFile: string, source: string): string[];
/**
 * Build the Python backend from the registered profile.
 */
export declare function buildPythonBackend(): LanguageBackend;
export declare const _internals: {
    extractImports: typeof extractImports;
};
export {};
