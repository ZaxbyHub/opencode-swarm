/**
 * The 80802e0dc recover contract, split out of recover.test.ts (FR-006
 * ratchet: the parent file crossed the 500-line cap when these pins landed).
 *
 * Background-dispatched coder rounds never write a settlement WAL; their
 * durable settlement proof is the chain-verified accepted_mutation receipt in
 * the requirements ledger. 80802e0dc made exactly that idle shape repairable,
 * and the pre-80802e0dc refusal asserted in the parent suite asserted removed
 * behavior. These two pins carry the contract: the receipt-backed repair, and
 * the proof-less refusal that must stay pointed instead of conflating into a
 * dead end.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { _internals as settlementInternals } from '../../../src/workflow/coder-settlement';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { withFrozenClockAsync } from '../../helpers/test-clock';

// Deterministic fixture instant (explicit-arg Date constructor, not a raw
// clock read — see docs/testing/test-stability.md, issue #1782).
const FIXED_NOW_ISO = new Date('2026-01-01T00:00:00.000Z').toISOString();

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

describe('issue #2268 — recover settlement contract (80802e0dc)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		({ dir: directory, cleanup } = createSafeTestDir('recover-contract-'));
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

	test('an idle task with a chain-verified accepted_mutation history repairs without a settlement WAL (the 80802e0dc contract)', async () => {
		// Background-dispatched coder rounds never write a settlement WAL;
		// their durable settlement proof is the chain-verified
		// accepted_mutation receipt in the requirements ledger. The
		// pre-80802e0dc refusal rendered here asserted removed behavior.
		await settleAt('4.3', 'idle');
		await writeGreenPreCheck();

		const out = await handleRecoverCommand(directory, ['4.3']);

		expect(out).toContain('Task 4.3: Stage A repaired');
		expect(out).toContain('Repaired 1 wedged task(s)');
		expect(out).not.toContain('no Stage A repair is needed or provable here');
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '4.3'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.settlementRecovery).toBe(true);
	});

	test('a proof-less idle task still gets the pointed settlement-wedge refusal, not the conflated dead end', async () => {
		// No settlement WAL, no accepted_mutation history, no requirements
		// receipt — nothing chain-verifiable, so the mechanical repair must
		// refuse and render the pointed remediation instead of repairing.
		await withFrozenClockAsync(
			async () => {
				await transitionTaskWorkflowEvidence(directory, '4.4', {
					type: 'task_blocked',
					expectedGeneration: 0,
					transitionId: 'terminal:setup-4.4',
				});
				await transitionTaskWorkflowEvidence(directory, '4.4', {
					type: 'repair_idle',
					expectedGeneration: 0,
					transitionId: 'repair:setup-4.4',
				});
			},
			{ isoNow: FIXED_NOW_ISO },
		);
		await writeGreenPreCheck();

		const out = await handleRecoverCommand(directory, ['4.4']);

		expect(out).toContain('no Stage A repair is needed or provable here');
		expect(out).toContain('recover_stage_a_task');
		expect(out).toContain(
			'--force does not override Stage A wedge-classification refusals',
		);
		expect(out).toContain('No wedged tasks repaired.');
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '4.4'),
		);
		expect(workflow.state).toBe('idle');
	});
});
