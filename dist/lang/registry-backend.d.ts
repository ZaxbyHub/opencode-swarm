/**
 * Backend registry — maps language id → concrete `LanguageBackend`. Sits
 * alongside `LANGUAGE_REGISTRY` (the data registry) and `languageDefinitions`
 * (the parser registry). When a backend is not registered for a language id,
 * the default backend (registry-driven defaults) is synthesized on demand.
 *
 * Adding a new language with first-class behavior is a single new file
 * under `src/lang/backends/<id>.ts` plus one import line in
 * `src/lang/backends/index.ts`. The new file calls
 * `LANGUAGE_BACKEND_REGISTRY.register(myBackend)` at module load.
 */
import type { LanguageBackend } from './backend';
declare class LanguageBackendRegistry {
    private backends;
    register(backend: LanguageBackend): void;
    /**
     * Get a registered backend by id, or `undefined` if no backend is
     * registered. Callers usually want `getOrDefault` instead.
     */
    get(id: string): LanguageBackend | undefined;
    /**
     * Get the registered backend for `id`, or synthesize a default backend
     * by wrapping the matching `LanguageProfile`. Returns `undefined` only
     * when no profile exists for the id (i.e. unknown language).
     */
    getOrDefault(id: string): LanguageBackend | undefined;
    /**
     * Test-only: remove a registered backend. Mirrors
     * `LANGUAGE_REGISTRY.unregister` for the same singleton-pollution
     * rationale (see comment there).
     */
    unregister(id: string): void;
}
export declare const LANGUAGE_BACKEND_REGISTRY: LanguageBackendRegistry;
export {};
