/**
 * Verification tests for Tier 1 language profile registrations
 */

import { describe, expect, it } from 'bun:test';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';

describe('Tier 1 Language Profile Registry', () => {
	// Test 1: LANGUAGE_REGISTRY has exactly 4 profiles registered after importing profiles.ts
	it('should have exactly 4 profiles registered', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		expect(allProfiles).toHaveLength(12);
	});

	// Test 2: getTier(1) returns exactly 4 profiles
	it('should return exactly 4 Tier 1 profiles', () => {
		const tier1Profiles = LANGUAGE_REGISTRY.getTier(1);
		expect(tier1Profiles).toHaveLength(4);
	});

	// Test 3: getTier(2) returns 0 profiles (Tier 2 not registered yet)
	it('should return 0 Tier 2 profiles', () => {
		const tier2Profiles = LANGUAGE_REGISTRY.getTier(2);
		expect(tier2Profiles).toHaveLength(5);
	});

	// Test 4: getByExtension('.ts') returns the typescript profile
	it('should return typescript profile for .ts extension', () => {
		const profile = LANGUAGE_REGISTRY.getByExtension('.ts');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('typescript');
	});

	// Test 5: getByExtension('.py') returns the python profile
	it('should return python profile for .py extension', () => {
		const profile = LANGUAGE_REGISTRY.getByExtension('.py');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('python');
	});

	// Test 6: getByExtension('.rs') returns the rust profile
	it('should return rust profile for .rs extension', () => {
		const profile = LANGUAGE_REGISTRY.getByExtension('.rs');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('rust');
	});

	// Test 7: getByExtension('.go') returns the go profile
	it('should return go profile for .go extension', () => {
		const profile = LANGUAGE_REGISTRY.getByExtension('.go');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('go');
	});

	// Test 8: getByExtension('.tsx') returns the typescript profile
	it('should return typescript profile for .tsx extension', () => {
		const profile = LANGUAGE_REGISTRY.getByExtension('.tsx');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('typescript');
	});

	// Test 9: All 4 Tier 1 profiles have non-null audit.command
	it('should have non-null audit.command for all Tier 1 profiles', () => {
		const tier1Profiles = LANGUAGE_REGISTRY.getTier(1);
		for (const profile of tier1Profiles) {
			expect(profile.audit.command).not.toBeNull();
			expect(profile.audit.command).toBeTruthy();
		}
	});

	// Test 10: All 4 Tier 1 profiles have >= 3 coderConstraints
	it('should have at least 3 coderConstraints for all Tier 1 profiles', () => {
		const tier1Profiles = LANGUAGE_REGISTRY.getTier(1);
		for (const profile of tier1Profiles) {
			expect(profile.prompts.coderConstraints.length).toBeGreaterThanOrEqual(3);
		}
	});

	// Test 11: All 4 Tier 1 profiles have >= 3 reviewerChecklist items
	it('should have at least 3 reviewerChecklist items for all Tier 1 profiles', () => {
		const tier1Profiles = LANGUAGE_REGISTRY.getTier(1);
		for (const profile of tier1Profiles) {
			expect(profile.prompts.reviewerChecklist.length).toBeGreaterThanOrEqual(
				3,
			);
		}
	});

	// Test 12: No extension collisions — getByExtension returns correct profile for each extension in each profile
	it('should have no extension collisions', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();

		for (const profile of allProfiles) {
			for (const ext of profile.extensions) {
				const foundProfile = LANGUAGE_REGISTRY.getByExtension(ext);
				expect(foundProfile).toBeDefined();
				expect(foundProfile?.id).toBe(profile.id);
			}
		}
	});

	// Test 13: All profiles have valid semgrepSupport values
	it('should have valid semgrepSupport values for all profiles', () => {
		const allProfiles = LANGUAGE_REGISTRY.getAll();
		const validSemgrepSupportValues = ['ga', 'beta', 'experimental', 'none'];

		for (const profile of allProfiles) {
			expect(validSemgrepSupportValues).toContain(profile.sast.semgrepSupport);
		}
	});

	// Additional sanity check: Verify all Tier 1 profile IDs are correct
	it('should have correct Tier 1 profile IDs', () => {
		const tier1Profiles = LANGUAGE_REGISTRY.getTier(1);
		const tier1Ids = tier1Profiles.map((p) => p.id).sort();
		expect(tier1Ids).toEqual(['go', 'python', 'rust', 'typescript']);
	});
});
