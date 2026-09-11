import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	executeMutation,
	type MutationCommandRunner,
	type MutationPatch,
} from '../../../src/mutation/engine.js';

const roots: string[] = [];

function root(prefix: string): string {
	const value = realpathSync(mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
	roots.push(value);
	return value;
}

function patch(filePath: string): MutationPatch {
	return {
		id: 'containment',
		filePath,
		functionName: 'value',
		mutationType: 'operator-swap',
		patch: 'diff --git a/source.ts b/source.ts\n',
	};
}

function completed(): Awaited<ReturnType<MutationCommandRunner>> {
	return {
		status: 'completed',
		exitCode: 0,
		stdout: '',
		stderr: '',
	};
}

afterEach(() => {
	for (const directory of roots.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('mutation byte restoration containment', () => {
	test('does not snapshot or restore an outside absolute path or symlink target', async () => {
		const workingDir = root('mutation-project');
		const outsideDir = root('mutation-outside');
		const outsideFile = path.join(outsideDir, 'source.ts');
		writeFileSync(outsideFile, 'outside-original');

		let filePath = outsideFile;
		try {
			symlinkSync(
				outsideDir,
				path.join(workingDir, 'external-link'),
				'junction',
			);
			filePath = path.join('external-link', 'source.ts');
		} catch {
			// The absolute-path case still exercises the same realpath boundary when
			// the host disallows creating links in its temporary directory.
		}

		let calls = 0;
		const runner: MutationCommandRunner = async () => {
			calls++;
			if (calls === 1) writeFileSync(outsideFile, 'outside-mutated');
			return completed();
		};

		const result = await executeMutation(
			patch(filePath),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('survived');
		expect(calls).toBe(3);
		expect(readFileSync(outsideFile, 'utf8')).toBe('outside-mutated');
	});

	test('does not overwrite a concurrent edit when reverse apply fails', async () => {
		const workingDir = root('mutation-project');
		const sourceFile = path.join(workingDir, 'source.ts');
		writeFileSync(sourceFile, 'source-original');

		let calls = 0;
		const runner: MutationCommandRunner = async ({ args }) => {
			calls++;
			if (calls === 1) writeFileSync(sourceFile, 'source-mutated');
			if (args[0] === 'apply' && args[1] === '-R') {
				writeFileSync(sourceFile, 'source-user-edit');
				return {
					status: 'completed',
					exitCode: 1,
					stdout: '',
					stderr: 'conflict',
				};
			}
			return completed();
		};

		const result = await executeMutation(
			patch('source.ts'),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toContain('git apply -R failed');
		expect(readFileSync(sourceFile, 'utf8')).toBe('source-user-edit');
	});

	test('preserves an unrelated concurrent edit when reverse apply succeeds', async () => {
		const workingDir = root('mutation-project');
		const sourceFile = path.join(workingDir, 'source.ts');
		writeFileSync(sourceFile, 'line-one-original\nline-two-original\n');

		let calls = 0;
		const runner: MutationCommandRunner = async ({ args }) => {
			calls++;
			if (calls === 1) {
				writeFileSync(sourceFile, 'line-one-mutated\nline-two-original\n');
			} else if (calls === 2) {
				// Simulate a user edit unrelated to the mutated line while tests run.
				writeFileSync(sourceFile, 'line-one-mutated\nline-two-user-edit\n');
			} else if (args[0] === 'apply' && args[1] === '-R') {
				// A successful reverse preserves the unrelated user edit.
				writeFileSync(sourceFile, 'line-one-original\nline-two-user-edit\n');
			}
			return completed();
		};

		const result = await executeMutation(
			patch('source.ts'),
			['bun', 'test'],
			['tests/selected.test.ts'],
			workingDir,
			{ runner },
		);

		expect(result.outcome).toBe('survived');
		expect(calls).toBe(3);
		expect(readFileSync(sourceFile, 'utf8')).toBe(
			'line-one-original\nline-two-user-edit\n',
		);
	});
});
