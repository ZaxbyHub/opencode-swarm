/**
 * Issue #2665 — deterministic repair receipts link their predecessors.
 *
 * Drives the REAL repair surfaces over a git-backed fixture: a stale
 * settlement WAL (dead owner pid) recovered by recoverStaleCoderSettlements,
 * and a wedged Stage A task repaired by repairWedgedStageA. Asserts the
 * durable events in .swarm/events.jsonl name their predecessor transitions
 * and generation fences, and that an idempotent re-run does not duplicate
 * receipts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	listCoderSettlementWalStates,
	recoverStaleCoderSettlements,
	_internals as settlementInternals,
} from '../../../src/workflow/coder-settlement';
import { repairWedgedStageA } from '../../../src/workflow/stage-a-repair';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { freezeClock } from '../../helpers/test-clock';

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

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function walPath(directory: string, taskId: string): string {
	return path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`);
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

interface CoreEvent {
	type?: string;
	action?: string;
	taskId?: string;
	transitionId?: string;
	previousTransitionId?: string;
	previousState?: string;
	expectedGeneration?: number;
	generation?: number;
	predecessorTransitionId?: string | null;
}

function readEvents(directory: string): CoreEvent[] {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	const events: CoreEvent[] = [];
	for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		try {
			const parsed = JSON.parse(trimmed) as CoreEvent;
			if (
				parsed &&
				typeof parsed === 'object' &&
				parsed.type !== 'swarm-events-manifest'
			)
				events.push(parsed);
		} catch {
			// skip torn/non-JSON lines
		}
	}
	return events;
}

describe('recovery receipts link predecessors (issue #2665)', () => {
	// Deterministic fixture instant (explicit-arg Date constructor where possible;
	// freezeClock pins the Date.now-derived fixture timestamps below so the
	// recency math in scanStageATask is reproducible under coverage runs).
	const FIXED_NOW_ISO = '2026-09-09T12:00:00.000Z';
	let restoreClock: (() => void) | null = null;
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		restoreClock = freezeClock({ isoNow: FIXED_NOW_ISO });
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		({ dir: directory, cleanup } = createSafeTestDir('receipts-2665-'));
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
		const headShaResult = spawnSync(
			'git',
			['-C', directory, 'rev-parse', 'HEAD'],
			{ encoding: 'utf8', timeout: 10_000, windowsHide: true },
		);
		const headSha = headShaResult.stdout.trim();
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
			{ id: '2.1', files: ['src/feature.ts'] },
		]);
	}, 30_000);

	afterEach(() => {
		restoreClock?.();
		restoreClock = null;
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		cleanup();
	});

	test('settlement recovery names the predecessor transition, state, and generation', async () => {
		// Real dispatch through the delegation gate, then simulate a host
		// crash: dead owner pid + no in-process registration. The real gate
		// establishes every durable fact recovery needs (the hand-written
		// WAL shape fails deep in the settle machinery).
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'receipts-stale' },
			{
				args: {
					subagent_type: 'coder',
					task_id: '1.1',
					prompt:
						'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
				},
			},
		);
		const walFile = walPath(directory, '1.1');
		const wal = JSON.parse(fs.readFileSync(walFile, 'utf8')) as {
			processId: number;
		};
		wal.processId = deadProcessId();
		fs.writeFileSync(walFile, JSON.stringify(wal));
		settlementInternals.liveDispatches.clear();
		const before = await listCoderSettlementWalStates(directory);
		expect(typeof before.states[0]?.expectedGeneration).toBe('number');

		const { results } = await recoverStaleCoderSettlements(directory);
		expect(results[0]?.outcome).toBe('recovered');

		const events = readEvents(directory).filter(
			(event) =>
				event.type === 'coder_settlement' && event.action === 'recovered',
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.previousTransitionId).toBe(
			before.states[0]?.transitionId,
		);
		expect(events[0]?.previousState).toBe('DISPATCHED');
		expect(events[0]?.expectedGeneration).toBe(
			before.states[0]?.expectedGeneration,
		);
	}, 60_000);

	test('stage A repair names the wedging accepted_mutation as predecessor and is idempotent', async () => {
		await transitionTaskWorkflowEvidence(directory, '2.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:setup-2.1',
		});
		fs.mkdirSync(path.dirname(walPath(directory, '2.1')), { recursive: true });
		fs.writeFileSync(
			walPath(directory, '2.1'),
			JSON.stringify({
				version: 1,
				state: 'COMMITTED',
				taskId: '2.1',
				transitionId: 'coder:setup-2.1',
				actor: 'test',
				processId: process.pid,
				runtimeId: 'runtime-receipts-2665',
				expectedGeneration: 1,
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
				accepted: true,
				recordedAt: new Date(Date.now() - 60_000).toISOString(),
			}),
		);
		await saveEvidence(directory, 'secretscan', {
			task_id: 'secretscan',
			type: 'secretscan',
			timestamp: new Date().toISOString(),
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
			timestamp: new Date().toISOString(),
			agent: 'pre_check_batch',
			verdict: 'pass',
			summary: 'no findings',
			findings: [],
			engine: 'tier_a',
			files_scanned: 5,
			findings_count: 0,
			findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
		});

		const { results } = await repairWedgedStageA(directory);
		expect(results[0]).toEqual({
			taskId: '2.1',
			outcome: 'repaired',
			generation: 1,
			transitionId: 'stage-a-repair:2.1:1',
		});

		const repaired = readEvents(directory).filter(
			(event) => event.type === 'stage_a_repair' && event.action === 'repaired',
		);
		expect(repaired).toHaveLength(1);
		expect(repaired[0]?.predecessorTransitionId).toBe('coder:setup-2.1');
		expect(repaired[0]?.generation).toBe(1);

		// Idempotent: the second run finds nothing wedged and emits no new
		// receipt.
		const second = await repairWedgedStageA(directory);
		expect(second.results[0]?.outcome).toBe('skipped_not_wedged');
		expect(
			readEvents(directory).filter(
				(event) =>
					event.type === 'stage_a_repair' && event.action === 'repaired',
			),
		).toHaveLength(1);

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.1'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.lastTransitionId).toBe('stage-a-repair:2.1:1');
	}, 60_000);
});
