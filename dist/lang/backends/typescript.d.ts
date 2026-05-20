/**
 * TypeScript / JavaScript backend.
 *
 * Overrides the default backend's `selectTestFramework` to honor
 * `package.json#scripts.test` (the canonical signal in the JS ecosystem)
 * and `extractImports` to parse ES6 + CommonJS imports for the
 * graph/impact analyzer.
 *
 * Phase 2 deliverable: this backend exists and registers itself, but
 * `src/tools/test-runner.ts` and `src/test-impact/analyzer.ts` do not yet
 * call into it — they still use their existing switch-statement helpers.
 * Phase 3 wires the test-runner dispatch through this backend.
 *
 * Invariants:
 *   - No subprocess calls (defers to `isCommandAvailable` from
 *     `../../build/discovery` for binary checks; that helper already
 *     satisfies invariant 3).
 *   - No `bun:` imports, no `Bun.*` calls (invariant 2).
 *   - No mutation of LANGUAGE_REGISTRY at import time — only registers a
 *     backend in LANGUAGE_BACKEND_REGISTRY via `backends/index.ts`.
 */
import type { LanguageBackend } from '../backend';
interface PackageJsonShape {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}
/**
 * Read package.json. Returns null when missing or malformed. Bounded by a
 * single sync `fs.readFileSync` — no subprocess.
 *
 * Routed through `_internals.readPackageJsonRaw` so tests can substitute a
 * different reader without touching the filesystem. The adversarial review
 * (PR #825) flagged that this seam was advertised but unused.
 */
declare function readPackageJsonRaw(dir: string): PackageJsonShape | null;
/** Convenience: read just `scripts.test` (used by tests). */
declare function readPackageJsonTestScript(dir: string): string | null;
/**
 * Map a `package.json#scripts.test` invocation to a framework name. The
 * mapping mirrors `detectTestFramework` in `src/tools/test-runner.ts:286–326`.
 */
declare function frameworkFromScriptsTest(script: string): string | null;
/**
 * Build the TypeScript backend from the registered profile. Backend
 * registration happens in `./index.ts` (the single import-and-register
 * surface) — this module just exports the factory so the registration
 * site is explicit.
 */
export declare function buildTypescriptBackend(): LanguageBackend;
export declare const _internals: {
    readPackageJsonRaw: typeof readPackageJsonRaw;
    readPackageJsonTestScript: typeof readPackageJsonTestScript;
    frameworkFromScriptsTest: typeof frameworkFromScriptsTest;
};
export {};
