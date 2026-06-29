import { describe, expect, it } from 'bun:test';
import {
	PluginConfigSchema,
	PricingConfigSchema,
} from '../../../src/config/schema';

describe('PricingConfigSchema', () => {
	it('accepts per-model token pricing overrides', () => {
		const result = PricingConfigSchema.safeParse({
			models: {
				'provider/custom-model': {
					input_per_million: 1,
					output_per_million: 2,
					reasoning_per_million: 3,
					cache_per_million: 0.5,
				},
			},
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(
				result.data.models['provider/custom-model'].output_per_million,
			).toBe(2);
		}
	});

	it('rejects negative pricing values', () => {
		const result = PricingConfigSchema.safeParse({
			models: {
				'provider/custom-model': {
					input_per_million: -1,
					output_per_million: 2,
				},
			},
		});

		expect(result.success).toBe(false);
	});

	it('rejects empty-string model names', () => {
		const result = PricingConfigSchema.safeParse({
			models: {
				'': {
					input_per_million: 1,
					output_per_million: 2,
				},
			},
		});

		expect(result.success).toBe(false);
	});

	it('is optional in PluginConfigSchema', () => {
		const omitted = PluginConfigSchema.safeParse({});
		const configured = PluginConfigSchema.safeParse({
			pricing: {
				models: {
					'provider/custom-model': {
						input_per_million: 1,
						output_per_million: 2,
					},
				},
			},
		});

		expect(omitted.success).toBe(true);
		expect(configured.success).toBe(true);
	});
});
