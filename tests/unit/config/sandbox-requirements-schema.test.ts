import { describe, expect, test } from 'bun:test';
import { GuardrailsConfigSchema } from '../../../src/config/schema.js';

describe('guardrails sandbox requirements schema', () => {
	test('defaults to advisory compatibility', () => {
		expect(GuardrailsConfigSchema.parse({}).sandbox).toBeUndefined();
	});
	test('accepts explicit required dimensions and bounds lists', () => {
		const parsed = GuardrailsConfigSchema.parse({
			sandbox: {
				mode: 'required',
				require_filesystem: true,
				require_network: true,
				require_process: true,
			},
		});
		expect(parsed.sandbox?.mode).toBe('required');
		expect(() =>
			GuardrailsConfigSchema.parse({
				sandbox: { network_allowlist: Array(129).fill('x') },
			}),
		).toThrow();
	});
});
