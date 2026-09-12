import { describe, expect, test, vi } from 'bun:test';
import type { MutationPatch } from '../engine.js';
import {
	batchCheckEquivalence,
	checkEquivalence,
	isStaticallyEquivalent as isStaticallyEquivalentWithPath,
} from '../equivalence.js';

function isStaticallyEquivalent(
	originalCode: string,
	mutatedCode: string,
): boolean {
	return isStaticallyEquivalentWithPath(originalCode, mutatedCode, 'test.ts');
}

const mockPatch: MutationPatch = {
	id: 'test-patch-1',
	filePath: 'test.ts',
	functionName: 'testFn',
	mutationType: 'literal-change',
	patch: 'dummy-patch',
};

describe('isStaticallyEquivalent - Adversarial Cases', () => {
	test('1. unclosed multi-line comment — EOF while in comment state', () => {
		const original = 'const x = 1;';
		const mutated = 'const x = 1; /* unclosed comment';
		const result = isStaticallyEquivalent(original, mutated);
		expect(typeof result).toBe('boolean');
	});

	test('2. nested quotes — string containing // not a comment', () => {
		const original = 'const s = "hello";';
		const mutated = 'const s = "he said \'hello\' // not a comment";';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(false);
	});

	test('3. escaped backslash before quote — real comment vs escaped', () => {
		const original = "const s = '\\\\';";
		const mutated = "const s = '\\\\'; // real comment";
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('4. backtick template with ${} and // inside', () => {
		const original = 'const t = `hello`;';
		const mutated = 'const t = `hello ${world} // not a comment`;';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(false);
	});

	test('5. regex literal containing // — /test//', () => {
		const original = 'const r = /test/;';
		const mutated = 'const r = /test//;';
		const result = isStaticallyEquivalent(original, mutated);
		expect(typeof result).toBe('boolean');
	});

	test('6. very long lines (10000+ chars)', () => {
		const longStr = 'a'.repeat(10000);
		const original = `const x = "${longStr}";`;
		const mutated = `const x = "${longStr}"; // comment`;
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('7. null bytes in code', () => {
		const original = 'const x = 1;';
		const mutated = 'const x = 1;\x00// comment';
		const result = isStaticallyEquivalent(original, mutated);
		expect(typeof result).toBe('boolean');
	});

	test('8. only whitespace difference — trimEnd only, internal spaces preserved', () => {
		const original = 'const x = 1;   ';
		const mutated = 'const x = 1;';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('9. Unicode characters — should not break state machine', () => {
		const original = 'const s = "héllo";';
		const mutated = 'const s = "héllo"; // 🚀';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('10. backtick string with embedded // that looks like comment', () => {
		const original = 'const t = `hello`;';
		const mutated = 'const t = `hello // world`;';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(false);
	});

	test('11. /* inside a string — not a multi-line comment', () => {
		const original = 'const s = "/* not a comment */";';
		const mutated = 'const s = "/* not a comment */"; // real comment';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('12. multiple // in different strings on same line', () => {
		const original = 'const a = "x"; const b = "y";';
		const mutated = 'const a = "//"; const b = "//";';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(false);
	});

	test('13. escaped quote inside single-line comment', () => {
		const original = 'const x = 1;';
		const mutated = 'const x = 1; // "test"';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('14. backslash-n inside string (not newline)', () => {
		const original = 'const s = "hello\\nworld";';
		const mutated = 'const s = "hello\\nworld"; // comment';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('15. CRLF line endings (Windows)', () => {
		const original = 'const x = 1;\r\nconst y = 2;';
		const mutated = 'const x = 1;\r\nconst y = 2; // comment';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('16. template literal with nested template ${`...`}', () => {
		const original = 'const t = `a`;';
		const mutated = 'const t = `${`a`}`;';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(false);
	});

	test('17. empty string followed by //', () => {
		const original = 'const s = "";';
		const mutated = 'const s = ""; //';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('18. string with */ inside', () => {
		const original = 'const s = "*/";';
		const mutated = 'const s = "*/"; // comment';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});
});

describe('checkEquivalence - Error Handling', () => {
	test('19. LLM judge that throws — error propagates (not caught inside checkEquivalence)', async () => {
		const throwingJudge = vi
			.fn()
			.mockImplementation(() => Promise.reject(new Error('LLM API failed')));
		const original = 'const x = 1;';
		const mutated = 'const x = 2;';

		// checkEquivalence does NOT catch LLM judge errors internally
		await expect(
			checkEquivalence(mockPatch, original, mutated, throwingJudge),
		).rejects.toThrow('LLM API failed');
	});

	test('20. LLM judge that returns non-boolean isEquivalent', async () => {
		const judge = vi.fn().mockResolvedValue({
			isEquivalent: true,
			confidence: 0.9,
			reason: 'Looks equivalent',
		});
		const original = 'const x = 1;';
		const mutated = 'const x = 1; // different comment';

		const result = await checkEquivalence(mockPatch, original, mutated, judge);

		expect(result.method).toBe('static');
	});

	test('21. LLM judge called only when static analysis returns false', async () => {
		const judge = vi.fn().mockResolvedValue({
			isEquivalent: true,
			confidence: 0.9,
			reason: 'Looks equivalent',
		});
		const original = 'const x = 1;';
		const mutated = 'const x = 2;';

		await checkEquivalence(mockPatch, original, mutated, judge);

		expect(judge).toHaveBeenCalledTimes(1);
	});
});

describe('batchCheckEquivalence - Mixed Results', () => {
	test('22. mixed successes and failures in batch', async () => {
		const judge = vi.fn().mockImplementation((orig, mut) =>
			Promise.resolve({
				isEquivalent: orig === mut,
				confidence: 0.9,
				reason: 'judged',
			}),
		);

		const patches = [
			{
				patch: { ...mockPatch, id: 'p1' },
				originalCode: 'const x = 1;',
				mutatedCode: 'const x = 1;',
			},
			{
				patch: { ...mockPatch, id: 'p2' },
				originalCode: 'const x = 1;',
				mutatedCode: 'const x = 2;',
			},
			{
				patch: { ...mockPatch, id: 'p3' },
				originalCode: 'const x = 1;',
				mutatedCode: 'const x = 3;',
			},
		];

		const results = await batchCheckEquivalence(patches, judge);

		expect(results).toHaveLength(3);
		expect(results[0].isEquivalent).toBe(true);
		expect(results[1].isEquivalent).toBe(false);
		expect(results[2].isEquivalent).toBe(false);
	});

	test('23. batch with one throwing LLM call — others still complete', async () => {
		// p1 returns early (static equivalent), p2 calls judge and throws, p3 calls judge and succeeds
		let callCount = 0;
		const judge = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// p2's judge call - throws
				return Promise.reject(new Error('fail'));
			}
			// p3's judge call - succeeds
			return Promise.resolve({
				isEquivalent: false,
				confidence: 0.9,
				reason: 'ok',
			});
		});

		const patches = [
			{
				patch: { ...mockPatch, id: 'p1' },
				originalCode: 'const x = 1;',
				mutatedCode: 'const x = 1;',
			},
			{
				patch: { ...mockPatch, id: 'p2' },
				originalCode: 'const x = 1;',
				mutatedCode: 'const x = 2;',
			},
			{
				patch: { ...mockPatch, id: 'p3' },
				originalCode: 'const x = 1;',
				mutatedCode: 'const x = 3;',
			},
		];

		const results = await batchCheckEquivalence(patches, judge);

		expect(results).toHaveLength(3);
		expect(results[0].isEquivalent).toBe(true); // p1 - static equivalent, no judge call
		expect(results[1].method).toBe('skipped'); // p2 - judge threw, caught by batch
		expect(results[1].reason).toContain('fail');
		expect(results[2].isEquivalent).toBe(false); // p3 - judge succeeded
	});
});

describe('isStaticallyEquivalent - Boundary Cases', () => {
	test('24. empty strings', () => {
		const result = isStaticallyEquivalent('', '');
		expect(result).toBe(true);
	});

	test('25. single quote string with // inside', () => {
		const original = "const s = '';";
		const mutated = "const s = '//';";
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(false);
	});

	test('26. double quote string with // inside', () => {
		const original = 'const s = "";';
		const mutated = 'const s = "//";';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(false);
	});

	test('27. backtick with // inside', () => {
		const original = 'const s = ``;';
		const mutated = 'const s = `//`;';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(false);
	});

	test('28. line with only comment', () => {
		const original = '// comment';
		const mutated = '';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('29. multi-line comment spanning multiple lines', () => {
		const original = 'const x = 1;';
		const mutated = '/*\n * multi\n * line\n * comment\n */\nconst x = 1;';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});

	test('30. nested multi-line comment start /* inside string', () => {
		const original = 'const s = "/* test */";';
		const mutated = 'const s = "/* test */"; // real';
		const result = isStaticallyEquivalent(original, mutated);
		expect(result).toBe(true);
	});
});
