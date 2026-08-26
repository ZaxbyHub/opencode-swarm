import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { resetSwarmArtifactCache } from '../../../src/utils/swarm-artifact-cache';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * #2039: the events store lock is now the seam-owned `.swarm/events.lock`
 * (`openSync` wx create, stale-broken after 5 minutes). The former
 * per-module `tryAcquireLock(..., 'events.jsonl', ...)` proper-lockfile
 * calls are gone, so contention is simulated by creating the lock file
 * directly and removing it to release.
 */
function holdStoreLock(dir: string): void {
	const lockPath = path.join(dir, '.swarm', 'events.lock');
	const fd = fs.openSync(lockPath, 'wx');
	fs.closeSync(fd);
}

function releaseStoreLock(dir: string): void {
	fs.rmSync(path.join(dir, '.swarm', 'events.lock'), { force: true });
}

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

const TASK_ID = '1.1';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function writeFile(directory: string, file: string, content: string): void {
	const absolute = path.join(directory, file);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content);
}

function repairArgs(overrides: Record<string, unknown> = {}) {
	return {
		task_id: TASK_ID,
		status: 'in_progress',
		force: true,
		expected_state: 'tests_run',
		expected_generation: 3,
		target_state: 'idle' as const,
		reason: 'Reviewer found a post-completion defect',
		transition_id: 'repair-1.1-generation-3',
		...overrides,
	};
}

describe('issue #2098 FB-001 delegation-gate task-repair recovery degrades instead of crashing toolBefore', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('dg-repair-audit-2098-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		writeFile(directory, 'src/feature.ts', 'export const feature = 1;\n');
		git(directory, ['add', 'src/feature.ts']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		await writeApprovedPlan(directory, [
			{ id: TASK_ID, files: ['src/feature.ts'], status: 'completed' },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = TASK_ID;

		// Seed evidence at the workflow state the repair args expect, matching
		// the seedSettledRepairState helper used by the sibling task-repair
		// resilience suite (tests/unit/workflow/task-repair-audit-resilience-2098.test.ts).
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(path.join(swarmDir, 'evidence'), { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'evidence', `${TASK_ID}.json`),
			JSON.stringify(
				{
					taskId: TASK_ID,
					required_gates: ['reviewer', 'test_engineer'],
					gates: {
						pre_check: {
							sessionId: 'system',
							timestamp: '2026-01-01T00:00:00Z',
							agent: 'pre_check',
						},
						reviewer: {
							sessionId: 'review',
							timestamp: '2026-01-01T00:00:01Z',
							agent: 'reviewer',
						},
						test_engineer: {
							sessionId: 'test',
							timestamp: '2026-01-01T00:00:02Z',
							agent: 'test_engineer',
						},
					},
					workflow: {
						schema: 'exact-task-v1',
						state: 'tests_run',
						generation: 3,
						retryCount: 0,
						lastOutcome: 'stage_b_completed',
						updatedAt: '2026-01-01T00:00:02Z',
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('toolBefore returns normally when the lazy task-repair recovery hits TASK_REPAIR_AUDIT_LOCKED', async () => {
		const swarmDir = path.join(directory, '.swarm');
		const eventsPath = path.join(swarmDir, 'events.jsonl');
		fs.mkdirSync(swarmDir, { recursive: true });
		if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, '');

		// Produce a COMMITTED-but-unaudited repair WAL: hold the events store
		// lock externally while the repair commits, so ensureAuditEvent's
		// seam append fails with CORE_EVENT_STORE_LOCKED (mapped to
		// TASK_REPAIR_AUDIT_LOCKED by task-repair.ts) and the WAL is left
		// COMMITTED with no corresponding audit event on disk. Same technique
		// as the sibling test 'retrying after an audit-event lock failure...'
		// in tests/unit/workflow/task-repair-audit-resilience-2098.test.ts.
		holdStoreLock(directory);

		const failed = await executeUpdateTaskStatus(repairArgs(), directory, {
			sessionID: 'repair-caller',
		} as never);
		expect(failed.success).toBe(false);

		releaseStoreLock(directory);

		const walPath = path.join(swarmDir, 'task-repairs', `${TASK_ID}.json`);
		const wal = JSON.parse(fs.readFileSync(walPath, 'utf-8')) as {
			state: string;
		};
		expect(wal.state).toBe('COMMITTED');
		expect(fs.readFileSync(eventsPath, 'utf-8')).not.toContain(
			'task_workflow_repaired',
		);

		// Now hold the lock again to simulate transient contention during the
		// NEXT, unrelated tool call's lazy recovery attempt (delegation-gate's
		// toolBefore calls recoverPreparedTaskRepair opportunistically on every
		// tool call touching this task while the COMMITTED WAL sits on disk).
		holdStoreLock(directory);

		try {
			const hook = createDelegationGateHook(config, directory);
			const args = {
				subagent_type: 'coder',
				task_id: TASK_ID,
				prompt:
					'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
			};

			// Pre-fix: recoverPreparedTaskRepair was awaited unguarded here, so
			// the TASK_REPAIR_AUDIT_LOCKED throw from ensureAuditEvent would
			// propagate out of toolBefore uncaught, hard-crashing the hook for
			// every subsequent tool call touching this task. Post-fix: the
			// try/catch swallows it, logs a warning, and toolBefore resolves.
			await expect(
				hook.toolBefore(
					{ tool: 'Task', sessionID: 'parent', callID: 'repair-recovery-1' },
					{ args },
				),
			).resolves.toBeUndefined();
		} finally {
			releaseStoreLock(directory);
		}
	});
});
