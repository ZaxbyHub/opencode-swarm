import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePorcelainV2Snapshot } from '../../../src/background/workspace-snapshot.js';
import {
	_internals,
	classifyPrWorkflowGitState,
} from '../../../src/git/pr-workflow-state.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';

const GIT_TIMEOUT_MS = 30_000;
let tempRoot = '';
const originalRunGitCapture = _internals.runGitCapture;
const originalActiveOperations = _internals.activeOperations;

async function runGit(
	cwd: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bunSpawn(['git', ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: GIT_TIMEOUT_MS,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort cleanup.
		}
	}
}

async function expectGitSuccess(cwd: string, args: string[]): Promise<string> {
	const result = await runGit(cwd, args);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout;
}

async function initializeRepository(directory: string): Promise<void> {
	await expectGitSuccess(directory, ['init', '-b', 'main']);
	await expectGitSuccess(directory, [
		'config',
		'user.email',
		'test@example.com',
	]);
	await expectGitSuccess(directory, ['config', 'user.name', 'Classifier Test']);
	await fs.writeFile(path.join(directory, 'tracked.txt'), 'base\n', 'utf-8');
	await expectGitSuccess(directory, ['add', 'tracked.txt']);
	await expectGitSuccess(directory, ['commit', '-m', 'initial']);
}

function porcelainUnmergedRecord(code: string): string {
	return [
		`# branch.oid ${'a'.repeat(40)}`,
		'# branch.head main',
		`u ${code} N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict-${code}.ts`,
		'',
	].join('\0');
}

beforeEach(() => {
	tempRoot = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-git-')),
	);
});

afterEach(async () => {
	_internals.runGitCapture = originalRunGitCapture;
	_internals.activeOperations = originalActiveOperations;
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('parsePorcelainV2Snapshot', () => {
	test.each([
		'DD',
		'AU',
		'UD',
		'UA',
		'DU',
		'AA',
		'UU',
	])('records unmerged code %s', (code) => {
		const parsed = parsePorcelainV2Snapshot(porcelainUnmergedRecord(code));
		expect(parsed).not.toBeNull();
		expect(parsed?.unmergedCodes).toEqual([code]);
		expect(parsed?.unmergedPaths).toEqual([`conflict-${code}.ts`]);
		expect(parsed?.dirtyTrackedPaths).toEqual([`conflict-${code}.ts`]);
	});
});

describe('classifyPrWorkflowGitState', () => {
	function stubSnapshot(records: string[], operations: string[] = []): void {
		_internals.runGitCapture = async (_directory, args) => {
			if (args[0] === 'status') {
				return {
					ok: true,
					stdout: [
						`# branch.oid ${'a'.repeat(40)}`,
						'# branch.head main',
						...records,
						'',
					].join('\0'),
				};
			}
			if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
				return { ok: true, stdout: tempRoot };
			}
			if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
				return { ok: true, stdout: path.join(tempRoot, '.git') };
			}
			return { ok: false, stdout: '' };
		};
		_internals.activeOperations = async () => operations;
	}

	test.each([
		'merge',
		'rebase-merge',
		'rebase-apply-or-am',
		'cherry-pick',
		'revert',
		'bisect',
		'sequencer',
	])('maps operation marker %s to manual recovery', async (operation) => {
		_internals.runGitCapture = async (_directory, args) => {
			if (args[0] === 'status') {
				return {
					ok: true,
					stdout: [
						`# branch.oid ${'a'.repeat(40)}`,
						'# branch.head main',
						'',
					].join('\0'),
				};
			}
			if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
				return { ok: true, stdout: tempRoot };
			}
			if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
				return { ok: true, stdout: path.join(tempRoot, '.git') };
			}
			return { ok: false, stdout: '' };
		};
		_internals.activeOperations = async () => [operation];

		const state = await classifyPrWorkflowGitState(tempRoot);
		expect(state.kind).toBe('recovery-required');
		expect(state.code).toBe('GIT_OPERATION_IN_PROGRESS');
		expect(state.evidence.operations).toEqual([operation]);
	});

	test('reads operation markers from the linked-worktree git dir', async () => {
		const repoDir = path.join(tempRoot, 'repo');
		const worktreeDir = path.join(tempRoot, 'review-worktree');
		await fs.mkdir(repoDir, { recursive: true });
		await initializeRepository(repoDir);
		await expectGitSuccess(repoDir, ['branch', 'review-head']);
		await expectGitSuccess(repoDir, [
			'worktree',
			'add',
			worktreeDir,
			'review-head',
		]);

		const gitDir = (
			await expectGitSuccess(worktreeDir, ['rev-parse', '--absolute-git-dir'])
		).trim();
		await fs.writeFile(path.join(gitDir, 'MERGE_HEAD'), 'abc123\n', 'utf-8');

		const state = await classifyPrWorkflowGitState(worktreeDir);
		expect(state.kind).toBe('recovery-required');
		expect(state.code).toBe('GIT_OPERATION_IN_PROGRESS');
		expect(state.evidence.operations).toEqual(['merge']);
		expect(state.evidence.gitDir).toBe(gitDir);
		const [reportedRoot, expectedRoot] = await Promise.all([
			fs.stat(state.evidence.worktreeRoot ?? '', { bigint: true }),
			fs.stat(worktreeDir, { bigint: true }),
		]);
		expect(reportedRoot.dev).not.toBe(0n);
		expect(reportedRoot.ino).not.toBe(0n);
		expect({ dev: reportedRoot.dev, ino: reportedRoot.ino }).toEqual({
			dev: expectedRoot.dev,
			ino: expectedRoot.ino,
		});
	});

	test('classifies ordinary tracked and untracked dirt as stashable', async () => {
		const hash = 'a'.repeat(40);
		stubSnapshot([
			`1 .M N... 100644 100644 100644 ${hash} ${hash} tracked.ts`,
			'? new.ts',
		]);

		const state = await classifyPrWorkflowGitState(tempRoot);
		expect(state).toMatchObject({
			kind: 'stashable',
			code: 'STASHABLE_CHANGES',
			retryable: true,
		});
	});

	test('fails closed when tracked runtime state appears under .swarm', async () => {
		const hash = 'a'.repeat(40);
		stubSnapshot([
			`1 .M N... 100644 100644 100644 ${hash} ${hash} .swarm/state.json`,
		]);

		const state = await classifyPrWorkflowGitState(tempRoot);
		expect(state).toMatchObject({
			kind: 'recovery-required',
			code: 'SWARM_STATE_TRACKING_ERROR',
			retryable: false,
		});
	});

	test('fails closed for dirty submodule state', async () => {
		const hash = 'a'.repeat(40);
		stubSnapshot([
			`1 .M S.M. 160000 160000 160000 ${hash} ${hash} vendor/submodule`,
		]);

		const state = await classifyPrWorkflowGitState(tempRoot);
		expect(state).toMatchObject({
			kind: 'recovery-required',
			code: 'DIRTY_SUBMODULE',
			retryable: false,
		});
	});
});
