/**
 * Language Detection Utilities
 *
 * Provides detectProjectLanguages() for scanning a project directory
 * and getProfileForFile() for resolving a language profile from a file path.
 * No tool logic — pure detection only.
 */

import { access, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { LANGUAGE_REGISTRY, type LanguageProfile } from './profiles.js';

export const _internals: {
	getProfileForFile: typeof getProfileForFile;
	detectProjectLanguages: typeof detectProjectLanguages;
} = {
	getProfileForFile,
	detectProjectLanguages,
} as const;

/**
 * Resolve a language profile from a file path based on its extension.
 * Returns undefined for files with no extension or unknown extensions.
 */
export function getProfileForFile(
	filePath: string,
): LanguageProfile | undefined {
	const ext = extname(filePath);
	if (!ext) return undefined;
	return LANGUAGE_REGISTRY.getByExtension(ext);
}

/**
 * Scan a project directory (and immediate subdirectories) to detect active languages.
 * Detection is based on presence of build indicator files or source files with known extensions.
 * Returns unique profiles in priority order (Tier 1 first, then Tier 2, then Tier 3).
 * Skips unreadable directories silently.
 */
export async function detectProjectLanguages(
	projectDir: string,
): Promise<LanguageProfile[]> {
	const detected = new Set<string>();

	async function scanDir(dir: string): Promise<void> {
		let entries: string[];
		try {
			const dirEntries = await readdir(dir, { withFileTypes: true });
			entries = dirEntries.map((e) => e.name);
		} catch {
			return;
		}

		// Check build indicator files for each profile
		for (const profile of LANGUAGE_REGISTRY.getAll()) {
			for (const detectFile of profile.build.detectFiles) {
				// Skip glob patterns (contain * or ?)
				if (detectFile.includes('*') || detectFile.includes('?')) continue;
				try {
					await access(join(dir, detectFile));
					detected.add(profile.id);
					break;
				} catch {
					// file not found — continue
				}
			}
		}

		// Check extensions of files in the directory
		for (const entry of entries) {
			const ext = extname(entry);
			if (!ext) continue;
			const profile = LANGUAGE_REGISTRY.getByExtension(ext);
			if (profile) {
				detected.add(profile.id);
			}
		}
	}

	// Scan root directory
	await scanDir(projectDir);

	// Scan immediate subdirectories (one level deep for monorepo support)
	try {
		const topEntries = await readdir(projectDir, { withFileTypes: true });
		for (const entry of topEntries) {
			if (
				entry.isDirectory() &&
				!entry.name.startsWith('.') &&
				entry.name !== 'node_modules'
			) {
				await scanDir(join(projectDir, entry.name));
			}
		}
	} catch {
		// ignore
	}

	// Collect profiles sorted by tier (Tier 1 first)
	const result: LanguageProfile[] = [];
	for (const id of detected) {
		const profile = LANGUAGE_REGISTRY.getById(id);
		if (profile) result.push(profile);
	}
	result.sort((a, b) => a.tier - b.tier);
	return result;
}
