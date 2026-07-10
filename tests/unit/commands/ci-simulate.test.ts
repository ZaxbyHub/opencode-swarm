import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as path from 'node:path';
import {
	_internals,
	handleCiSimulateCommand,
} from '../../../src/commands/ci-simulate';
import { COMMAND_REGISTRY } from '../../../src/commands/registry';

const original = {
	runCommand: _internals.runCommand,
	now: _internals.now,
	mkdirSync: _internals.mkdirSync,
};

afterEach(() => {
	_internals.runCommand = original.runCommand;
	_internals.now = original.now;
	_internals.mkdirSync = original.mkdirSync;
});

describe('ci-simulate command', () => {
	test('creates merge-result worktree, runs fixed CI gates, and cleans up', async () => {
		const calls: Array<{ cmd: string[]; cwd: string }> = [];
		const repoRoot = path.join('C:', 'work', 'repo');
		_internals.now = () => 123;
		_internals.mkdirSync = mock(() => undefined) as typeof _internals.mkdirSync;
		_internals.runCommand = mock(async (cmd: string[], cwd: string) => {
			calls.push({ cmd, cwd });
			return { exitCode: 0, stdout: '', stderr: '' };
		}) as typeof _internals.runCommand;

		const result = await handleCiSimulateCommand(repoRoot, [
			'--base',
			'origin/main',
			'--head',
			'feature',
		]);

		expect(result).toContain('CI simulation passed');
		expect(calls[0].cmd.slice(0, 7)).toEqual([
			'git',
			'-C',
			repoRoot,
			'worktree',
			'add',
			'--detach',
			expect.stringContaining(path.join('.swarm', 'ci-simulate')),
		]);
		expect(calls[0].cmd.at(-1)).toBe('origin/main');
		expect(calls[1].cmd).toEqual([
			'git',
			'-C',
			calls[0].cmd[6],
			'merge',
			'--no-edit',
			'feature',
		]);
		expect(calls[2].cmd).toEqual(['bun', 'run', 'typecheck']);
		expect(calls[2].cwd).toBe(calls[0].cmd[6]);
		expect(calls).toContainEqual({
			cmd: ['bun', 'run', 'lint:ci'],
			cwd: calls[0].cmd[6],
		});
		expect(calls).toContainEqual({
			cmd: ['bun', 'run', 'test:unit:ci'],
			cwd: calls[0].cmd[6],
		});
		expect(calls).toContainEqual({
			cmd: ['bun', 'test', 'tests/integration', '--timeout', '120000'],
			cwd: calls[0].cmd[6],
		});
		expect(calls.at(-2)?.cmd.slice(0, 6)).toEqual([
			'git',
			'-C',
			repoRoot,
			'worktree',
			'remove',
			'--force',
		]);
		expect(calls.at(-1)?.cmd).toEqual([
			'git',
			'-C',
			repoRoot,
			'worktree',
			'prune',
		]);
	});

	test('defaults to current worktree HEAD and CI-equivalent gates', async () => {
		const calls: Array<string[]> = [];
		const repoRoot = path.join('C:', 'work', 'default-repo');
		_internals.now = () => 456;
		_internals.mkdirSync = mock(() => undefined) as typeof _internals.mkdirSync;
		_internals.runCommand = mock(async (cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes('rev-parse')) {
				return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		}) as typeof _internals.runCommand;

		await handleCiSimulateCommand(repoRoot, []);

		expect(calls[0]).toEqual(['git', '-C', repoRoot, 'rev-parse', 'HEAD']);
		expect(calls[2]).toEqual([
			'git',
			'-C',
			calls[1][6],
			'merge',
			'--no-edit',
			'abc123',
		]);
		expect(calls).toContainEqual(['bun', 'run', 'typecheck']);
		expect(calls).toContainEqual(['bun', 'run', 'lint:ci']);
		expect(calls).toContainEqual(['bun', 'run', 'build']);
		expect(calls).toContainEqual(['bun', 'run', 'test:unit:ci']);
		expect(calls).toContainEqual([
			'bun',
			'test',
			'tests/integration',
			'--timeout',
			'120000',
		]);
		expect(calls).toContainEqual([
			'bun',
			'test',
			'tests/security',
			'--timeout',
			'120000',
		]);
		expect(calls).toContainEqual([
			'bun',
			'test',
			'tests/smoke',
			'--timeout',
			'120000',
		]);
		expect(calls).toContainEqual(['bun', 'run', 'drift:check']);
	});

	test('rejects arbitrary command arguments', async () => {
		const result = await handleCiSimulateCommand(
			path.join('C:', 'work', 'repo'),
			['--cmd', 'bun', 'test'],
		);

		expect(result).toContain('unsupported argument --cmd');
	});

	test('rejects flags hidden behind missing allowed flag values', async () => {
		const result = await handleCiSimulateCommand(
			path.join('C:', 'work', 'repo'),
			['--base', '--cmd', 'bun', 'test'],
		);

		expect(result).toContain('missing value for --base');
	});

	test('rejects stray positional arguments', async () => {
		const result = await handleCiSimulateCommand(
			path.join('C:', 'work', 'repo'),
			['feature'],
		);

		expect(result).toContain('unexpected positional argument feature');
	});

	test('is registered as an agent command', () => {
		expect(COMMAND_REGISTRY['ci-simulate'].toolPolicy).toBe('agent');
		expect(COMMAND_REGISTRY['ci-simulate'].description).toContain(
			'temporary merge-result worktree',
		);
	});
});
