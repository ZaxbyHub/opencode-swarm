import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkpoint } from '../../../src/tools/checkpoint';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function initRepo(): string {
	const tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-restore-test-')),
	);
	git(tempDir, ['init']);
	git(tempDir, ['config', 'user.email', 'test@test.com']);
	git(tempDir, ['config', 'user.name', 'Test']);
	git(tempDir, ['config', 'commit.gpgsign', 'false']);
	fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'before');
	git(tempDir, ['add', 'tracked.txt']);
	git(tempDir, ['commit', '-m', 'initial']);
	return tempDir;
}

describe('checkpoint restore - regression: restore must reset tracked files', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = initRepo();
	});

	test('restore hard-resets tracked file content to the checkpoint SHA', async () => {
		const saveResult = await checkpoint.execute(
			{ action: 'save', label: 'before-change' },
			{ directory: tempDir } as any,
		);
		const saved = JSON.parse(saveResult);
		expect(saved.success).toBe(true);

		fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'after');
		git(tempDir, ['add', 'tracked.txt']);
		git(tempDir, ['commit', '-m', 'after checkpoint']);
		expect(fs.readFileSync(path.join(tempDir, 'tracked.txt'), 'utf-8')).toBe(
			'after',
		);

		const restoreResult = await checkpoint.execute(
			{ action: 'restore', label: 'before-change' },
			{ directory: tempDir } as any,
		);
		const restored = JSON.parse(restoreResult);

		expect(restored.success).toBe(true);
		expect(restored.message).toContain('hard reset');
		expect(git(tempDir, ['rev-parse', 'HEAD']).trim()).toBe(saved.sha);
		expect(fs.readFileSync(path.join(tempDir, 'tracked.txt'), 'utf-8')).toBe(
			'before',
		);
	});
});
