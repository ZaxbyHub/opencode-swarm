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
	});
});
