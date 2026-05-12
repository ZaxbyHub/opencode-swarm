import { describe, expect, test } from 'bun:test';
import { ParallelizationConfigSchema } from '../../../src/config/schema';

describe('parallelization prompt and schema adversarial coverage', () => {
	test('parallelization prompt sample does not contain dollar-brace interpolation', () => {
		const prompt = `You are Architect - orchestrator of a multi-agent swarm.

## PARALLELIZATION CONFIG

Standard non-Lean parallelization is enabled by config.

1. Dispatch independent coder tasks up to the configured coder limit.
2. Dispatch all applicable Stage B gate groups together, including reviewer, verification test_engineer, and conditional adversarial test_engineer.
3. This is not Lean Turbo; it is the standard config-driven path.

## IDENTITY

Swarm: {{SWARM_ID}}`;

		expect(/\${[^}]+}/.test(prompt)).toBe(false);
		expect(prompt).toContain('config-driven');
		expect(prompt).toContain('conditional adversarial test_engineer');
		expect(prompt).toContain('{{SWARM_ID}}');
	});

	test('template variables use double-brace placeholders', () => {
		const placeholders =
			'{{SWARM_ID}} {{AGENT_PREFIX}} {{PROJECT_LANGUAGE}}'.match(
				/\{\{[^}]+\}\}/g,
			);

		expect(placeholders).toHaveLength(3);
		for (const placeholder of placeholders ?? []) {
			expect(placeholder.startsWith('{{')).toBe(true);
			expect(placeholder.endsWith('}}')).toBe(true);
		}
	});

	test('anti-pressure wording is not equal under unicode spoofing', () => {
		const safeBlock = 'Anti-pressure';
		const maliciousVariants = [
			'A\u0334nti-pressure',
			'A\u200Bnti-pressure',
			'Anti-\u180Epressure',
			'Anti-p\u200Cpressure',
			'Anti-pressure\u034F',
		];

		for (const variant of maliciousVariants) {
			expect(variant === safeBlock).toBe(false);
		}
	});
});

describe('ParallelizationConfigSchema adversarial tests', () => {
	test.each([
		['max_coders', 1],
		['max_coders', 16],
		['max_reviewers', 1],
		['max_reviewers', 16],
	] as const)('accepts %s boundary value %p', (field, value) => {
		const result = ParallelizationConfigSchema.safeParse({ [field]: value });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data[field]).toBe(value);
		}
	});

	test.each([
		['max_coders', 0],
		['max_coders', -1],
		['max_coders', 17],
		['max_coders', Number.MAX_SAFE_INTEGER],
		['max_coders', Infinity],
		['max_coders', -Infinity],
		['max_coders', NaN],
		['max_coders', 3.1],
		['max_reviewers', 0],
		['max_reviewers', -5],
		['max_reviewers', 100],
		['max_reviewers', Number.MAX_SAFE_INTEGER],
		['max_reviewers', Infinity],
		['max_reviewers', -Infinity],
		['max_reviewers', NaN],
		['max_reviewers', 2.5],
	] as const)('rejects invalid %s value %p', (field, value) => {
		const result = ParallelizationConfigSchema.safeParse({ [field]: value });
		expect(result.success).toBe(false);
	});

	test('empty object applies standard defaults', () => {
		const result = ParallelizationConfigSchema.safeParse({});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(false);
			expect(result.data.maxConcurrentTasks).toBe(1);
			expect(result.data.max_coders).toBe(3);
			expect(result.data.max_reviewers).toBe(2);
		}
	});

	test('undefined values apply defaults, null values fail strict validation', () => {
		const undefinedResult = ParallelizationConfigSchema.safeParse({
			max_coders: undefined,
			max_reviewers: undefined,
		});
		const nullResult = ParallelizationConfigSchema.safeParse({
			max_coders: null,
			max_reviewers: null,
		});

		expect(undefinedResult.success).toBe(true);
		expect(nullResult.success).toBe(false);
	});

	test.each([
		'3',
		'16',
		true,
		false,
		{ valueOf: () => 3 },
		BigInt(3),
		'\uff13',
		'3\x00',
	])('rejects max_coders type confusion input %p', (value) => {
		const result = ParallelizationConfigSchema.safeParse({ max_coders: value });
		expect(result.success).toBe(false);
	});

	test('rejects max_coders array type confusion input', () => {
		const result = ParallelizationConfigSchema.safeParse({ max_coders: [3] });
		expect(result.success).toBe(false);
	});

	test('prototype pollution attempts do not affect parsed data', () => {
		const result = ParallelizationConfigSchema.safeParse({
			__proto__: { admin: true },
			constructor: { prototype: { admin: true } },
			max_coders: 16,
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
			expect(Object.hasOwn(result.data, 'admin')).toBe(false);
		}
	});
});
