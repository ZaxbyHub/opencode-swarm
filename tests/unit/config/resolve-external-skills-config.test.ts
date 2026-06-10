import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_EXTERNAL_SKILLS_CONFIG,
	resolveExternalSkillsConfig,
} from '../../../src/config/schema';

describe('resolveExternalSkillsConfig', () => {
	// Test 1: resolveExternalSkillsConfig(undefined) returns DEFAULT_EXTERNAL_SKILLS_CONFIG
	test('undefined input returns DEFAULT_EXTERNAL_SKILLS_CONFIG', () => {
		const result = resolveExternalSkillsConfig(undefined);
		expect(result).toEqual(DEFAULT_EXTERNAL_SKILLS_CONFIG);
		// Ensure it's a copy, not the same reference
		expect(result).not.toBe(DEFAULT_EXTERNAL_SKILLS_CONFIG);
	});

	// Test 2: resolveExternalSkillsConfig({}) returns defaults for all fields
	test('empty object returns defaults for all fields', () => {
		const result = resolveExternalSkillsConfig({});
		expect(result.curation_enabled).toBe(false);
		expect(result.max_candidates).toBe(500);
		expect(result.max_bytes_per_candidate).toBe(1048576);
		expect(result.eviction_policy).toBe('fifo');
		expect(result.ttl_days).toBe(90);
		expect(result.evaluation_enabled).toBe(false);
		expect(result.sources).toEqual([]);
		expect(result.max_candidates_per_discovery).toBe(50);
		expect(result.max_concurrent_fetches).toBe(5);
		expect(result.fetch_timeout_ms).toBe(30000);
	});

	// Test 3: resolveExternalSkillsConfig({ curation_enabled: true }) overrides only that field
	test('curation_enabled: true overrides only that field', () => {
		const result = resolveExternalSkillsConfig({ curation_enabled: true });
		expect(result.curation_enabled).toBe(true);
		expect(result.max_candidates).toBe(500);
		expect(result.max_bytes_per_candidate).toBe(1048576);
		expect(result.eviction_policy).toBe('fifo');
		expect(result.ttl_days).toBe(90);
		expect(result.evaluation_enabled).toBe(false);
		expect(result.sources).toEqual([]);
		expect(result.max_candidates_per_discovery).toBe(50);
		expect(result.max_concurrent_fetches).toBe(5);
		expect(result.fetch_timeout_ms).toBe(30000);
	});

	// Test 4: resolveExternalSkillsConfig({ max_candidates: 100 }) overrides only that field
	test('max_candidates: 100 overrides only that field', () => {
		const result = resolveExternalSkillsConfig({ max_candidates: 100 });
		expect(result.curation_enabled).toBe(false);
		expect(result.max_candidates).toBe(100);
		expect(result.max_bytes_per_candidate).toBe(1048576);
		expect(result.eviction_policy).toBe('fifo');
		expect(result.ttl_days).toBe(90);
		expect(result.evaluation_enabled).toBe(false);
		expect(result.sources).toEqual([]);
		expect(result.max_candidates_per_discovery).toBe(50);
		expect(result.max_concurrent_fetches).toBe(5);
		expect(result.fetch_timeout_ms).toBe(30000);
	});

	// Test 5: resolveExternalSkillsConfig with sources array preserves user sources
	test('sources array from user config is preserved', () => {
		const userSources = [
			{
				type: 'github' as const,
				location: 'https://github.com/example/repo',
				enabled: true,
			},
			{
				type: 'url' as const,
				location: 'https://example.com/skill.md',
				enabled: false,
			},
		];
		const result = resolveExternalSkillsConfig({ sources: userSources });
		expect(result.sources).toEqual(userSources);
		// Verify it's the exact array, not a copy
		expect(result.sources).toBe(userSources);
	});

	// Test 6: resolveExternalSkillsConfig with empty sources returns empty array
	test('empty sources array returns empty array', () => {
		const result = resolveExternalSkillsConfig({ sources: [] });
		expect(result.sources).toEqual([]);
	});

	// Test 7: resolveExternalSkillsConfig with partial fields merges correctly
	test('partial fields merge correctly with defaults', () => {
		const result = resolveExternalSkillsConfig({
			curation_enabled: true,
			max_candidates: 200,
			ttl_days: 30,
		});
		expect(result.curation_enabled).toBe(true);
		expect(result.max_candidates).toBe(200);
		expect(result.ttl_days).toBe(30);
		// Unset fields should be defaults
		expect(result.max_bytes_per_candidate).toBe(1048576);
		expect(result.eviction_policy).toBe('fifo');
		expect(result.evaluation_enabled).toBe(false);
		expect(result.sources).toEqual([]);
		expect(result.max_candidates_per_discovery).toBe(50);
		expect(result.max_concurrent_fetches).toBe(5);
		expect(result.fetch_timeout_ms).toBe(30000);
	});

	// Test 8: DEFAULT_EXTERNAL_SKILLS_CONFIG.curation_enabled === false
	test('DEFAULT_EXTERNAL_SKILLS_CONFIG.curation_enabled is false', () => {
		expect(DEFAULT_EXTERNAL_SKILLS_CONFIG.curation_enabled).toBe(false);
	});

	// Test 9: DEFAULT_EXTERNAL_SKILLS_CONFIG.sources is empty array
	test('DEFAULT_EXTERNAL_SKILLS_CONFIG.sources is empty array', () => {
		expect(DEFAULT_EXTERNAL_SKILLS_CONFIG.sources).toEqual([]);
		expect(Array.isArray(DEFAULT_EXTERNAL_SKILLS_CONFIG.sources)).toBe(true);
	});

	// Test 10: Resolve with all fields provided uses user values (no defaults bleed through)
	test('all fields provided uses user values without defaults bleeding through', () => {
		const allUserValues = {
			curation_enabled: true,
			max_candidates: 1000,
			max_bytes_per_candidate: 2048,
			eviction_policy: 'fifo' as const,
			ttl_days: 180,
			evaluation_enabled: true,
			sources: [
				{
					type: 'github' as const,
					location: 'https://github.com/test/repo',
					enabled: true,
				},
			],
			max_candidates_per_discovery: 100,
			max_concurrent_fetches: 10,
			fetch_timeout_ms: 60000,
		};
		const result = resolveExternalSkillsConfig(allUserValues);
		expect(result.curation_enabled).toBe(true);
		expect(result.max_candidates).toBe(1000);
		expect(result.max_bytes_per_candidate).toBe(2048);
		expect(result.eviction_policy).toBe('fifo');
		expect(result.ttl_days).toBe(180);
		expect(result.evaluation_enabled).toBe(true);
		expect(result.sources).toEqual(allUserValues.sources);
		expect(result.max_candidates_per_discovery).toBe(100);
		expect(result.max_concurrent_fetches).toBe(10);
		expect(result.fetch_timeout_ms).toBe(60000);
	});

	// Additional: verify sources defaults to [] when explicitly null/undefined
	test('sources defaults to empty array when null', () => {
		// @ts-expect-error — testing runtime behavior with invalid input
		const result = resolveExternalSkillsConfig({ sources: null });
		expect(result.sources).toEqual([]);
	});

	test('sources defaults to empty array when explicitly undefined in object', () => {
		const result = resolveExternalSkillsConfig({ sources: undefined });
		expect(result.sources).toEqual([]);
	});
});
