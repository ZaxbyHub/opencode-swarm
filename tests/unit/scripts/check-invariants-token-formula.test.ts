import { describe, expect, test } from 'bun:test';
import { findInlineTokenFormulaViolations } from '../../../scripts/check-invariants';

/**
 * #2107 §1 / #1616: the inline char/token formula detector must (a) catch a
 * NEW inline ratio in production source, (b) pass clean canonical call sites,
 * and (c) honor the canonical-module and allowlist exemptions.
 */

describe('findInlineTokenFormulaViolations (drift guard, #2107 §1)', () => {
	test('flags an inline ×0.33 estimation', () => {
		const hits = findInlineTokenFormulaViolations('src/services/example.ts', [
			'const tokens = Math.ceil(text.length * 0.33);',
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.lineNo).toBe(1);
	});

	test('flags an inline ÷3.5 estimation', () => {
		const hits = findInlineTokenFormulaViolations('src/services/example.ts', [
			'function estimate(text: string) {',
			'\treturn Math.ceil(text.length / 3.5); // token estimate',
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.lineNo).toBe(2);
	});

	test('flags an inline ÷4 and ×4 estimation in token/char context', () => {
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'return Math.max(1, Math.ceil(content.length / 4)); // tokens',
			]),
		).toHaveLength(1);
		expect(
			findInlineTokenFormulaViolations('src/hooks/example.ts', [
				'const maxChars = Math.floor(maxTokens * 4); // chars per token',
			]),
		).toHaveLength(1);
	});

	test('ignores ÷40 / ×40 (different constants, not ratios)', () => {
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'const tokens = Math.ceil(text.length / 40);',
				'const chars = Math.floor(tokens * 40);',
			]),
		).toHaveLength(0);
	});

	test('ignores the ratio without a Math rounding call or token/char context', () => {
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'const ratio = 0.33; // documented ratio',
				'const total = Math.ceil(items.length / 4); // quartering a list',
			]),
		).toHaveLength(0);
	});

	test('canonical module is exempt by path', () => {
		expect(
			findInlineTokenFormulaViolations('src/hooks/utils.ts', [
				'return Math.ceil(chars * 0.33); // the one sanctioned site',
			]),
		).toHaveLength(0);
	});

	test('allowlisted file is exempt (context-usage binary heuristic)', () => {
		expect(
			findInlineTokenFormulaViolations('src/hooks/context-usage.ts', [
				'return Math.max(byteLength * 4, marker.length); // chars',
			]),
		).toHaveLength(0);
	});

	test('Math.min formulas are detected (shape-regex regression, PR #2415 review)', () => {
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'return Math.min(text.length / 4, cap); // token estimate',
			]),
		).toHaveLength(1);
	});

	test('non-exempt files with the same shape are still flagged', () => {
		expect(
			findInlineTokenFormulaViolations('src/context-map/example.ts', [
				'return Math.max(1, Math.ceil(content.length / 4)); // tokens',
			]),
		).toHaveLength(1);
	});
	test('flags /3, *3, 0.25, and 0.5 estimation forms (#2107 hardening)', () => {
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'return Math.ceil(chars / 3); // tokens',
			]),
		).toHaveLength(1);
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'return Math.floor(tokenBudget * 3); // chars',
			]),
		).toHaveLength(1);
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'return Math.ceil(text.length * 0.25); // token estimate',
			]),
		).toHaveLength(1);
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'return Math.ceil(text.length * 0.5); // token estimate',
			]),
		).toHaveLength(1);
	});
	test('does not flag 0.5 in a non-estimation context (e.g. * 50)', () => {
		expect(
			findInlineTokenFormulaViolations('src/services/example.ts', [
				'const pct = Math.round(ratio * 50); // percent display',
			]),
		).toHaveLength(0);
	});
	test('all four allowlisted files are exempt', () => {
		for (const file of [
			'src/hooks/context-usage.ts',
			'src/background/lane-output-store.ts',
			'src/consensus/miner.ts',
			'src/hooks/knowledge-injector.ts',
		]) {
			expect(
				findInlineTokenFormulaViolations(file, [
					'return Math.max(byteLength * 4, marker.length); // chars',
				]),
			).toHaveLength(0);
		}
	});
});
