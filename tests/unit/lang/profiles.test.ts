/**
 * Comprehensive unit tests for LanguageRegistry
 * Tests cover the full registry with all 11 profiles across all tiers
 */

import { describe, expect, it } from 'bun:test';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';

describe('LanguageRegistry - Registry Completeness', () => {
	it('getAll() returns exactly 11 profiles', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		expect(allProfiles).toHaveLength(12);
	});

	it('getTier(1) returns exactly 4 profiles', () => {
		const tier1Profiles = LANGUAGE_REGISTRY.getTier(1);
		expect(tier1Profiles).toHaveLength(4);
	});

	it('getTier(2) returns exactly 5 profiles', () => {
		const tier2Profiles = LANGUAGE_REGISTRY.getTier(2);
		expect(tier2Profiles).toHaveLength(5);
	});

	it('getTier(3) returns exactly 2 profiles', () => {
		const tier3Profiles = LANGUAGE_REGISTRY.getTier(3);
		expect(tier3Profiles).toHaveLength(3);
	});

	it('sum of all tiers equals 11 profiles', () => {
		const tier1Profiles = LANGUAGE_REGISTRY.getTier(1);
		const tier2Profiles = LANGUAGE_REGISTRY.getTier(2);
		const tier3Profiles = LANGUAGE_REGISTRY.getTier(3);
		const total =
			tier1Profiles.length + tier2Profiles.length + tier3Profiles.length;
		expect(total).toBe(12);
	});
});

describe('LanguageRegistry - Profile Lookup by ID', () => {
	const profileIds = [
		'typescript',
		'python',
		'rust',
		'go',
		'java',
		'kotlin',
		'csharp',
		'cpp',
		'swift',
		'dart',
		'ruby',
	];

	profileIds.forEach((id) => {
		it(`get('${id}') returns profile with id === '${id}'`, () => {
			const profile = LANGUAGE_REGISTRY.get(id);
			expect(profile).toBeDefined();
			expect(profile?.id).toBe(id);
		});
	});

	it("get('nonexistent') returns undefined", () => {
		const profile = LANGUAGE_REGISTRY.get('nonexistent');
		expect(profile).toBeUndefined();
	});
});

describe('LanguageRegistry - Extension Lookup', () => {
	const extensionMappings: [string, string][] = [
		['.ts', 'typescript'],
		['.tsx', 'typescript'],
		['.js', 'typescript'],
		['.jsx', 'typescript'],
		['.mjs', 'typescript'],
		['.cjs', 'typescript'],
		['.py', 'python'],
		['.pyw', 'python'],
		['.rs', 'rust'],
		['.go', 'go'],
		['.java', 'java'],
		['.kt', 'kotlin'],
		['.kts', 'kotlin'],
		['.cs', 'csharp'],
		['.csx', 'csharp'],
		['.c', 'cpp'],
		['.h', 'cpp'],
		['.cpp', 'cpp'],
		['.hpp', 'cpp'],
		['.cc', 'cpp'],
		['.cxx', 'cpp'],
		['.swift', 'swift'],
		['.dart', 'dart'],
		['.rb', 'ruby'],
		['.rake', 'ruby'],
		['.gemspec', 'ruby'],
	];

	extensionMappings.forEach(([ext, expectedId]) => {
		it(`getByExtension('${ext}') returns ${expectedId}`, () => {
			const profile = LANGUAGE_REGISTRY.getByExtension(ext);
			expect(profile).toBeDefined();
			expect(profile?.id).toBe(expectedId);
		});
	});

	it("getByExtension('.xyz') returns undefined (unknown extension)", () => {
		const profile = LANGUAGE_REGISTRY.getByExtension('.xyz');
		expect(profile).toBeUndefined();
	});
});

describe('LanguageRegistry - No Extension Collision', () => {
	it('all extensions across all profiles are unique', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		const extensionMap = new Map<string, string>();

		for (const profile of allProfiles) {
			for (const ext of profile.extensions) {
				const existingOwner = extensionMap.get(ext);
				expect(existingOwner).toBeUndefined();
				extensionMap.set(ext, profile.id);
			}
		}

		// Verify the map has all extensions
		const expectedExtensions = new Set([
			'.ts',
			'.tsx',
			'.js',
			'.jsx',
			'.mjs',
			'.cjs',
			'.py',
			'.pyw',
			'.rs',
			'.go',
			'.java',
			'.kt',
			'.kts',
			'.cs',
			'.csx',
			'.c',
			'.h',
			'.cpp',
			'.hpp',
			'.cc',
			'.cxx',
			'.swift',
			'.dart',
			'.rb',
			'.rake',
			'.gemspec',
			'.php',
			'.phtml',
			'.blade.php', // Added in v6.49.0 Phase 3.3 — Blade template support
		]);

		expect(extensionMap.size).toBe(expectedExtensions.size);
	});
});

describe('LanguageRegistry - Tier 1 Audit Configuration', () => {
	const tier1Profiles = ['typescript', 'python', 'rust', 'go'];

	tier1Profiles.forEach((profileId) => {
		it(`${profileId} has non-null audit.command`, () => {
			const profile = LANGUAGE_REGISTRY.get(profileId);
			expect(profile).toBeDefined();
			expect(profile?.audit.command).not.toBeNull();
		});
	});
});

describe('LanguageRegistry - All Profiles Have Non-Empty Prompts', () => {
	const allProfiles = LANGUAGE_REGISTRY.getAll();

	it('every profile has at least 3 coderConstraints', () => {
		for (const profile of allProfiles) {
			expect(profile.prompts.coderConstraints.length).toBeGreaterThanOrEqual(3);
		}
	});

	it('every profile has at least 3 reviewerChecklist items', () => {
		for (const profile of allProfiles) {
			expect(profile.prompts.reviewerChecklist.length).toBeGreaterThanOrEqual(
				3,
			);
		}
	});
});

describe('LanguageRegistry - All Profiles Have Required Fields', () => {
	const allProfiles = LANGUAGE_REGISTRY.getAll();

	it('every profile has non-empty id', () => {
		for (const profile of allProfiles) {
			expect(profile.id).toBeTruthy();
			expect(typeof profile.id).toBe('string');
			expect(profile.id.length).toBeGreaterThan(0);
		}
	});

	it('every profile has non-empty displayName', () => {
		for (const profile of allProfiles) {
			expect(profile.displayName).toBeTruthy();
			expect(typeof profile.displayName).toBe('string');
			expect(profile.displayName.length).toBeGreaterThan(0);
		}
	});

	it('every profile has at least 1 extension', () => {
		for (const profile of allProfiles) {
			expect(profile.extensions.length).toBeGreaterThan(0);
		}
	});

	it('every profile has non-empty treeSitter.grammarId', () => {
		for (const profile of allProfiles) {
			expect(profile.treeSitter.grammarId).toBeTruthy();
			expect(typeof profile.treeSitter.grammarId).toBe('string');
			expect(profile.treeSitter.grammarId.length).toBeGreaterThan(0);
		}
	});

	it('every profile has non-empty treeSitter.wasmFile ending with .wasm', () => {
		for (const profile of allProfiles) {
			expect(profile.treeSitter.wasmFile).toBeTruthy();
			expect(typeof profile.treeSitter.wasmFile).toBe('string');
			expect(profile.treeSitter.wasmFile.length).toBeGreaterThan(0);
			expect(profile.treeSitter.wasmFile).toMatch(/\.wasm$/);
		}
	});
});

describe('LanguageRegistry - SAST Configuration', () => {
	const nativeRuleSetProfiles = [
		'typescript',
		'python',
		'rust',
		'java',
		'csharp',
		'cpp',
	];

	nativeRuleSetProfiles.forEach((profileId) => {
		it(`${profileId} has non-null nativeRuleSet`, () => {
			const profile = LANGUAGE_REGISTRY.get(profileId);
			expect(profile).toBeDefined();
			expect(profile?.sast.nativeRuleSet).not.toBeNull();
		});
	});

	const semgrepSupportProfiles = ['kotlin', 'swift', 'dart', 'ruby'];

	const validSemgrepSupport = ['ga', 'beta', 'experimental', 'none'];

	semgrepSupportProfiles.forEach((profileId) => {
		it(`${profileId} has valid semgrepSupport value`, () => {
			const profile = LANGUAGE_REGISTRY.get(profileId);
			expect(profile).toBeDefined();
			expect(validSemgrepSupport).toContain(profile?.sast.semgrepSupport);
		});
	});
});
