import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover';
import type { PluginConfig } from '../../../src/config';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { _internals as settlementInternals } from '../../../src/workflow/coder-settlement';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { withFrozenClockAsync } from '../../helpers/test-clock';

// Deterministic fixture instant (explicit-arg Date constructor, not a raw
// clock read — see docs/testing/test-stability.md, issue #1782).
const FIXED_NOW_ISO = new Date('2026-01-01T00:00:00.000Z').toISOString();

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
		expect(out).toContain(
			'No coder dispatch or settlement evidence was found for task 2.2',
		);
		expect(out).toContain('Known tasks: 1.1');
	});

	test('empty project with an explicit task_id reports the task-specific miss (PRR-014)', async () => {
		const out = await handleRecoverCommand(directory, ['2.2']);
		expect(out).toContain(
			'No coder dispatch or settlement evidence was found for task 2.2',
		);
		expect(out).toContain('/swarm attest 2.2');
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

	test('a real coder dispatch through toolBefore sets lastCoderDelegationTaskId via the structured writer (bot review F06)', async () => {
		// Confirms the actual mechanism the whole Stage A attribution fix
		// depends on: prepareCoderScope's success path in toolBefore is the
		// sole writer of lastCoderDelegationTaskId. Prior tests only proved
		// the OLD prompt-regex writer was removed (hand-setting the field or
		// asserting it stays null); none drove a real dispatch and asserted
		// the NEW writer actually fires.
		const session = swarmState.agentSessions.get('parent');
		expect(session?.lastCoderDelegationTaskId ?? null).toBeNull();

		await beginRealDispatch('cmd-structured-writer');

		const updated = swarmState.agentSessions.get('parent');
		expect(updated?.lastCoderDelegationTaskId).toBe('1.1');
	});

	describe('Stage A wedge repair runs even with no listable settlement WAL (F-003)', () => {
		async function writeBothGreenPreCheck(): Promise<void> {
			await saveEvidence(directory, 'secretscan', {
				task_id: 'secretscan',
				type: 'secretscan',
				timestamp: FIXED_NOW_ISO,
				agent: 'pre_check_batch',
				verdict: 'pass',
				summary: 'no secrets found',
				findings_count: 0,
				files_scanned: 10,
				skipped_files: 0,
				incomplete_files: 0,
				incomplete_paths: [],
			});
			await saveEvidence(directory, 'sast_scan', {
				task_id: 'sast_scan',
				type: 'sast',
				timestamp: FIXED_NOW_ISO,
				agent: 'pre_check_batch',
				verdict: 'pass',
				summary: 'no findings',
				findings: [],
				engine: 'tier_a',
				files_scanned: 5,
				findings_count: 0,
				findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
			});
		}

		test('a task with no settlement WAL at all is still repaired (previously reported "no settlement WALs found" and never attempted repair)', async () => {
			// Frozen so the transition's real-clock updatedAt stamp and the
			// evidence timestamps above land on the same instant (recency
			// requires evidence >= the task's last-transition time).
			await withFrozenClockAsync(
				async () => {
					await transitionTaskWorkflowEvidence(directory, '9.9', {
						type: 'accepted_mutation',
						agentType: 'coder',
						expectedGeneration: 0,
						transitionId: 'coder:setup-9.9',
					});
					await writeBothGreenPreCheck();
				},
				{ isoNow: FIXED_NOW_ISO },
			);

			const out = await handleRecoverCommand(directory, ['9.9']);

			expect(out).toContain(
				'No settlement WAL for task 9.9. Task-evidence exists',
			);
			expect(out).toContain('/swarm attest 9.9');
			expect(out).toContain('## Wedged Stage A Repair');
			expect(out).toContain('Task 9.9: Stage A repaired');
			expect(out).toContain('Repaired 1 wedged task(s)');
			const workflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '9.9'),
			);
			expect(workflow.state).toBe('pre_check_passed');
		});

		test('a task with a foreign-only settlement WAL (none matching its id) is still repaired', async () => {
			await beginRealDispatch('cmd-foreign-only');
			await withFrozenClockAsync(
				async () => {
					await transitionTaskWorkflowEvidence(directory, '9.8', {
						type: 'accepted_mutation',
						agentType: 'coder',
						expectedGeneration: 0,
						transitionId: 'coder:setup-9.8',
					});
					await writeBothGreenPreCheck();
				},
				{ isoNow: FIXED_NOW_ISO },
			);

			const out = await handleRecoverCommand(directory, ['9.8']);

			expect(out).toContain('No settlement WAL for task 9.8');
			expect(out).toContain('## Wedged Stage A Repair');
			expect(out).toContain('Task 9.8: Stage A repaired');
			const workflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '9.8'),
			);
			expect(workflow.state).toBe('pre_check_passed');
		});
	});

	describe('issue #2828 — settlement-wedge repair and refusal rendering', () => {
		function writeCommittedAcceptedWal(taskId: string): void {
			const walDir = path.join(directory, '.swarm', 'coder-settlements');
			fs.mkdirSync(walDir, { recursive: true });
			fs.writeFileSync(
				path.join(walDir, `${taskId}.json`),
				JSON.stringify({
					version: 1,
					state: 'COMMITTED',
					taskId,
					transitionId: `coder:wal-${taskId}`,
					actor: 'test',
					processId: process.pid,
					runtimeId: '00000000-0000-4000-8000-000000000000',
					expectedGeneration: 1,
					context: {
						baseline: {
							directory,
							gitHead: null,
							dirtyHash: null,
							prHeadSha: null,
							scope: null,
							changedFiles: [],
						},
						declaredFiles: ['src/feature.ts'],
					},
					accepted: true,
					recordedAt: FIXED_NOW_ISO,
				}),
			);
		}

		async function writeGreenPreCheck(): Promise<void> {
			await withFrozenClockAsync(
				async () => {
					await saveEvidence(directory, 'secretscan', {
						task_id: 'secretscan',
						type: 'secretscan',
						timestamp: FIXED_NOW_ISO,
						agent: 'pre_check_batch',
						verdict: 'pass',
						summary: 'no secrets found',
						findings_count: 0,
						files_scanned: 10,
						skipped_files: 0,
						incomplete_files: 0,
						incomplete_paths: [],
					});
					await saveEvidence(directory, 'sast_scan', {
						task_id: 'sast_scan',
						type: 'sast',
						timestamp: FIXED_NOW_ISO,
						agent: 'pre_check_batch',
						verdict: 'pass',
						summary: 'no findings',
						findings: [],
						engine: 'tier_a',
						files_scanned: 5,
						findings_count: 0,
						findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
					});
				},
				{ isoNow: FIXED_NOW_ISO },
			);
		}

		/** accepted_mutation → stage_a_passed → task_blocked (→ repair_idle). */
		async function settleAt(
			taskId: string,
			target: 'blocked' | 'idle',
		): Promise<void> {
			await withFrozenClockAsync(
				async () => {
					await transitionTaskWorkflowEvidence(directory, taskId, {
						type: 'accepted_mutation',
						agentType: 'coder',
						expectedGeneration: 0,
						transitionId: `coder:setup-${taskId}`,
					});
					await transitionTaskWorkflowEvidence(directory, taskId, {
						type: 'stage_a_passed',
						expectedGeneration: 1,
						transitionId: `pre-check:setup-${taskId}`,
					});
					await transitionTaskWorkflowEvidence(directory, taskId, {
						type: 'task_blocked',
						expectedGeneration: 1,
						transitionId: `terminal:setup-${taskId}`,
					});
					if (target === 'idle') {
						await transitionTaskWorkflowEvidence(directory, taskId, {
							type: 'repair_idle',
							expectedGeneration: 1,
							transitionId: `repair:setup-${taskId}`,
						});
					}
				},
				{ isoNow: FIXED_NOW_ISO },
			);
		}

		test('repairs the idle post-force settlement wedge and drops the dead-end line', async () => {
			await settleAt('4.1', 'idle');
			writeCommittedAcceptedWal('4.1');
			await writeGreenPreCheck();

			const out = await handleRecoverCommand(directory, ['4.1']);

			expect(out).toContain('Task 4.1: Stage A repaired');
			expect(out).toContain('Repaired 1 wedged task(s)');
			expect(out).not.toContain('nothing to repair');
			expect(out).not.toContain('No wedged tasks repaired.');
			const workflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '4.1'),
			);
			expect(workflow.state).toBe('pre_check_passed');
			expect(workflow.settlementRecovery).toBe(true);
		});

		test('repairs the blocked settlement wedge with proof present', async () => {
			await settleAt('4.2', 'blocked');
			writeCommittedAcceptedWal('4.2');
			await writeGreenPreCheck();

			const out = await handleRecoverCommand(directory, ['4.2']);

			expect(out).toContain('Task 4.2: Stage A repaired');
			const workflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '4.2'),
			);
			expect(workflow.state).toBe('pre_check_passed');
			expect(workflow.settlementRecovery).toBe(true);
		});

		test('a receipts-less idle task gets the pointed settlement-wedge refusal, not the conflated dead end', async () => {
			await settleAt('4.3', 'idle');
			await writeGreenPreCheck();

			const out = await handleRecoverCommand(directory, ['4.3']);

			expect(out).toContain('no Stage A repair is needed or provable here');
			expect(out).toContain('recover_stage_a_task');
			expect(out).toContain(
				'--force does not override Stage A wedge-classification refusals',
			);
			expect(out).toContain('No wedged tasks repaired.');
			const workflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '4.3'),
			);
			expect(workflow.state).toBe('idle');
		});
	});
});
