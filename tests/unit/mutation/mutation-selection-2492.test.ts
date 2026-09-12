import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	executeMutation,
	type MutationCommandRunner,
	type MutationPatch,
} from '../../../src/mutation/engine';
import { isStaticallyEquivalent } from '../../../src/mutation/equivalence';
import { mutation_test } from '../../../src/tools/mutation-test';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('mutation-selection-2492-');
	fs.mkdirSync(path.join(tempDir, '.git'));
	fs.mkdirSync(path.join(tempDir, 'tests'));
	fs.writeFileSync(
		path.join(tempDir, 'tests', 'target.test.ts'),
		'test("ok", () => {});\n',
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const patch: MutationPatch = {
	id: 'empty-selection',
	filePath: 'src/value.ts',
	functionName: 'value',
	mutationType: 'return_value',
	patch: 'diff --git a/src/value.ts b/src/value.ts\n',
};

describe('issue #2492 mutation selection boundary', () => {
	test('engine refuses empty or flag-only selections without invoking a runner', async () => {
		let runnerCalled = false;
		const runner: MutationCommandRunner = async () => {
			runnerCalled = true;
			return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
		};

		for (const files of [[], ['--all']]) {
			const result = await executeMutation(
				patch,
				['bun', 'test'],
				files,
				tempDir,
				{ runner },
			);
			expect(result.outcome).toBe('skipped');
			expect(result.error).toMatch(/empty|full test suite/i);
		}
		expect(runnerCalled).toBe(false);
	});

	test('unknown extensions remain conservative while Python and C-style comments are removable', () => {
		const original = 'value = 1\n';
		expect(
			isStaticallyEquivalent(
				original,
				'# changed\nvalue = 1\n',
				'src/value.py',
			),
		).toBe(true);
		expect(
			isStaticallyEquivalent(
				original,
				'# changed\nvalue = 1\n',
				'src/value.zzz',
			),
		).toBe(false);
		expect(
			isStaticallyEquivalent(
				'const value = 1;\n',
				'// changed\nconst value = 1;\n',
				'src/value.ts',
			),
		).toBe(true);
	});

	test('tool rejects a patch source that escapes the project root', async () => {
		const result = await mutation_test.execute(
			{
				patches: [{ ...patch, filePath: '../outside.ts' }],
				files: ['tests/target.test.ts'],
				test_command: ['bun', 'test'],
				working_directory: tempDir,
			},
			{ directory: tempDir } as never,
		);
		const parsed = JSON.parse(result);
		expect(parsed.verdict).toBe('skip');
		expect(parsed.evaluable).toBe(false);
		expect(parsed.error).toMatch(/escapes|root/i);
	});
});
