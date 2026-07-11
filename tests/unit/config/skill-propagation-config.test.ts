import { describe, expect, test } from 'bun:test';
import {
	PluginConfigSchema,
	SkillPropagationConfigSchema,
} from '../../../src/config/schema';

describe('SkillPropagationConfigSchema', () => {
	test('defaults enabled to true', () => {
		const result = SkillPropagationConfigSchema.parse({});
		expect(result.enabled).toBe(true);
	});

	test('accepts enabled false', () => {
		const result = SkillPropagationConfigSchema.parse({ enabled: false });
		expect(result.enabled).toBe(false);
	});

	test('defaults enforce to false', () => {
		const result = SkillPropagationConfigSchema.parse({});
		expect(result.enforce).toBe(false);
	});

	test('accepts enforce true', () => {
		const result = SkillPropagationConfigSchema.parse({ enforce: true });
		expect(result.enforce).toBe(true);
	});

	test('rejects non-boolean enforce values', () => {
		expect(() =>
			SkillPropagationConfigSchema.parse({ enforce: 'yes' }),
		).toThrow();
		expect(() => SkillPropagationConfigSchema.parse({ enforce: 1 })).toThrow();
	});

	test('defaults audiences to an empty list', () => {
		const result = SkillPropagationConfigSchema.parse({});
		expect(result.audiences).toEqual([]);
	});

	test('accepts lowercase domain audiences and deduplicates them', () => {
		const result = SkillPropagationConfigSchema.parse({
			audiences: ['ragappv3', 'ragappv3.api-tests_v2', 'ragappv3'],
		});
		expect(result.audiences).toEqual(['ragappv3', 'ragappv3.api-tests_v2']);
	});

	test('rejects reserved plugin and runner audiences', () => {
		for (const audience of [
			'swarm-plugin',
			'runner:opencode',
			'runner:claude',
			'runner:codex',
			'runner:future',
		]) {
			expect(() =>
				SkillPropagationConfigSchema.parse({ audiences: [audience] }),
			).toThrow();
		}
	});

	test('rejects invalid or oversized domain audiences', () => {
		for (const audience of [
			'RAGAPPv3',
			'-ragappv3',
			'ragappv3-',
			'ragappv3..api',
			'a'.repeat(65),
		]) {
			expect(() =>
				SkillPropagationConfigSchema.parse({ audiences: [audience] }),
			).toThrow();
		}
	});

	test('rejects more than 16 configured audience entries', () => {
		expect(() =>
			SkillPropagationConfigSchema.parse({
				audiences: Array.from({ length: 17 }, () => 'ragappv3'),
			}),
		).toThrow();
	});
});

describe('PluginConfigSchema — skillPropagation field', () => {
	test('skillPropagation is optional', () => {
		const result = PluginConfigSchema.parse({});
		expect(result.skillPropagation).toBeUndefined();
	});

	test('skillPropagation applies defaults when present as empty object', () => {
		const result = PluginConfigSchema.parse({
			skillPropagation: {},
		});
		expect(result.skillPropagation?.enabled).toBe(true);
		expect(result.skillPropagation?.enforce).toBe(false);
		expect(result.skillPropagation?.audiences).toEqual([]);
	});
});
