import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { _internals as settlementInternals } from '../../../src/workflow/coder-settlement';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
}

function walPath(directory: string, taskId: string): string {
	return path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`);
}

function readWalState(directory: string, taskId: string): string {
	return (
		JSON.parse(fs.readFileSync(walPath(directory, taskId), 'utf8')) as {
			state: string;
		}
	).state;
}

function rewriteWalProcessId(
	directory: string,
	taskId: string,
	processId: number,
): void {
	const walPathFor = walPath(directory, taskId);
	const wal = JSON.parse(fs.readFileSync(walPathFor, 'utf8')) as {
		processId: number;
	};
	wal.processId = processId;
	fs.writeFileSync(walPathFor, JSON.stringify(wal));
}

function deadProcessId(): number {
	const result = spawnSync(process.execPath, ['--version'], {
		stdin: 'ignore',
		encoding: 'utf8',
		timeout: 15_000,
		windowsHide: true,
	});
	if (result.pid === undefined) throw new Error('no pid from helper child');
	return result.pid;
}

const CODER_ARGS = {
	subagent_type: 'coder',
	task_id: '1.1',
	prompt:
		'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
};

describe('issue #2268 — /swarm recover command', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		({ dir: directory, cleanup } = createSafeTestDir('recover-cmd-2268-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		git(directory, ['add', '.']);
		git(directory, ['commit', '-m', 'seed']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
	});

	afterEach(() => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		cleanup();
	});

	async function beginRealDispatch(callID: string): Promise<void> {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID },
			{ args: { ...CODER_ARGS } },
		);
	}

	test('clean project reports nothing to recover', async () => {
		const out = await handleRecoverCommand(directory, []);
		expect(out).toContain('## Coder Settlement Recovery');
		expect(out).toContain('No coder settlement WALs found');
	});

	test('same-process wedge: default reports the in-flight registration and remediation', async () => {
		await beginRealDispatch('cmd-inproc');
		const out = await handleRecoverCommand(directory, []);
		expect(out).toContain('still registered as in flight');
		expect(out).toContain('re-run with --force');
		expect(out).toContain('coder:cmd-inproc');
		expect(readWalState(directory, '1.1')).toBe('DISPATCHED');
	});

	test('same-process wedge: --force recovers and prints the late-completion warning', async () => {
		await beginRealDispatch('cmd-force');
		const out = await handleRecoverCommand(directory, ['--force']);
		expect(out).toContain('Task 1.1: settlement recovered');
		expect(out).toContain('in-process ownership released by --force');
		expect(out).toContain('CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT');
		expect(readWalState(directory, '1.1')).toBe('COMMITTED');
	});

	test('host-crash wedge (dead pid) recovers in safe mode', async () => {
		await beginRealDispatch('cmd-crash');
		rewriteWalProcessId(directory, '1.1', deadProcessId());
		settlementInternals.liveDispatches.clear();
		const out = await handleRecoverCommand(directory, []);
		expect(out).toContain('Task 1.1: settlement recovered');
		expect(readWalState(directory, '1.1')).toBe('COMMITTED');
	});

	test('foreign live pid is reported, never interrupted, even with --force', async () => {
		await beginRealDispatch('cmd-foreign');
		rewriteWalProcessId(directory, '1.1', process.ppid);
		settlementInternals.liveDispatches.clear();
		for (const args of [[], ['--force']]) {
			const out = await handleRecoverCommand(directory, args);
			expect(out).toContain('owned by live process pid');
			expect(out).toContain('another OpenCode instance');
		}
		expect(readWalState(directory, '1.1')).toBe('DISPATCHED');
	});

	test('unknown task id lists known tasks', async () => {
		await beginRealDispatch('cmd-known');
		const out = await handleRecoverCommand(directory, ['2.2']);
		expect(out).toContain('No settlement WAL for task 2.2');
		expect(out).toContain('Known tasks: 1.1');
	});

	test('empty project with an explicit task_id reports the task-specific miss (PRR-014)', async () => {
		const out = await handleRecoverCommand(directory, ['2.2']);
		expect(out).toContain('No settlement WAL for task 2.2');
		expect(out).toContain(
			'no settlement WALs found in .swarm/coder-settlements/',
		);
	});

	test('hostile WAL transitionId is sanitized in rendered output (PRR-001)', async () => {
		await beginRealDispatch('evil\u0000inject\nline2');
		const out = await handleRecoverCommand(directory, []);
		expect(out).toContain('still registered as in flight');
		// The raw NUL/newline payload must never reach the chat surface; the
		// sanitizer collapses control characters to '?'.
		expect(out).not.toContain('evil\u0000');
		expect(out).toContain('coder:evil?inject?line2');
	});

	test('scan-cap truncation is surfaced to the operator (PRR-011)', async () => {
		const settlementsDir = path.join(directory, '.swarm', 'coder-settlements');
		fs.mkdirSync(settlementsDir, { recursive: true });
		// Pattern-matching but unparseable files still count toward the cap and
		// surface as unreadable entries — the cheapest realistic >200 fixture.
		for (let i = 0; i < 201; i++) {
			fs.writeFileSync(path.join(settlementsDir, `9${i}.json`), 'not json');
		}
		const out = await handleRecoverCommand(directory, []);
		expect(out).toContain('WAL is unreadable');
		expect(out).toContain('scan cap (200)');
		expect(out).toContain('NOT listed or processed');
	});

	test('extra positional arguments print usage', async () => {
		const out = await handleRecoverCommand(directory, ['1.1', '2.2']);
		expect(out).toContain('Unexpected arguments');
		expect(out).toContain('Usage: /swarm recover [task_id] [--force]');
	});

	test('single task_id scope recovers only that task', async () => {
		await beginRealDispatch('cmd-scope');
		const out = await handleRecoverCommand(directory, ['1.1', '--force']);
		expect(out).toContain('Task 1.1: settlement recovered');
		expect(out).not.toContain('Task 2.2');
	});
});
