import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { PluginConfigSchema } from '../../../src/config/schema';

/**
 * Issue #1663 — top-level config surface guarantees:
 *  - `$schema` is a whitelisted, parse-transparent metadata key (so editor
 *    references do not warn in config-doctor and survive parsing), and
 *  - every top-level key carries a `.describe()` summary so the generated
 *    JSON Schema and docs table are self-documenting (ratchet: new keys must
 *    ship a description).
 */

const JSON_SCHEMA = z.toJSONSchema(PluginConfigSchema, { io: 'input' }) as {
	properties: Record<string, { description?: string }>;
};

describe('PluginConfigSchema — $schema whitelist (issue #1663)', () => {
	test('$schema is part of the shape (source of config-doctor KNOWN_TOP_LEVEL_KEYS)', () => {
		expect('$schema' in PluginConfigSchema.shape).toBe(true);
	});

	test('parses and retains a $schema reference', () => {
		const ref = 'https://unpkg.com/opencode-swarm/opencode-swarm.schema.json';
		const result = PluginConfigSchema.safeParse({ $schema: ref });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.$schema).toBe(ref);
		}
	});

	test('configs without $schema parse to an output without $schema', () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect('$schema' in result.data).toBe(false);
		}
	});
});

describe('PluginConfigSchema — per-key descriptions ratchet (issue #1663)', () => {
	test('every top-level key carries a description in the JSON Schema projection', () => {
		const keys = Object.keys(PluginConfigSchema.shape);
		expect(keys.length).toBeGreaterThan(60);
		const missing = keys.filter((k) => !JSON_SCHEMA.properties[k]?.description);
		expect(missing).toEqual([]);
	});

	test('descriptions are single-line and non-trivial', () => {
		for (const [key, prop] of Object.entries(JSON_SCHEMA.properties)) {
			const description = prop.description ?? '';
			expect(description.length, `key ${key}`).toBeGreaterThan(10);
			expect(description.includes('\n'), `key ${key}`).toBe(false);
		}
	});
});

describe('PluginConfigSchema — strict-section hazard is unchanged (documented behavior)', () => {
	test('a nested typo inside a strict section still fails the parse (loader recovery handles it)', () => {
		const result = PluginConfigSchema.safeParse({ council: { enbled: true } });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((i) => i.code === 'unrecognized_keys'),
			).toBe(true);
		}
	});
});
