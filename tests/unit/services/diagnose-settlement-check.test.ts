/**
 * Issue #2268 — the "Coder Settlements" diagnose health check.
 *
 * The wedge class (a non-terminal settlement WAL whose dispatch completion
 * never arrived) used to be invisible to /swarm diagnose. These tests run
 * getDiagnoseData against a REAL temp git repo so the check is exercised
 * with genuine WAL files produced by the real delegation gate.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { getDiagnoseData } from '../../../src/services/diagnose-service';
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

const CODER_ARGS = {
	subagent_type: 'coder',
	task_id: '1.1',
	prompt:
		'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
};

describe('diagnose — Coder Settlements check (issue #2268)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		({ dir: directory, cleanup } = createSafeTestDir('diagnose-settle-2268-'));
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

	function findCheck(
		checks: Array<{ name: string; status: string; detail: string }>,
		name: string,
	) {
		return checks.find((entry) => entry.name === name);
	}

	test('passes with no settlement WALs', async () => {
		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');
		expect(check).toBeDefined();
		expect(check?.status).toBe('✅');
		expect(check?.detail).toContain('No coder settlement WALs');
	});

	test('warns on an in-flight (or wedged) in-process settlement with remediation', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'diagnose-wedge' },
			{ args: { ...CODER_ARGS } },
		);
		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');
		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('task 1.1');
		expect(check?.detail).toContain('in flight or wedged');
		expect(check?.detail).toContain('/swarm recover');
		// Warn-level: a genuinely in-flight dispatch must not fail diagnose.
		expect(check?.status).not.toBe('❌');
	});

	test('warns on a stale dead-owner settlement', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'diagnose-stale' },
			{ args: { ...CODER_ARGS } },
		);
		const deadChild = spawnSync(process.execPath, ['--version'], {
			stdin: 'ignore',
			encoding: 'utf8',
			timeout: 15_000,
			windowsHide: true,
		});
		const walPathFor = walPath(directory, '1.1');
		const wal = JSON.parse(fs.readFileSync(walPathFor, 'utf8')) as {
			processId: number;
		};
		wal.processId = deadChild.pid as number;
		fs.writeFileSync(walPathFor, JSON.stringify(wal));
		settlementInternals.liveDispatches.clear();

		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');
		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain('owner process is gone — stale');
		expect(check?.detail).toContain('/swarm recover');
	});

	test('passes when every settlement is terminal', async () => {
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'diagnose-terminal' },
			{ args: { ...CODER_ARGS } },
		);
		const { setStoredInputArgs } = await import(
			'../../../src/hooks/guardrails/stored-input-args'
		);
		setStoredInputArgs('diagnose-terminal', { ...CODER_ARGS });
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'parent', callID: 'diagnose-terminal' },
			{ state: 'completed', output: 'no changes required' },
		);
		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');
		expect(check?.status).toBe('✅');
		expect(check?.detail).toContain('all in terminal state');
	});

	test('warns with remediation when all shown settlements are terminal but the scan truncated (critic round)', async () => {
		// 201 hand-written schema-valid COMMITTED WALs: every SHOWN entry is
		// terminal, so only the truncation flag stands between this check and
		// a green ✅ that hides settlements beyond the cap.
		const settlementsDir = path.join(directory, '.swarm', 'coder-settlements');
		fs.mkdirSync(settlementsDir, { recursive: true });
		const template = {
			version: 1,
			state: 'COMMITTED',
			taskId: 'x',
			transitionId: 'coder:diagnose-cap',
			actor: 'architect',
			processId: process.pid,
			runtimeId: 'runtime-diagnose-cap',
			expectedGeneration: 0,
			accepted: false,
			testEngineerExempt: false,
			context: {
				declaredFiles: [],
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
			recordedAt: '2026-08-21T00:00:00.000Z',
		};
		for (let i = 0; i < 201; i++) {
			const taskId = `9${i}`;
			fs.writeFileSync(
				path.join(settlementsDir, `${taskId}.json`),
				JSON.stringify({ ...template, taskId }),
			);
		}
		const data = await getDiagnoseData(directory);
		const check = findCheck(data.checks, 'Coder Settlements');
		expect(check?.status).toBe('⚠️');
		expect(check?.detail).toContain(
			'All shown settlements are terminal, but the scan was truncated.',
		);
		expect(check?.detail).toContain('/swarm recover');
	});
});
