import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPreCheckBatch } from '../../../src/tools/pre-check-batch';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const cleanup: string[] = [];

afterEach(() => {
	for (const entry of cleanup.splice(0)) {
		fs.rmSync(entry, { recursive: true, force: true });
	}
});

function linkDirectory(target: string, alias: string): void {
	fs.symlinkSync(
		target,
		alias,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
}

describe('pre_check_batch physical workspace identity (#2474)', () => {
	test('passes an exact physical alias through root validation before file validation', async () => {
		const workspace = canonicalMkdtemp('pre-check-physical-root-');
		const alias = `${workspace}-alias`;
		cleanup.push(alias, workspace);
		fs.mkdirSync(path.join(workspace, '.git'));
		linkDirectory(workspace, alias);

		const result = await runPreCheckBatch(
			{ directory: alias, files: [] },
			workspace,
		);

		expect(result.batch_status).toBe('invalid');
		expect(result.lint.error).toBe('No files provided');
		expect(result.lint.error).not.toContain('path traversal detected');
	});

	test('still rejects foreign and missing sibling roots', async () => {
		const workspace = canonicalMkdtemp('pre-check-physical-workspace-');
		const foreign = canonicalMkdtemp('pre-check-physical-foreign-');
		const missing = `${workspace}-missing`;
		cleanup.push(workspace, foreign);
		fs.mkdirSync(path.join(workspace, '.git'));

		for (const directory of [foreign, missing]) {
			const result = await runPreCheckBatch(
				{ directory, files: [] },
				workspace,
			);
			expect(result.batch_status).toBe('invalid');
			expect(result.lint.error).toContain('path traversal detected');
		}
	});
});
