import { describe, expect, test } from 'bun:test';
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

test('missing file paths use conservative unknown comment handling', () => {
	const original = 'const value = 1;\n';
	const mutated = '// changed\nconst value = 1;\n';

	expect(isStaticallyEquivalentWithPath(original, mutated)).toBe(false);
});

function makePatch(overrides?: Partial<MutationPatch>): MutationPatch {
	return {
		id: 'patch-1',
		filePath: 'test.ts',
		functionName: 'testFn',
		mutationType: 'return',
		patch: '',
		...overrides,
	};
}

describe('isStaticallyEquivalent', () => {
	test('identical code returns true', () => {
		const code = 'function hello() {\n  return 42;\n}';
		expect(isStaticallyEquivalent(code, code)).toBe(true);
	});

	test('code differs only by comments returns true', () => {
		const original = 'function hello() {\n  return 42;\n}';
		const mutated =
			'function hello() {\n  // this is a comment\n  return 42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('code differs only by console.log returns true', () => {
		const original = 'function hello() {\n  return 42;\n}';
		const mutated =
			'function hello() {\n  console.log("debug");\n  return 42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('code differs by internal whitespace returns false', () => {
		// The static equivalence filter only removes empty lines, not internal whitespace
		const original = 'function hello() {\n  return 42;\n}';
		const mutated = 'function   hello()  {\n    return   42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(false);
	});

	test('code with string containing "//" returns false (not equivalent)', () => {
		const original = 'const url = "http://example.com";';
		const mutated = 'const url = "http://example.com/path";';
		expect(isStaticallyEquivalent(original, mutated)).toBe(false);
	});

	test('code with string before comment strips correctly', () => {
		const original = 'const s = "hello";';
		const mutated = 'const s = "hello"; // comment';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('multi-line comment on its own line is stripped', () => {
		const original = 'function hello() {\n  return 42;\n}';
		const mutated =
			'function hello() {\n  /* multi-line\n     comment */\n  return 42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('console.logError is NOT stripped (different method)', () => {
		const original = 'function hello() {\n  return 42;\n}';
		const mutated =
			'function hello() {\n  console.logError("failed");\n  return 42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(false);
	});

	test('empty strings return true', () => {
		expect(isStaticallyEquivalent('', '')).toBe(true);
	});

	test('escaped quotes in strings are handled correctly', () => {
		const original = 'const s = "hello\\"world";';
		const mutated = 'const s = "hello";';
		expect(isStaticallyEquivalent(original, mutated)).toBe(false);
	});

	test('code with backtick string containing // is not stripped', () => {
		const original = 'const s = "hello";';
		const mutated = 'const s = `hello // not a comment`;';
		expect(isStaticallyEquivalent(original, mutated)).toBe(false);
	});

	test('debugger statement is stripped', () => {
		const original = 'function hello() {\n  return 42;\n}';
		const mutated = 'function hello() {\n  debugger;\n  return 42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('console.debug statement is stripped', () => {
		const original = 'function hello() {\n  return 42;\n}';
		const mutated =
			'function hello() {\n  console.debug("debug");\n  return 42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('mixed single and multi-line comments', () => {
		const original = 'function hello() {\n  return 42;\n}';
		const mutated =
			'/* header */\nfunction hello() {\n  // inline\n  return 42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('code with only whitespace difference in blank lines', () => {
		const original = 'function hello() {\n\n  return 42;\n}';
		const mutated = 'function hello() {\n   \n  return 42;\n}';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('single-line comment at end of code line', () => {
		const original = 'const x = 1;';
		const mutated = 'const x = 1; // set x to 1';
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
	});

	test('multi-line comment with content after on same line is not fully stripped', () => {
		const original = 'function hello() {\n  return 42;\n}';
		const mutated = 'function hello() {\n  /* comment */ return 42;\n}';
		// The comment text is removed but internal whitespace remains
		// so the stripped result differs
		expect(isStaticallyEquivalent(original, mutated)).toBe(false);
	});

	test('triple-quoted strings preserve content', () => {
		const original = 'const s = """hello"""';
		const mutated = 'const s = """world"""';
		expect(isStaticallyEquivalent(original, mutated)).toBe(false);
	});
});

describe('checkEquivalence', () => {
	test('static equivalent returns method=static', async () => {
		const patch = makePatch({ id: 'patch-static' });
		const original = 'function hello() {\n  return 42;\n}';
		const mutated = 'function hello() {\n  // comment\n  return 42;\n}';

		const result = await checkEquivalence(patch, original, mutated);

		expect(result.patchId).toBe('patch-static');
		expect(result.isEquivalent).toBe(true);
		expect(result.method).toBe('static');
		expect(result.confidence).toBe(1.0);
	});

	test('with LLM judge callback returns method=llm_judge', async () => {
		const patch = makePatch({ id: 'patch-llm' });
		const original = 'function hello() { return 42; }';
		const mutated = 'function hello() { return 43; }';

		const mockJudge = async () => ({
			isEquivalent: false,
			confidence: 0.9,
			reason: 'Different return values',
		});

		const result = await checkEquivalence(patch, original, mutated, mockJudge);

		expect(result.patchId).toBe('patch-llm');
		expect(result.isEquivalent).toBe(false);
		expect(result.method).toBe('llm_judge');
		expect(result.confidence).toBe(0.9);
	});

	test('without LLM judge returns method=skipped', async () => {
		const patch = makePatch({ id: 'patch-skipped' });
		const original = 'function hello() { return 42; }';
		const mutated = 'function hello() { return 43; }';

		const result = await checkEquivalence(patch, original, mutated);

		expect(result.patchId).toBe('patch-skipped');
		expect(result.isEquivalent).toBe(false);
		expect(result.method).toBe('skipped');
		expect(result.confidence).toBe(0);
		expect(result.reason).toContain('No LLM judge provided');
	});

	test('static equivalent takes precedence over LLM judge', async () => {
		const patch = makePatch({ id: 'patch-static-first' });
		const original = 'function hello() {\n  return 42;\n}';
		const mutated = 'function hello() {\n  // comment\n  return 42;\n}';

		let judgeCalled = false;
		const mockJudge = async () => {
			judgeCalled = true;
			return {
				isEquivalent: false,
				confidence: 0.9,
				reason: 'Should not be called',
			};
		};

		const result = await checkEquivalence(patch, original, mutated, mockJudge);

		expect(result.method).toBe('static');
		expect(judgeCalled).toBe(false);
	});
});

describe('batchCheckEquivalence', () => {
	test('processes all patches', async () => {
		const patches = [
			{
				patch: makePatch({ id: 'batch-1' }),
				originalCode: 'function a() {\n  return 1;\n}',
				mutatedCode: 'function a() {\n  // comment\n  return 1;\n}',
			},
			{
				patch: makePatch({ id: 'batch-2' }),
				originalCode: 'function b() { return 2; }',
				mutatedCode: 'function b() { return 3; }',
			},
		];

		const results = await batchCheckEquivalence(patches);

		expect(results).toHaveLength(2);
		expect(results[0].patchId).toBe('batch-1');
		expect(results[0].isEquivalent).toBe(true);
		expect(results[1].patchId).toBe('batch-2');
		expect(results[1].isEquivalent).toBe(false);
	});

	test('handles individual errors gracefully', async () => {
		const patches = [
			{
				patch: makePatch({ id: 'batch-error-1' }),
				originalCode: 'function a() { return 1; }',
				mutatedCode: 'function a() { return 2; }',
			},
			{
				patch: makePatch({ id: 'batch-error-2' }),
				originalCode: 'function b() { return 3; }',
				mutatedCode: 'function b() { return 4; }',
			},
		];

		let callCount = 0;
		const mockJudge = async () => {
			callCount++;
			if (callCount === 1) {
				return {
					isEquivalent: true,
					confidence: 1.0,
					reason: 'ok',
				};
			}
			throw new Error('LLM error');
		};

		const results = await batchCheckEquivalence(patches, mockJudge);

		expect(results).toHaveLength(2);
		expect(results[0].isEquivalent).toBe(true);
		expect(results[0].method).toBe('llm_judge');
		expect(results[1].isEquivalent).toBe(false);
		expect(results[1].method).toBe('skipped');
		expect(results[1].reason).toContain('LLM error');
	});

	test('empty patches array returns empty results', async () => {
		const results = await batchCheckEquivalence([]);
		expect(results).toHaveLength(0);
	});
});
