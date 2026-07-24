import { describe, expect, test } from 'bun:test';
import { CheckpointConfigSchema } from '../../../src/config/schema';

describe('CheckpointConfigSchema prototype safety', () => {
	test('rejects an own __proto__ property before Zod strips it', () => {
		const result = CheckpointConfigSchema.safeParse({
			enabled: true,
			['__proto__']: { polluted: true },
		});

		expect(result.success).toBe(false);
	});

	test('rejects an object whose prototype was replaced', () => {
		const polluted = { enabled: true } as Record<string, unknown>;
		Object.setPrototypeOf(polluted, { polluted: true });

		expect(CheckpointConfigSchema.safeParse(polluted).success).toBe(false);
	});

	test('rejects a null-prototype object', () => {
		const input = Object.assign(Object.create(null), { enabled: true });

		expect(CheckpointConfigSchema.safeParse(input).success).toBe(false);
	});

	test('fails closed when prototype reflection throws', () => {
		const input = new Proxy(
			{ enabled: true },
			{
				getPrototypeOf() {
					throw new Error('blocked reflection');
				},
			},
		);

		expect(() => CheckpointConfigSchema.safeParse(input)).not.toThrow();
		expect(CheckpointConfigSchema.safeParse(input).success).toBe(false);
	});

	test('preserves valid defaults', () => {
		const result = CheckpointConfigSchema.parse({});

		expect(result).toEqual({
			enabled: true,
			auto_checkpoint_threshold: 3,
			max_retention: 20,
			allow_empty_commits: false,
		});
	});
});
