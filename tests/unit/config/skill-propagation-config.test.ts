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
	});
});
