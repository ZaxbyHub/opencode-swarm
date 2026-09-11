import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	executeMutationSuite,
	type MutationCommandResult,
	type MutationPatch,
} from '../../../src/mutation/engine';
import { isStaticallyEquivalent } from '../../../src/mutation/equivalence';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('mutation-comments-2492-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function commentPatch(filePath: string): MutationPatch {
	return {
		id: filePath,
		filePath,
		functionName: 'module',
		mutationType: 'comment_only',
		patch: [
			`--- a/${filePath}`,
			`+++ b/${filePath}`,
			'@@ -1 +1 @@',
			'-# old comment',
			'+# new comment',
		].join('\n'),
	};
}

describe('issue #2492: hash-comment equivalence through mutation execution', () => {
	for (const filePath of ['src/value.py', 'src/value.rb']) {
		test(`marks a ${path.extname(filePath)} comment-only mutant equivalent`, async () => {
			const patch = commentPatch(filePath);
			const runnerCalls: Array<{ executable: string; args: string[] }> = [];
			const runner = async (args: {
				executable: string;
				args: string[];
				cwd: string;
				timeoutMs: number;
			}): Promise<MutationCommandResult> => {
				runnerCalls.push({ executable: args.executable, args: args.args });
				return {
					status: 'completed',
					exitCode: 0,
					stdout: '',
					stderr: '',
				};
			};

			const report = await executeMutationSuite(
				[patch],
				['bun', 'test'],
				['tests/target.test.ts'],
				tempDir,
				undefined,
				undefined,
				new Map([[filePath, '# old comment\n']]),
				{ runner },
			);

			expect(report.results).toHaveLength(1);
			expect(report.results[0].outcome).toBe('equivalent');
			expect(report.equivalent).toBe(1);
			// An equivalent mutant is not applied and must not consume a test run.
			expect(runnerCalls).toHaveLength(0);
		});
	}
});

describe('issue #2492: debug-like lines are language-aware', () => {
	test.each([
		[
			'Swift console.log call',
			'src/logger.swift',
			'console.log("old")\n// old comment\n',
			'console.log("new")\n// new comment\n',
		],
		[
			'Rust debugger-like identifier',
			'src/debug.rs',
			'debugger;\n// old comment\n',
			'DEBUGGER;\n// new comment\n',
		],
	])('%s remains non-equivalent outside the JS family', (_name, filePath, original, mutated) => {
		expect(isStaticallyEquivalent(original, mutated, filePath)).toBe(false);
	});

	test('Rust strings containing debug-like text remain code', () => {
		expect(
			isStaticallyEquivalent(
				'let message = "debugger;";\n// old comment\n',
				'let message = "debugger!";\n// new comment\n',
				'src/message.rs',
			),
		).toBe(false);
	});
});
