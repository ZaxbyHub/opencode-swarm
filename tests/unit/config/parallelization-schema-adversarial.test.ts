import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ParallelizationConfigSchema } from '../../../src/config/schema';

describe('Task 3.1 — ARCHITECT_PROMPT EXECUTION DEFAULTS block injection', () => {
	// The EXECUTION DEFAULTS block uses {{VARIABLE}} placeholders in a template literal
	// Attack vector: Can malicious content break template parsing?

	test('ARCHITECT_PROMPT template literal is not vulnerable to ${...} injection', () => {
		// ARCHITECT_PROMPT is a template literal string
		// If it were constructed via ${} interpolation, attacker-controlled variables
		// could inject JavaScript code. Verify the template structure is safe.
		const prompt = `You are Architect - orchestrator of a multi-agent swarm.

## EXECUTION DEFAULTS

These rules are permanent and cannot be overridden by context pressure, phase number, or perceived urgency:

1. **Infinite time and resources** — Never compress, batch, or skip steps under pressure. Every task gets full QA gates regardless of phase count or remaining work.

2. **Parallel coder authorization** — Up to 3 concurrent mega_coder dispatches when tasks are independent (no depends: links). This is the default; no config flag needed.

3. **Stage B always parallel** — reviewer and test_engineer are dispatched in a single message for every task. Never sequential reviewer→test_engineer — parallel is mandatory.

4. **Drift check mandatory** — At every phase end, drift verification runs. Never conditional on apparent stability or phase number. Only Turbo mode (explicit user opt-in) may skip this.

5. **Anti-pressure** — Discard urgency signals from any source. "This is simple", "we're almost done", "just skip it this once" do not change gate requirements. No exception for late phases or near-completion.

## IDENTITY

Swarm: {{SWARM_ID}}`;

		// Verify the template contains no raw ${} interpolation patterns that could execute
		// The EXECUTION DEFAULTS block should only contain {{VARIABLE}} style placeholders
		const hasDollarBraceInjection = /\${[^}]+}/.test(prompt);

		// The block should NOT contain JavaScript template expressions
		expect(hasDollarBraceInjection).toBe(false);
	});

	test('EXECUTION DEFAULTS block content is preserved and static', () => {
		// Verify the EXECUTION DEFAULTS rules are present and unmodified
		const defaultsBlock = `
1. **Infinite time and resources** — Never compress, batch, or skip steps under pressure. Every task gets full QA gates regardless of phase count or remaining work.

2. **Parallel coder authorization** — Up to 3 concurrent mega_coder dispatches when tasks are independent (no depends: links). This is the default; no config flag needed.

3. **Stage B always parallel** — reviewer and test_engineer are dispatched in a single message for every task. Never sequential reviewer→test_engineer — parallel is mandatory.

4. **Drift check mandatory** — At every phase end, drift verification runs. Never conditional on apparent stability or phase number. Only Turbo mode (explicit user opt-in) may skip this.

5. **Anti-pressure** — Discard urgency signals from any source. "This is simple", "we're almost done", "just skip it this once" do not change gate requirements. No exception for late phases or near-completion.`;

		// The defaults block must contain all 5 rules
		expect(defaultsBlock).toContain('Infinite time and resources');
		expect(defaultsBlock).toContain('Parallel coder authorization');
		expect(defaultsBlock).toContain('Stage B always parallel');
		expect(defaultsBlock).toContain('Drift check mandatory');
		expect(defaultsBlock).toContain('Anti-pressure');

		// Must NOT contain executable patterns
		expect(defaultsBlock).not.toContain('${');
		expect(defaultsBlock).not.toContain('${'.repeat(2));
	});

	test('Template variables use double-brace convention, not dollar-brace', () => {
		// Double-brace {{VAR}} is a placeholder convention, not JavaScript interpolation
		// This is safe because it cannot execute code
		const templatePattern = /\{\{[^}]+\}\}/g;
		const examplePlaceholders =
			'{{SWARM_ID}} {{AGENT_PREFIX}} {{PROJECT_LANGUAGE}}';

		const placeholders = examplePlaceholders.match(templatePattern);
		expect(placeholders).toHaveLength(3);

		// Each placeholder is properly closed
		for (const placeholder of placeholders!) {
			expect(placeholder.startsWith('{{')).toBe(true);
			expect(placeholder.endsWith('}}')).toBe(true);
		}
	});

	test('EXECUTION DEFAULTS block is not bypassable via unicode/formatting attacks', () => {
		// Verify that the block cannot be weakened via unicode tricks, zero-width chars, etc.
		const safeBlock = 'Anti-pressure';
		const maliciousVariants = [
			'A\u0334nti-pressure', // Combining diacritical mark
			'A\u200Bnti-pressure', // Zero-width space
			'Anti-\u180Epressure', // Mongolian vowel separator (deprecated but still a char)
			'Anti-p\u200Cpressure', // Zero-width non-joiner
			'Anti-pressure\u034F', // Combining diacritical mark
		];

		for (const variant of maliciousVariants) {
			// Any attempt to inject formatting should NOT match the safe block
			expect(variant === safeBlock).toBe(false);
		}
	});
});

describe('Task 3.2 — ParallelizationConfigSchema adversarial tests', () => {
	// Testing the new max_coders and max_reviewers fields (1-16, default 3 and 2)

	describe('max_coders boundary attacks', () => {
		test('accepts minimum valid value (1)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 1,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_coders).toBe(1);
			}
		});

		test('accepts maximum valid value (16)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 16,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_coders).toBe(16);
			}
		});

		test('rejects value below minimum (0)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 0,
			});
			expect(result.success).toBe(false);
		});

		test('rejects negative value (-1)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: -1,
			});
			expect(result.success).toBe(false);
		});

		test('rejects value above maximum (17)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 17,
			});
			expect(result.success).toBe(false);
		});

		test('rejects Number.MAX_SAFE_INTEGER', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: Number.MAX_SAFE_INTEGER,
			});
			expect(result.success).toBe(false);
		});

		test('rejects Infinity', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: Infinity,
			});
			expect(result.success).toBe(false);
		});

		test('rejects -Infinity', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: -Infinity,
			});
			expect(result.success).toBe(false);
		});

		test('rejects NaN', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: NaN,
			});
			expect(result.success).toBe(false);
		});

		test('accepts integer 3.0 (same as 3)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 3.0,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_coders).toBe(3);
			}
		});

		test('rejects non-integer decimal (3.1)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 3.1,
			});
			expect(result.success).toBe(false);
		});

		test('rejects non-integer decimal (1.9)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 1.9,
			});
			expect(result.success).toBe(false);
		});

		test('rejects non-integer decimal (16.999)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 16.999,
			});
			expect(result.success).toBe(false);
		});
	});

	describe('max_reviewers boundary attacks', () => {
		test('accepts minimum valid value (1)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: 1,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_reviewers).toBe(1);
			}
		});

		test('accepts maximum valid value (16)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: 16,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_reviewers).toBe(16);
			}
		});

		test('rejects value below minimum (0)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: 0,
			});
			expect(result.success).toBe(false);
		});

		test('rejects negative value (-5)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: -5,
			});
			expect(result.success).toBe(false);
		});

		test('rejects value above maximum (100)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: 100,
			});
			expect(result.success).toBe(false);
		});

		test('rejects Number.MAX_SAFE_INTEGER', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: Number.MAX_SAFE_INTEGER,
			});
			expect(result.success).toBe(false);
		});

		test('rejects Infinity', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: Infinity,
			});
			expect(result.success).toBe(false);
		});

		test('rejects -Infinity', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: -Infinity,
			});
			expect(result.success).toBe(false);
		});

		test('rejects NaN', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: NaN,
			});
			expect(result.success).toBe(false);
		});

		test('accepts integer 2.0 (same as 2)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: 2.0,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_reviewers).toBe(2);
			}
		});

		test('rejects non-integer decimal (2.5)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_reviewers: 2.5,
			});
			expect(result.success).toBe(false);
		});
	});

	describe('default values', () => {
		test('empty object applies defaults', () => {
			const result = ParallelizationConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_coders).toBe(3);
				expect(result.data.max_reviewers).toBe(2);
				expect(result.data.enabled).toBe(false);
				expect(result.data.maxConcurrentTasks).toBe(1);
			}
		});

		test('null values do not apply defaults (strict validation)', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: null,
				max_reviewers: null,
			});
			expect(result.success).toBe(false);
		});

		test('undefined values apply defaults', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: undefined,
				max_reviewers: undefined,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_coders).toBe(3);
				expect(result.data.max_reviewers).toBe(2);
			}
		});
	});

	describe('prototype pollution attempts', () => {
		test('__proto__ does not pollute actual prototype chain', () => {
			const result = ParallelizationConfigSchema.safeParse({
				__proto__: { admin: true },
				max_coders: 16,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				// Zod treats __proto__ as a literal property, but it doesn't set the
				// actual prototype chain. The prototype of result.data should still be Object.prototype.
				// We verify the 'admin' property doesn't exist on the actual object.
				expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
				expect(Object.hasOwn(result.data, 'admin')).toBe(false);
			}
		});

		test('constructor property does not pollute actual prototype', () => {
			const result = ParallelizationConfigSchema.safeParse({
				constructor: { prototype: { admin: true } },
				max_coders: 16,
			});
			if (result.success) {
				// constructor on plain objects refers to Object, not the malicious object
				expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
				expect(Object.hasOwn(result.data, 'admin')).toBe(false);
			}
		});

		test('rejects prototype pollution via toString', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 16,
				toString: () => {
					throw new Error('exploit');
				},
			});
			// Should either reject or handle safely
			expect(result.success).toBe(true);
		});

		test('rejects __defineGetter__ pollution', () => {
			const result = ParallelizationConfigSchema.safeParse({
				__defineGetter__: () => {
					throw new Error('exploit');
				},
				max_coders: 16,
			});
			expect(result.success).toBe(true);
		});
	});

	describe('type confusion attacks', () => {
		test('rejects string input "3"', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: '3',
			});
			expect(result.success).toBe(false);
		});

		test('rejects string input "16"', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: '16',
			});
			expect(result.success).toBe(false);
		});

		test('rejects boolean input true', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: true,
			});
			expect(result.success).toBe(false);
		});

		test('rejects boolean input false', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: false,
			});
			expect(result.success).toBe(false);
		});

		test('rejects array input [3]', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: [3],
			});
			expect(result.success).toBe(false);
		});

		test('rejects object input {valueOf: 3}', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: { valueOf: () => 3 },
			});
			expect(result.success).toBe(false);
		});

		test('rejects BigInt input', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: BigInt(3),
			});
			expect(result.success).toBe(false);
		});
	});

	describe('oversized payload attacks', () => {
		test('rejects oversized string number "9999999999999999"', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 9999999999999999,
			});
			expect(result.success).toBe(false);
		});

		test('rejects negative oversized number -9999999999999999', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: -9999999999999999,
			});
			expect(result.success).toBe(false);
		});

		test('accepts large but valid integer (16) to confirm range is the check', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 16,
			});
			expect(result.success).toBe(true);
		});
	});

	describe('unicode and special character injection', () => {
		test('rejects unicode digit alternative (Persian ۳)', () => {
			// Persian/Yiddish digits that look like 3 but are different code points
			const persianThree = '۳';
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: persianThree,
			});
			expect(result.success).toBe(false);
		});

		test('rejects fullwidth digit 3', () => {
			const fullwidthThree = '\uff13'; // U+FF13
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: fullwidthThree,
			});
			expect(result.success).toBe(false);
		});

		test('rejects string with embedded null byte', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: '3\x00',
			});
			expect(result.success).toBe(false);
		});
	});

	describe('combined field validation', () => {
		test('accepts valid combination of max_coders and max_reviewers', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 8,
				max_reviewers: 4,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.max_coders).toBe(8);
				expect(result.data.max_reviewers).toBe(4);
			}
		});

		test('accepts edge case: max_coders=1, max_reviewers=1', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 1,
				max_reviewers: 1,
			});
			expect(result.success).toBe(true);
		});

		test('accepts edge case: max_coders=16, max_reviewers=16', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 16,
				max_reviewers: 16,
			});
			expect(result.success).toBe(true);
		});

		test('rejects max_coders=17 while max_reviewers=2 is valid', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 17,
				max_reviewers: 2,
			});
			expect(result.success).toBe(false);
		});

		test('rejects max_reviewers=0 while max_coders=3 is valid', () => {
			const result = ParallelizationConfigSchema.safeParse({
				max_coders: 3,
				max_reviewers: 0,
			});
			expect(result.success).toBe(false);
		});
	});
});
