import { describe, expect, test } from 'bun:test';
import { ContextMapConfigSchema } from '../../../src/config/schema';

describe('ContextMapConfigSchema', () => {
	describe('defaults', () => {
		test('parses empty object with all defaults applied', () => {
			const result = ContextMapConfigSchema.parse({});
			expect(result.enabled).toBe(false);
			expect(result.mode).toBe('balanced');
			expect(result.max_capsule_tokens).toBe(2000);
			expect(result.invalidate_on_hash_change).toBe(true);
			expect(result.agent_profiles).toEqual({});
		});

		test('parses undefined through safeParse (returns success=false)', () => {
			// ContextMapConfigSchema.parse(undefined) throws — the schema is not
			// wrapped in .optional(). safeParse is the correct way to test this.
			const result = ContextMapConfigSchema.safeParse(undefined);
			expect(result.success).toBe(false);
		});
	});

	describe('mode validation', () => {
		test('accepts valid mode values', () => {
			for (const mode of ['conservative', 'balanced', 'aggressive'] as const) {
				const result = ContextMapConfigSchema.parse({ mode });
				expect(result.mode).toBe(mode);
			}
		});

		test('rejects invalid mode values', () => {
			const invalidModes = ['balancedx', 'conserv', 'AGGRESSIVE', ''];
			for (const mode of invalidModes) {
				expect(() => ContextMapConfigSchema.parse({ mode })).toThrow();
			}
		});
	});

	describe('max_capsule_tokens validation', () => {
		test('accepts positive integers', () => {
			const result = ContextMapConfigSchema.parse({ max_capsule_tokens: 5000 });
			expect(result.max_capsule_tokens).toBe(5000);
		});

		test('accepts default value of 2000', () => {
			const result = ContextMapConfigSchema.parse({});
			expect(result.max_capsule_tokens).toBe(2000);
		});

		test('rejects zero', () => {
			expect(() =>
				ContextMapConfigSchema.parse({ max_capsule_tokens: 0 }),
			).toThrow();
		});

		test('rejects negative values', () => {
			expect(() =>
				ContextMapConfigSchema.parse({ max_capsule_tokens: -1 }),
			).toThrow();
		});

		test('rejects non-integer values', () => {
			expect(() =>
				ContextMapConfigSchema.parse({ max_capsule_tokens: 1.5 }),
			).toThrow();
		});
	});

	describe('agent_profiles validation', () => {
		test('accepts valid agent_profiles record', () => {
			const profiles = {
				architect: 'conservative',
				coder: 'aggressive',
			};
			const result = ContextMapConfigSchema.parse({ agent_profiles: profiles });
			expect(result.agent_profiles).toEqual(profiles);
		});

		test('accepts empty agent_profiles (default)', () => {
			const result = ContextMapConfigSchema.parse({});
			expect(result.agent_profiles).toEqual({});
		});

		test('rejects non-record values', () => {
			expect(() =>
				ContextMapConfigSchema.parse({ agent_profiles: 'not a record' }),
			).toThrow();
			expect(() =>
				ContextMapConfigSchema.parse({ agent_profiles: [1, 2, 3] }),
			).toThrow();
		});
	});

	describe('invalidate_on_hash_change', () => {
		test('accepts true', () => {
			const result = ContextMapConfigSchema.parse({
				invalidate_on_hash_change: true,
			});
			expect(result.invalidate_on_hash_change).toBe(true);
		});

		test('accepts false', () => {
			const result = ContextMapConfigSchema.parse({
				invalidate_on_hash_change: false,
			});
			expect(result.invalidate_on_hash_change).toBe(false);
		});

		test('defaults to true', () => {
			const result = ContextMapConfigSchema.parse({});
			expect(result.invalidate_on_hash_change).toBe(true);
		});
	});

	describe('full valid config', () => {
		test('parses a fully specified config', () => {
			const config = {
				enabled: true,
				mode: 'aggressive',
				max_capsule_tokens: 4000,
				invalidate_on_hash_change: false,
				agent_profiles: {
					architect: 'conservative',
					coder: 'balanced',
				},
			};
			const result = ContextMapConfigSchema.parse(config);
			expect(result.enabled).toBe(true);
			expect(result.mode).toBe('aggressive');
			expect(result.max_capsule_tokens).toBe(4000);
			expect(result.invalidate_on_hash_change).toBe(false);
			expect(result.agent_profiles).toEqual({
				architect: 'conservative',
				coder: 'balanced',
			});
		});
	});

	describe('optional top-level integration (PluginConfigSchema.context_map)', () => {
		test('context_map field is optional in PluginConfigSchema', async () => {
			const { PluginConfigSchema } = await import('../../../src/config/schema');
			// No context_map key — must not throw
			const result = PluginConfigSchema.parse({});
			expect(result.context_map).toBeUndefined();
		});

		test('context_map field accepts valid ContextMapConfigSchema values', async () => {
			const { PluginConfigSchema } = await import('../../../src/config/schema');
			const result = PluginConfigSchema.parse({
				context_map: {
					enabled: true,
					mode: 'conservative',
				},
			});
			expect(result.context_map).toEqual({
				enabled: true,
				mode: 'conservative',
				max_capsule_tokens: 2000,
				invalidate_on_hash_change: true,
				agent_profiles: {},
			});
		});
	});
});
