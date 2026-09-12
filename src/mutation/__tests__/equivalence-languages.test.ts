import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeMutationSuite } from '../../../src/mutation/engine.js';
import {
	commentFamilyForLanguage,
	isStaticallyEquivalent,
} from '../../../src/mutation/equivalence.js';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir.js';

/**
 * Language-aware equivalence/comment filtering (issue #2492 AC4): the static
 * equivalence stage must strip the right comment syntax per language, and a
 * comment-only mutant must classify as equivalent WITHOUT invoking the runner.
 * Mirrors frozen acceptance check c4-language-aware-equivalence.ts.
 */

describe('isStaticallyEquivalent language dispatch (issue #2492 AC4)', () => {
	test('python # comment-only mutants are equivalent (with hint)', () => {
		const original =
			'def add(a, b):\n    # compute the sum\n    return a + b\n';
		const mutated =
			'def add(a, b):\n    # returns the sum of a and b\n    return a + b\n';
		expect(isStaticallyEquivalent(original, mutated, 'add.py')).toBe(true);
		expect(isStaticallyEquivalent(original, mutated, 'python')).toBe(true);
	});

	test('ruby/shell # comment-only mutants are equivalent', () => {
		const original = 'def add\n  # sum\n  a + b\nend\n';
		const mutated = 'def add\n  # total\n  a + b\nend\n';
		expect(isStaticallyEquivalent(original, mutated, 'calc.rb')).toBe(true);
		expect(isStaticallyEquivalent(original, mutated, 'run.sh')).toBe(true);
	});

	test('sql/lua -- comment-only mutants are equivalent', () => {
		const original = 'SELECT 1 -- one\n';
		const mutated = 'SELECT 1 -- ein\n';
		expect(isStaticallyEquivalent(original, mutated, 'q.sql')).toBe(true);
		expect(isStaticallyEquivalent(original, mutated, 's.lua')).toBe(true);
	});

	test('js/ts/go // and block comment-only mutants stay equivalent (default family preserved)', () => {
		const original = 'function add(a, b) {\n  // sum\n  return a + b;\n}\n';
		const mutated = 'function add(a, b) {\n  // total\n  return a + b;\n}\n';
		expect(isStaticallyEquivalent(original, mutated, 'add.ts')).toBe(true);
		expect(isStaticallyEquivalent(original, mutated)).toBe(true);
		const blockOriginal = '/* header */\nconst x = 1;\n';
		const blockMutated = '/* different header */\nconst x = 1;\n';
		expect(isStaticallyEquivalent(blockOriginal, blockMutated, 'x.ts')).toBe(
			true,
		);
	});

	test('code-changing mutants are NOT equivalent in any family', () => {
		const pyOriginal = 'def add(a, b):\n    return a + b\n';
		const pyMutated = 'def add(a, b):\n    return a - b\n';
		expect(isStaticallyEquivalent(pyOriginal, pyMutated, 'add.py')).toBe(false);
	});

	test('php accepts both // and # line comments', () => {
		const original = '<?php\n// note\nfunction f() { return 1; }\n';
		const mutatedHash = '<?php\n# note\nfunction f() { return 1; }\n';
		expect(isStaticallyEquivalent(original, mutatedHash, 'f.php')).toBe(true);
	});

	test('commentFamilyForLanguage default matches the 2-argument behavior', () => {
		expect(commentFamilyForLanguage(undefined)).toEqual({
			lineTokens: ['//'],
			blockComments: true,
		});
		expect(commentFamilyForLanguage('x.py')).toEqual({
			lineTokens: ['#'],
			blockComments: false,
		});
	});
});

describe('engine-level comment-only mutant classification (issue #2492 AC4)', () => {
	test('comment-only python mutant is equivalent and the runner is never invoked', async () => {
		const tmp = canonicalMkdtemp('eq-lang-');
		fs.writeFileSync(
			path.join(tmp, 'calc.py'),
			'def add(a, b):\n    # compute\n    return a + b\n',
		);
		let runnerCalls = 0;
		const report = await executeMutationSuite(
			[
				{
					id: 'm1',
					filePath: 'calc.py',
					functionName: 'add',
					mutationType: 'comment_only',
					patch:
						'--- a/calc.py\n+++ b/calc.py\n@@ -1,3 +1,3 @@\n def add(a, b):\n-    # compute\n+    # compute the total\n     return a + b\n',
				},
			],
			['bun', 'test'],
			['tests/calc.test.ts'],
			tmp,
			undefined,
			undefined,
			new Map([
				['calc.py', fs.readFileSync(path.join(tmp, 'calc.py'), 'utf-8')],
			]),
			{
				runner: async () => {
					runnerCalls++;
					return {
						status: 'completed' as const,
						exitCode: 1,
						stdout: 'should not matter',
						stderr: '',
					};
				},
			},
		);
		expect(report.results[0]?.outcome).toBe('equivalent');
		expect(runnerCalls).toBe(0);
		expect(report.equivalent).toBe(1);
	});

	test('comment-only mutant in a PARTIAL hunk (multi-line file) is equivalent — full-file reconstruction', async () => {
		// The discriminating shape for diff reconstruction: an 11-line file
		// with a realistic 4-line hunk in the middle. The mutated FULL FILE is
		// reconstructed by applying the hunk to the original; comparing
		// hunk-only text against the whole file made equivalence inert here.
		const tmp = canonicalMkdtemp('eq-partial-');
		const originalLines = [
			'export function calc(a, b) {',
			'  const sum = a + b;',
			'  // note',
			'  return sum;',
			'}',
			'',
			'export function neg(a) {',
			'  return -a;',
			'}',
			'',
			'export const K = 1;',
		];
		fs.writeFileSync(
			path.join(tmp, 'calc.ts'),
			`${originalLines.join('\n')}\n`,
		);
		let runnerCalls = 0;
		const report = await executeMutationSuite(
			[
				{
					id: 'm1',
					filePath: 'calc.ts',
					functionName: 'calc',
					mutationType: 'comment_only',
					patch:
						'--- a/calc.ts\n+++ b/calc.ts\n@@ -1,5 +1,5 @@\n export function calc(a, b) {\n   const sum = a + b;\n-  // note\n+  // updated note\n   return sum;\n }\n',
				},
			],
			['bun', 'test'],
			['tests/calc.test.ts'],
			tmp,
			undefined,
			undefined,
			new Map([['calc.ts', `${originalLines.join('\n')}\n`]]),
			{
				runner: async () => {
					runnerCalls++;
					return {
						status: 'completed' as const,
						exitCode: 1,
						stdout: '',
						stderr: '',
					};
				},
			},
		);
		expect(report.results[0]?.outcome).toBe('equivalent');
		expect(runnerCalls).toBe(0);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('non-applying patch falls back to hunk-only text (equivalence does not fire)', async () => {
		// A patch whose context does not match the original cannot be applied;
		// reconstruction returns null and the engine falls back to hunk-only
		// text, so equivalence stays silent (no mis-fire) for garbage patches.
		const tmp = canonicalMkdtemp('eq-nonapp-');
		let runnerCalls = 0;
		const report = await executeMutationSuite(
			[
				{
					id: 'm1',
					filePath: 'calc.ts',
					functionName: 'calc',
					mutationType: 'comment_only',
					patch:
						'--- a/calc.ts\n+++ b/calc.ts\n@@ -1,2 +1,2 @@\n-TOTALLY-DIFFERENT-CONTEXT\n+whatever\n',
				},
			],
			['bun', 'test'],
			['tests/x.test.ts'],
			tmp,
			undefined,
			undefined,
			new Map([['calc.ts', 'export const a = 1;\n']]),
			{
				runner: async () => {
					runnerCalls++;
					return {
						status: 'completed' as const,
						exitCode: 1,
						stdout: '',
						stderr: '',
					};
				},
			},
		);
		// Hunk-only fallback does not equal the original → the mutant runs
		// (the runner handles both the patch-apply and the test invocation,
		// hence 2 calls for one patch).
		expect(report.results[0]?.outcome).not.toBe('equivalent');
		expect(runnerCalls).toBeGreaterThanOrEqual(1);
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
