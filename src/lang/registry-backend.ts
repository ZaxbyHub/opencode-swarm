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
import { defaultBackendFor } from './default-backend';
import { LANGUAGE_REGISTRY, type LanguageProfile } from './profiles';

class LanguageBackendRegistry {
	private backends: Map<string, LanguageBackend> = new Map();

	register(backend: LanguageBackend): void {
		const existing = this.backends.get(backend.id);
		if (existing && existing !== backend) {
			throw new Error(
				`LanguageBackendRegistry: backend id "${backend.id}" registered twice. ` +
					`Each LanguageBackend.id must be unique.`,
			);
		}
		this.backends.set(backend.id, backend);
	}

	/**
	 * Get a registered backend by id, or `undefined` if no backend is
	 * registered. Callers usually want `getOrDefault` instead.
	 */
	get(id: string): LanguageBackend | undefined {
		return this.backends.get(id);
	}

	/**
	 * Get the registered backend for `id`, or synthesize a default backend
	 * by wrapping the matching `LanguageProfile`. Returns `undefined` only
	 * when no profile exists for the id (i.e. unknown language).
	 */
	getOrDefault(id: string): LanguageBackend | undefined {
		const registered = this.backends.get(id);
		if (registered) return registered;
		const profile: LanguageProfile | undefined = LANGUAGE_REGISTRY.get(id);
		if (!profile) return undefined;
		return defaultBackendFor(profile);
	}

	/**
	 * Test-only: remove a registered backend. Mirrors
	 * `LANGUAGE_REGISTRY.unregister` for the same singleton-pollution
	 * rationale (see comment there).
	 */
	unregister(id: string): void {
		this.backends.delete(id);
	}
}

export const LANGUAGE_BACKEND_REGISTRY = new LanguageBackendRegistry();
