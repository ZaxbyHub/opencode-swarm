import { describe, expect, it } from 'bun:test';
import {
	buildConfigJsonSchema,
	serializeConfigSchema,
} from '../../../scripts/generate-config-schema';
import {
	EFFECTIVE_AT_DATETIME_PATTERN,
	PluginConfigSchema,
	PricingConfigSchema,
} from '../../../src/config/schema';

describe('PricingConfigSchema', () => {
	it('accepts per-model token pricing overrides', () => {
		const result = PricingConfigSchema.safeParse({
			currency: 'USD',
			version: '2026-08-29',
			effective_at: '2026-08-29T00:00:00.000Z',
			billing_basis: 'token',
			subscription_unbilled: false,
			reported_cost_currency: { provider: 'USD' },
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
			expect(result.data.currency).toBe('USD');
			expect(result.data.reported_cost_currency.provider).toBe('USD');
			expect(
				result.data.models['provider/custom-model'].output_per_million,
			).toBe(2);
		}
	});

	it('rejects unsupported currencies and unbounded provenance labels', () => {
		expect(
			PricingConfigSchema.safeParse({ currency: 'EUR', models: {} }).success,
		).toBe(false);
		expect(
			PricingConfigSchema.safeParse({
				version: 'x'.repeat(129),
				models: {},
			}).success,
		).toBe(false);
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

	// Trace 3501-3285-3527 (#3501 AC2 / plan N8 third path): zod 4.6
	// tightened `.datetime()` to required seconds; the field pins the legacy
	// optional-seconds pattern explicitly so the public validation contract
	// survives the zod bump on BOTH the runtime schema and the artifact.
	it('effective_at accepts secondless, seconds, and fractional-seconds timestamps', () => {
		expect(
			PricingConfigSchema.safeParse({ effective_at: '2026-09-03T12:34Z' })
				.success,
		).toBe(true);
		expect(
			PricingConfigSchema.safeParse({ effective_at: '2026-09-03T12:34:56Z' })
				.success,
		).toBe(true);
		expect(
			PricingConfigSchema.safeParse({
				effective_at: '2026-09-03T12:34:56.789Z',
			}).success,
		).toBe(true);
	});

	it('effective_at rejects hour-only, invalid calendars, and missing timezone', () => {
		expect(
			PricingConfigSchema.safeParse({ effective_at: '2026-09-03T12Z' }).success,
		).toBe(false);
		expect(
			PricingConfigSchema.safeParse({ effective_at: '2026-13-45T99:99Z' })
				.success,
		).toBe(false);
		expect(
			PricingConfigSchema.safeParse({ effective_at: '2026-09-03 12:34:56' })
				.success,
		).toBe(false);
		expect(
			PricingConfigSchema.safeParse({ effective_at: '2026-02-30T12:34:56Z' })
				.success,
		).toBe(false);
	});

	it('effective_at artifact emits the shared pattern in canonical key order', () => {
		const pricing = buildConfigJsonSchema().properties?.pricing as Record<
			string,
			unknown
		>;
		const effectiveAt = (pricing as { properties?: Record<string, unknown> })
			.properties?.effective_at as Record<string, unknown>;
		expect(effectiveAt.type).toBe('string');
		expect(effectiveAt.format).toBe('date-time');
		expect(effectiveAt.pattern).toBe(EFFECTIVE_AT_DATETIME_PATTERN);
		// Canonical serialization order keeps the artifact byte-stable across
		// zod versions regardless of the emitter's property ordering.
		expect(Object.keys(effectiveAt)).toEqual(['type', 'format', 'pattern']);
	});

	it('the serialized artifact carries the optional-seconds pattern verbatim', () => {
		expect(serializeConfigSchema()).toContain(
			`"pattern": ${JSON.stringify(EFFECTIVE_AT_DATETIME_PATTERN)}`,
		);
	});
});
