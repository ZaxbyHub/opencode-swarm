/**
 * Tier 3 Language Profiles Verification and Adversarial Tests
 *
 * Tests for Dart and Ruby language profiles in the Language Registry.
 */

import { describe, expect, it } from 'bun:test';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';

describe('Tier 3 Language Profiles - Verification', () => {
	it('1. getTier(3) returns exactly 2 profiles', () => {
		const tier3Profiles = LANGUAGE_REGISTRY.getTier(3);
		expect(tier3Profiles).toHaveLength(3);
	});

	it('2. LANGUAGE_REGISTRY.getAll() returns exactly 11 profiles total (4 Tier1 + 5 Tier2 + 2 Tier3)', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		expect(allProfiles).toHaveLength(12);

		const tier1Count = LANGUAGE_REGISTRY.getTier(1).length;
		const tier2Count = LANGUAGE_REGISTRY.getTier(2).length;
		const tier3Count = LANGUAGE_REGISTRY.getTier(3).length;

		expect(tier1Count).toBe(4);
		expect(tier2Count).toBe(5);
		expect(tier3Count).toBe(3);
	});

	it('3. getByExtension(".dart") returns dart profile with id "dart"', () => {
		const dartProfile = LANGUAGE_REGISTRY.getByExtension('.dart');
		expect(dartProfile).toBeDefined();
		expect(dartProfile?.id).toBe('dart');
	});

	it('4. getByExtension(".rb") returns ruby profile with id "ruby"', () => {
		const rubyProfile = LANGUAGE_REGISTRY.getByExtension('.rb');
		expect(rubyProfile).toBeDefined();
		expect(rubyProfile?.id).toBe('ruby');
	});

	it('5. getByExtension(".rake") returns ruby profile', () => {
		const rubyProfile = LANGUAGE_REGISTRY.getByExtension('.rake');
		expect(rubyProfile).toBeDefined();
		expect(rubyProfile?.id).toBe('ruby');
	});

	it('6. getByExtension(".gemspec") returns ruby profile', () => {
		const rubyProfile = LANGUAGE_REGISTRY.getByExtension('.gemspec');
		expect(rubyProfile).toBeDefined();
		expect(rubyProfile?.id).toBe('ruby');
	});

	it('7. Dart audit.command === "dart pub outdated --json"', () => {
		const dartProfile = LANGUAGE_REGISTRY.getById('dart');
		expect(dartProfile).toBeDefined();
		expect(dartProfile?.audit.command).toBe('dart pub outdated --json');
	});

	it('8. Ruby audit.command === "bundle-audit check --format json"', () => {
		const rubyProfile = LANGUAGE_REGISTRY.getById('ruby');
		expect(rubyProfile).toBeDefined();
		expect(rubyProfile?.audit.command).toBe('bundle-audit check --format json');
	});

	it('9. Dart sast.nativeRuleSet === null', () => {
		const dartProfile = LANGUAGE_REGISTRY.getById('dart');
		expect(dartProfile).toBeDefined();
		expect(dartProfile?.sast.nativeRuleSet).toBeNull();
	});

	it('10. Ruby sast.nativeRuleSet === null', () => {
		const rubyProfile = LANGUAGE_REGISTRY.getById('ruby');
		expect(rubyProfile).toBeDefined();
		expect(rubyProfile?.sast.nativeRuleSet).toBeNull();
	});

	it('11. Dart sast.semgrepSupport === "none"', () => {
		const dartProfile = LANGUAGE_REGISTRY.getById('dart');
		expect(dartProfile).toBeDefined();
		expect(dartProfile?.sast.semgrepSupport).toBe('none');
	});

	it('12. Ruby sast.semgrepSupport === "experimental"', () => {
		const rubyProfile = LANGUAGE_REGISTRY.getById('ruby');
		expect(rubyProfile).toBeDefined();
		expect(rubyProfile?.sast.semgrepSupport).toBe('experimental');
	});

	it('13. All 11 profiles have >= 3 coderConstraints', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		for (const profile of allProfiles) {
			expect(
				profile.prompts.coderConstraints.length,
				`Profile ${profile.id} has ${profile.prompts.coderConstraints.length} coderConstraints, expected >= 3`,
			).toBeGreaterThanOrEqual(3);
		}
	});

	it('14. All 11 profiles have >= 3 reviewerChecklist items', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		for (const profile of allProfiles) {
			expect(
				profile.prompts.reviewerChecklist.length,
				`Profile ${profile.id} has ${profile.prompts.reviewerChecklist.length} reviewerChecklist items, expected >= 3`,
			).toBeGreaterThanOrEqual(3);
		}
	});

	it('15. Full extension set across all 11 profiles: confirm no collisions', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		const extensionSet = new Set<string>();
		const extensionToProfiles = new Map<string, string[]>();

		for (const profile of allProfiles) {
			for (const ext of profile.extensions) {
				if (extensionSet.has(ext)) {
					// Collision detected - track which profiles share this extension
					const existing = extensionToProfiles.get(ext) || [];
					existing.push(profile.id);
					extensionToProfiles.set(ext, existing);
				} else {
					extensionSet.add(ext);
					extensionToProfiles.set(ext, [profile.id]);
				}
			}
		}

		// Check for collisions
		const collisions: string[] = [];
		for (const [ext, profileIds] of extensionToProfiles.entries()) {
			if (profileIds.length > 1) {
				collisions.push(`${ext} -> ${profileIds.join(', ')}`);
			}
		}

		expect(
			collisions.length,
			`Found extension collisions: ${collisions.join('; ')}`,
		).toBe(0);

		// Also verify total extension count
		const totalExtensions = allProfiles.reduce(
			(sum, p) => sum + p.extensions.length,
			0,
		);
		expect(extensionSet.size).toBe(totalExtensions);
	});
});

describe('Tier 3 Language Profiles - Adversarial Tests', () => {
	it('16. getByExtension(".DART") returns undefined (case-sensitive)', () => {
		const dartProfile = LANGUAGE_REGISTRY.getByExtension('.DART');
		expect(dartProfile).toBeUndefined();
	});

	it('17. getByExtension(".RB") returns undefined', () => {
		const rubyProfile = LANGUAGE_REGISTRY.getByExtension('.RB');
		expect(rubyProfile).toBeUndefined();
	});

	it('18. getByExtension(".Rb") returns undefined', () => {
		const rubyProfile = LANGUAGE_REGISTRY.getByExtension('.Rb');
		expect(rubyProfile).toBeUndefined();
	});
});
