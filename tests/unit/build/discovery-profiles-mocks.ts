/**
 * Shared mock scaffolding for the `discovery-profiles*` build tests.
 *
 * NOTE ON WHAT DELIBERATELY STAYS IN THE TEST FILES: the `mock.module(...)`
 * calls themselves are NOT hoisted here. `scripts/check-mock-cleanup.sh` and
 * `scripts/generate-mock-allowlist.sh` both discover mocks with
 * `grep -r --include="*.test.ts"`, so moving the literal `mock.module` targets
 * into this helper would hide `src/lang/detector` and `src/lang/profiles`
 * (`scripts/mock-allowlist.txt:93-94`) from those gates. Only the inert pieces
 * — the fixture type and the registry derivation — live here.
 */

/** Shape of the fixture profiles these tests feed through the registry mock. */
export interface MockLanguageProfile {
	id: string;
	displayName: string;
	tier: number;
	extensions: string[];
	treeSitter: { grammarId: string; wasmFile: string };
	build: {
		detectFiles: string[];
		commands: Array<{
			name: string;
			cmd: string;
			detectFile?: string;
			priority: number;
		}>;
	};
	test: { detectFiles: string[]; frameworks: unknown[] };
	lint: { detectFiles: string[]; linters: unknown[] };
	audit: {
		detectFiles: string[];
		command: string | null;
		outputFormat: 'json' | 'text';
	};
	sast: { nativeRuleSet: string | null; semgrepSupport: string };
	prompts: { coderConstraints: string[]; reviewerChecklist: string[] };
}

/**
 * Derive a `LANGUAGE_REGISTRY` stand-in that overrides only `get`.
 *
 * AGENTS.md invariant 7: `mock.module` leaks across test files in Bun's shared
 * test-runner process, so a mock must preserve the real module's surface and
 * override only what it needs. A partial registry mock previously broke *any*
 * other file in `tests/unit/build/` that transitively imported `src/index.ts`
 * (`LANGUAGE_REGISTRY.getAll is not a function`, thrown at module scope in
 * `src/tools/repo-graph/builder.ts`).
 *
 * `LANGUAGE_REGISTRY` is a class instance, so its methods live on
 * `LanguageRegistry.prototype` and a plain `{ ...real }` spread would silently
 * drop every one of them. `Object.create` keeps the whole real object — methods
 * and private Maps alike — reachable behind the override, and the own-property
 * `get` never mutates the real singleton.
 *
 * CAVEAT for future tests: do not call the registry's mutators (`register`,
 * `unregister`) through the returned object. They are inherited from the real
 * singleton, and `this.profiles` resolves up the prototype chain to the REAL
 * singleton's Map — mutating it would reintroduce exactly the cross-file
 * pollution this helper exists to prevent.
 */
export function deriveMockedRegistry<
	R extends { get: (id: string) => unknown },
>(realRegistry: R, mockGet: (...args: Parameters<R['get']>) => unknown): R {
	const derived = Object.create(realRegistry) as R;
	derived.get = ((...args: Parameters<R['get']>) =>
		mockGet(...args)) as R['get'];
	return derived;
}
