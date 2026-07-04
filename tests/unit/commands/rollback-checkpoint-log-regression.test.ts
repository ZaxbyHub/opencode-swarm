import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRollbackCommand } from '../../../src/commands/rollback';
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
		fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-checkpoint-log-test-')),
	);
	git(tempDir, ['init']);
	git(tempDir, ['config', 'user.email', 'test@test.com']);
	git(tempDir, ['config', 'user.name', 'Test']);
	git(tempDir, ['config', 'commit.gpgsign', 'false']);
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'before');
	git(tempDir, ['add', 'tracked.txt']);
	git(tempDir, ['commit', '-m', 'initial']);
	return tempDir;
}

describe('rollback - regression: checkpoint log fallback', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = initRepo();
	});

	async function saveThenAdvance(label: string): Promise<string> {
		const saveResult = await checkpoint.execute({ action: 'save', label }, {
			directory: tempDir,
		} as any);
		const saved = JSON.parse(saveResult);
		expect(saved.success).toBe(true);

		fs.writeFileSync(path.join(tempDir, 'tracked.txt'), 'after');
		git(tempDir, ['add', 'tracked.txt']);
		git(tempDir, ['commit', '-m', 'after checkpoint']);
		return saved.sha;
	}

	test('lists checkpoints from .swarm/checkpoints.json when legacy phase manifest is absent', async () => {
		await saveThenAdvance('safe-point');

		const result = await handleRollbackCommand(tempDir, []);

		expect(result).toContain('## Available Checkpoints');
		expect(result).toContain('"safe-point"');
		expect(result).toContain('/swarm rollback <label-or-number>');
	});

	test('restores a named checkpoint from .swarm/checkpoints.json', async () => {
		const savedSha = await saveThenAdvance('safe-point');

		const result = await handleRollbackCommand(tempDir, ['safe-point']);

		expect(result).toContain('Rolled back to checkpoint "safe-point"');
		expect(git(tempDir, ['rev-parse', 'HEAD']).trim()).toBe(savedSha);
		expect(fs.readFileSync(path.join(tempDir, 'tracked.txt'), 'utf-8')).toBe(
			'before',
		);
	});

	test('restores a listed checkpoint by one-based number', async () => {
		const savedSha = await saveThenAdvance('safe-point');

		const result = await handleRollbackCommand(tempDir, ['1']);

		expect(result).toContain('Rolled back to checkpoint "safe-point"');
		expect(git(tempDir, ['rev-parse', 'HEAD']).trim()).toBe(savedSha);
		expect(fs.readFileSync(path.join(tempDir, 'tracked.txt'), 'utf-8')).toBe(
			'before',
		);
	});
});
