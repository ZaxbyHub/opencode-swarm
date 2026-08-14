import { describe, expect, it } from 'bun:test';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';

describe('KnowledgeConfigSchema receipt retention', () => {
	it('retains closed receipt membership for seven days by default', () => {
		expect(KnowledgeConfigSchema.parse({}).receipt_close_grace_days).toBe(7);
	});

	it('accepts immediate cleanup and the bounded maximum', () => {
		expect(
			KnowledgeConfigSchema.parse({ receipt_close_grace_days: 0 })
				.receipt_close_grace_days,
		).toBe(0);
		expect(
			KnowledgeConfigSchema.parse({ receipt_close_grace_days: 3650 })
				.receipt_close_grace_days,
		).toBe(3650);
	});

	it('rejects negative, oversized, and fractional grace periods', () => {
		for (const receipt_close_grace_days of [-1, 3651, 1.5]) {
			expect(() =>
				KnowledgeConfigSchema.parse({ receipt_close_grace_days }),
			).toThrow();
		}
	});
});
