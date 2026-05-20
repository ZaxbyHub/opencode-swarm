/**
 * Backend registration surface.
 *
 * Adding a new language with first-class behavior is a single new file
 * under this directory plus one `import` line + one `register(...)` call
 * here. Importing this module triggers all registrations.
 *
 * Phase 2 ships only the TypeScript backend. Phase 5 will add Python and
 * Go backends with import-graph extractors.
 */
/**
 * Register all known backends. Idempotent via the module-level `registered`
 * flag.
 *
 * The flag is load-bearing, not redundant with the registry's own duplicate
 * guard: `buildTypescriptBackend()` constructs a fresh object every call, so
 * a second call without the flag would produce a different reference and
 * trip `LanguageBackendRegistry.register`'s `existing !== backend` throw.
 * The flag prevents that by short-circuiting before constructing.
 */
export declare function registerAllBackends(): void;
/**
 * Test-only: reset the registration flag and unregister all known
 * backends. Allows tests to verify the registration logic itself without
 * cross-file singleton pollution.
 */
export declare function _resetForTesting(): void;
