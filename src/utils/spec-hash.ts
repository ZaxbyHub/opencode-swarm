import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../config/plan-schema';

/**
 * Computes SHA-256 hex hash of `.swarm/spec.md` content in the given directory.
 * Returns null if the file does not exist (does NOT throw).
 */
export async function computeSpecHash(
	directory: string,
): Promise<string | null> {
	const specPath = join(directory, '.swarm', 'spec.md');
	let hash: string | null = null;
	try {
		const content = await readFile(specPath, 'utf-8');
		hash = createHash('sha256').update(content, 'utf-8').digest('hex');
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error; // Re-throw unexpected errors; ENOENT means file missing -> hash stays null
		}
	}
	return hash;
}

/**
 * Determines if the spec file has changed since the plan was saved.
 * Plans created before this feature (no specHash) are exempt from staleness checks.
 */
export async function isSpecStale(
	directory: string,
	plan: Plan,
): Promise<{ stale: boolean; reason?: string; currentHash?: string | null }> {
	const currentHash = await _internals.computeSpecHash(directory);

	// Pre-feature plan: no specHash means plan predates this feature
	if (!plan.specHash) {
		return { stale: false };
	}

	// Spec was deleted after plan was created
	if (currentHash === null) {
		return {
			stale: true,
			reason: 'spec.md has been deleted',
			currentHash: null,
		};
	}

	// Spec was modified since plan was saved
	if (currentHash !== plan.specHash) {
		return {
			stale: true,
			reason: 'spec.md has been modified since plan was saved',
			currentHash,
		};
	}

	return { stale: false };
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	computeSpecHash: typeof computeSpecHash;
	isSpecStale: typeof isSpecStale;
} = {
	computeSpecHash,
	isSpecStale,
} as const;
