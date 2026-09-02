import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_HARNESS_EVOLUTION_CONFIG,
	HarnessEvolutionConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema';

describe('harness evolution config', () => {
	test('is inert and source-closed by default', () => {
		expect(DEFAULT_HARNESS_EVOLUTION_CONFIG).toEqual({
			source_allowlist: [],
			extra_protected_paths: [],
			max_patch_bytes: 1_048_576,
			max_files: 64,
			max_file_bytes: 524_288,
			max_total_bytes: 4_194_304,
			max_changed_lines: 10_000,
			max_versions: 100,
			max_inactive_candidates: 32,
			max_replay_records: 10_000,
			max_output_bytes: 262_144,
		});
		expect(PluginConfigSchema.parse({}).harness_evolution).toBeUndefined();
	});

	test('bounds every configurable resource limit', () => {
		expect(
			HarnessEvolutionConfigSchema.safeParse({ max_files: 0 }).success,
		).toBe(false);
		expect(
			HarnessEvolutionConfigSchema.safeParse({ max_patch_bytes: 16_777_217 })
				.success,
		).toBe(false);
		expect(
			HarnessEvolutionConfigSchema.safeParse({
				max_inactive_candidates: 129,
			}).success,
		).toBe(false);
		expect(
			HarnessEvolutionConfigSchema.parse({
				source_allowlist: ['src/agents'],
			}).source_allowlist,
		).toEqual(['src/agents']);
	});

	test('rejects traversal and absolute allowlist entries', () => {
		for (const candidate of [
			'../src',
			'/tmp/src',
			'C:\\tmp\\src',
			'src/../x',
		]) {
			expect(
				HarnessEvolutionConfigSchema.safeParse({
					source_allowlist: [candidate],
				}).success,
			).toBe(false);
		}
	});
});
