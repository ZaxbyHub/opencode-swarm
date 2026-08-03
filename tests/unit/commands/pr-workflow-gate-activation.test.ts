import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSwarmCommandHandler } from '../../../src/commands/index.js';
import {
	_test_exports,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';

let directory = '';
const GIT_TIMEOUT_MS = 30_000;

async function runGit(
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
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

async function expectGitSuccess(args: string[]): Promise<string> {
	const result = await runGit(args);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout;
}

async function initializeRepository(): Promise<void> {
	await expectGitSuccess(['init', '-b', 'main']);
	await expectGitSuccess(['config', 'user.email', 'test@example.com']);
	await expectGitSuccess(['config', 'user.name', 'Command Gate Test']);
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.writeFile(path.join(directory, 'tracked.txt'), 'base\n', 'utf-8');
	await expectGitSuccess(['add', 'tracked.txt']);
	await expectGitSuccess(['commit', '-m', 'initial']);
}

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-command-')),
	);
	_test_exports.resetTrackedStateCache();
	await initializeRepository();
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR command workflow-gate activation', () => {
	test('activates durable PR_REVIEW and PR_FEEDBACK state from command routing', async () => {
		const handler = createSwarmCommandHandler(directory, {});
		const output = { parts: [] as unknown[] };

		await handler(
			{
				command: 'swarm-pr-review',
				sessionID: 'session-a',
				arguments: 'owner/repo#42',
			},
			output,
		);
		expect(await readPrWorkflowGateState(directory, 'session-a')).toMatchObject(
			{
				mode: 'PR_REVIEW',
			},
		);

		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: 'session-b',
				arguments: 'address the review notes',
			},
			output,
		);
		expect(await readPrWorkflowGateState(directory, 'session-b')).toMatchObject(
			{
				mode: 'PR_FEEDBACK',
			},
		);
	});

	test('does not erase an active PR gate when another MODE command runs', async () => {
		const handler = createSwarmCommandHandler(directory, {});
		const output = { parts: [] as unknown[] };
		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: 'session-a',
				arguments: '',
			},
			output,
		);
		await handler(
			{
				command: 'swarm-brainstorm',
				sessionID: 'session-a',
				arguments: 'new objective',
			},
			output,
		);

		expect(await readPrWorkflowGateState(directory, 'session-a')).toMatchObject(
			{
				mode: 'PR_FEEDBACK',
			},
		);
	});

	test('binds a PR URL when an existing feedback gate is still target-unbound', async () => {
		const handler = createSwarmCommandHandler(directory, {});
		const output = { parts: [] as unknown[] };
		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: 'session-a',
				arguments: 'address the review notes',
			},
			output,
		);
		expect(
			(await readPrWorkflowGateState(directory, 'session-a'))
				?.prFeedbackTargetUrl,
		).toBeUndefined();

		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: 'session-a',
				arguments: 'https://github.com/owner/repo/pull/42',
			},
			output,
		);

		expect(await readPrWorkflowGateState(directory, 'session-a')).toMatchObject(
			{
				mode: 'PR_FEEDBACK',
				prFeedbackTargetUrl: 'https://github.com/owner/repo/pull/42',
			},
		);
	});

	test('blocks switching PR workflow modes before terminal completion', async () => {
		const handler = createSwarmCommandHandler(directory, {});
		const output = { parts: [] as unknown[] };
		await handler(
			{
				command: 'swarm-pr-review',
				sessionID: 'session-a',
				arguments: 'owner/repo#42',
			},
			output,
		);
		await handler(
			{
				command: 'swarm-pr-feedback',
				sessionID: 'session-a',
				arguments: 'owner/repo#42',
			},
			output,
		);
		expect(await readPrWorkflowGateState(directory, 'session-a')).toMatchObject(
			{
				mode: 'PR_REVIEW',
			},
		);
	});
});
