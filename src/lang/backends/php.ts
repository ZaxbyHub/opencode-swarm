/**
 * PHP backend.
 *
 * Wires the previously-unused Laravel framework detection (DD-C009) into the
 * dispatch layer. Overrides `selectFramework` so a Laravel project surfaces
 * `PROJECT_FRAMEWORK = laravel` in the architect prompt (consumed by
 * `src/agents/project-context.ts`), and exposes the command overlay so the
 * project-context builder can prefer `php artisan test` over the generic
 * PHPUnit/Pest default for Laravel apps.
 *
 * Invariants identical to the other backends — see `go.ts` / `python.ts` for
 * the rationale. `detectLaravelProject` / `getLaravelCommandOverlay` are
 * filesystem-only (no subprocess), so they are safe on the session-init path.
 */

import type { FrameworkSelection, LanguageBackend } from '../backend';
import { defaultBackendFor } from '../default-backend';
import { detectLaravelProject } from '../framework-detector';
import { LANGUAGE_REGISTRY } from '../profiles';

const PROFILE_ID = 'php';

/**
 * Detect Laravel via the multi-signal heuristic (artisan + composer.json
 * require + config/app.php; ≥2 of 3). Returns null for generic Composer PHP
 * projects so the architect's PROJECT_FRAMEWORK stays unresolved.
 */
async function selectFramework(
	dir: string,
): Promise<FrameworkSelection | null> {
	if (detectLaravelProject(dir)) {
		return {
			name: 'laravel',
			detectedVia: 'Laravel signals (artisan / composer.json / config/app.php)',
		};
	}
	return null;
}

/**
 * Build the PHP backend from the registered profile.
 */
export function buildPhpBackend(): LanguageBackend {
	const profile = LANGUAGE_REGISTRY.get(PROFILE_ID);
	if (!profile) {
		throw new Error(
			'buildPhpBackend: php profile not in LANGUAGE_REGISTRY. ' +
				'profiles.ts must be imported before this backend.',
		);
	}
	return {
		...defaultBackendFor(profile),
		selectFramework,
	};
}
