/**
 * Issue #3564 — route-invalidation marker retirement ownership. Selector
 * groups: 'legacy-site' (fault-injection per retirement site),
 * 'capacity-message' (capacity refusal distinguishes leaked vs live),
 * default (leak classes, interleaving, sweep/observer discharge, lifecycle).
 * Harness: real createDelegationGateHook toolBefore/toolAfter (3509-suite
 * shape). Env contract: createIsolatedTestEnv() takes NO callback — capture
 * the returned env and clean up in finally.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { $ } from 'bun';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import { workflowGateStatePath } from '../../../src/pr-review/persistence';
import {
	recordRouteFault,
	_test_exports as registryTest,
	retireRouteInvalidationsForCall,
} from '../../../src/review/route-invalidation-registry';
import {
	advanceTaskState,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const SESSION = 'sess-3564-own';

const makeConfig = (background: boolean): PluginConfig =>
	({
		hooks: {
			delegation_gate: true,
			...(background ? { background_subagents: true } : {}),
		},
	}) as unknown as PluginConfig;

const writePlan = (dir: string, taskIds: string[]): void => {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'ownership 3564',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: taskIds.map((id) => ({
						id,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Exercise the gate',
						depends: [],
						files_touched: ['src/foo.ts'],
					})),
				},
			],
		}),
	);
};

const gitSeed = async (dir: string): Promise<void> => {
	fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
	await $`git -C ${dir} init -q`.quiet();
	await $`git -C ${dir} config user.email t@local`.quiet();
	await $`git -C ${dir} config user.name t`.quiet();
	await $`git -C ${dir} add .`.quiet();
	await $`git -C ${dir} commit -q -m seed`.quiet();
	fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n.swarm/\n');
};

interface Leg {
	directory: string;
	cleanup: () => void;
}

const newLeg = async (taskIds: string[], git = false): Promise<Leg> => {
	registryTest.reset();
	resetSwarmState();
	const directory = canonicalMkdtemp('own-3564-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	writePlan(directory, taskIds);
	if (git) await gitSeed(directory);
	ensureAgentSession(SESSION, 'architect', directory);
	return {
		directory,
		cleanup: () => {
			registryTest.reset();
			resetSwarmState();
			try {
				closeAllProjectDbs();
			} catch {
				/* best-effort teardown */
			}
			removeTreeWithRetry(directory);
		},
	};
};

const prepareTask = async (dir: string, taskId: string): Promise<void> => {
	await transitionTaskWorkflowEvidence(dir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:${taskId}`,
	});
	await transitionTaskWorkflowEvidence(dir, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a:${taskId}`,
	});
	const session = swarmState.agentSessions.get(SESSION)!;
	advanceTaskState(session, taskId, 'coder_delegated');
	advanceTaskState(session, taskId, 'pre_check_passed');
};

const reviewerArgs = (taskId: string) => ({
	subagent_type: 'reviewer',
	prompt: `TASK: ${taskId} review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement`,
});

const reviewed = (taskId: string) =>
	`[REVIEWED] | task-${taskId} | APPROVED | settlement fixture`;

const corruptGateState = (dir: string): void => {
	fs.mkdirSync(workflowGateStatePath(dir, SESSION), { recursive: true });
};

const runningOutput = (id: string) => ({
	state: 'running',
	output: `<task id="${id}" state="running">Background task started</task>`,
	metadata: { background: true, jobId: `job-${id}` },
});

const assertZeroResidue = (dir: string): void => {
	expect(registryTest.size()).toBe(0);
	expect(registryTest.sessionCount(dir)).toBe(0);
};

const before = async (
	hook: ReturnType<typeof createDelegationGateHook>,
	callID: string,
	args: Record<string, unknown>,
): Promise<void> => {
	await hook.toolBefore({ tool: 'Task', sessionID: SESSION, callID }, { args });
};

const settle = async (
	hook: ReturnType<typeof createDelegationGateHook>,
	callID: string,
	args: Record<string, unknown>,
	output: unknown,
): Promise<void> => {
	await hook.toolAfter(
		{ tool: 'tool.execute.Task', sessionID: SESSION, callID, args },
		output,
	);
};

afterEach(() => {
	registryTest.reset();
});

describe('structural retirement ownership — leak classes and interleaving', () => {
	it('class (a) correlation-store failure retires via the toolAfter finally', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg(['1.1'], true);
			const orig = _internals.recordPendingDelegationForBackground;
			try {
				const hook = createDelegationGateHook(makeConfig(true), leg.directory);
				expect(recordRouteFault(leg.directory, SESSION, 'call-a')).toBe(true);
				_internals.recordPendingDelegationForBackground = (async () => {
					throw new Error('CORRELATION_STORE_FAULT');
				}) as never;
				await settle(
					hook,
					'call-a',
					reviewerArgs('1.1'),
					runningOutput('bg-a'),
				);
				assertZeroResidue(leg.directory);
			} finally {
				_internals.recordPendingDelegationForBackground = orig;
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('class (b) unparseable running placeholder retires via the toolAfter finally', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg(['1.1'], true);
			try {
				const hook = createDelegationGateHook(makeConfig(true), leg.directory);
				expect(recordRouteFault(leg.directory, SESSION, 'call-b')).toBe(true);
				await settle(hook, 'call-b', reviewerArgs('1.1'), {
					state: 'running',
					metadata: { background: true },
				});
				assertZeroResidue(leg.directory);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('class (c) empty-sessionID early return retires via the toolAfter finally', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg(['1.1']);
			try {
				const hook = createDelegationGateHook(makeConfig(false), leg.directory);
				expect(recordRouteFault(leg.directory, SESSION, 'call-c')).toBe(true);
				await hook.toolAfter(
					{
						tool: 'tool.execute.Task',
						sessionID: '',
						callID: 'call-c',
						args: reviewerArgs('1.1'),
					},
					{ text: reviewed('1.1') },
				);
				assertZeroResidue(leg.directory);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('stale-sweep/late-toolAfter interleaving retires via the toolAfter finally (real toolBefore record)', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg(['1.1']);
			try {
				await prepareTask(leg.directory, '1.1');
				const hook = createDelegationGateHook(makeConfig(false), leg.directory);
				await before(hook, 'call-sweep-h', reviewerArgs('1.1'));
				corruptGateState(leg.directory);
				await before(hook, 'call-sweep', reviewerArgs('1.1'));
				expect(
					_internals.routeInvalidationProbe?.('call-sweep', SESSION, '1.1'),
				).toBe(true);
				swarmState.agentSessions.delete(SESSION);
				await settle(hook, 'call-sweep', reviewerArgs('1.1'), {
					text: reviewed('1.1'),
				});
				assertZeroResidue(leg.directory);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('clean settlement control: a settled call retires exactly once', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg(['1.1']);
			try {
				await prepareTask(leg.directory, '1.1');
				const hook = createDelegationGateHook(makeConfig(false), leg.directory);
				await before(hook, 'call-ctrl-h', reviewerArgs('1.1'));
				corruptGateState(leg.directory);
				await before(hook, 'call-ctrl', reviewerArgs('1.1'));
				await settle(hook, 'call-ctrl', reviewerArgs('1.1'), {
					text: reviewed('1.1'),
				});
				assertZeroResidue(leg.directory);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});
});

describe('legacy-site fault injection', () => {
	it('generic cleanup site: epic-residue seam throw still retires the marker', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg(['1.1']);
			const origSentinel = _internals.epicSentinelExists;
			const origResidue = _internals.commitEpicResidueAfterDelegation;
			try {
				await prepareTask(leg.directory, '1.1');
				const hook = createDelegationGateHook(makeConfig(false), leg.directory);
				await before(hook, 'call-l2-h', reviewerArgs('1.1'));
				corruptGateState(leg.directory);
				await before(hook, 'call-l2', reviewerArgs('1.1'));
				_internals.epicSentinelExists = (() => true) as never;
				_internals.commitEpicResidueAfterDelegation = (async () => {
					throw new Error('EPIC_RESIDUE_FAULT');
				}) as never;
				await expect(
					settle(hook, 'call-l2', reviewerArgs('1.1'), {
						status: 'failed',
						text: 'reviewer dispatch failed',
					}),
				).rejects.toThrow('EPIC_RESIDUE_FAULT');
				assertZeroResidue(leg.directory);
			} finally {
				_internals.epicSentinelExists = origSentinel;
				_internals.commitEpicResidueAfterDelegation = origResidue;
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('no-correlation early-return site: reservation-release seam throw still retires', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg(['1.1'], true);
			const orig = _internals.releaseBackgroundCoderReservationForDispatch;
			try {
				await writeApprovedPlan(leg.directory, [
					{ id: '1.1', files: ['src/feature.ts'] },
				]);
				const session = swarmState.agentSessions.get(SESSION)!;
				session.currentTaskId = '1.1';
				session.lastCoderDelegationTaskId = '1.1';
				const hook = createDelegationGateHook(
					{
						hooks: { delegation_gate: true, background_subagents: true },
						worktree: { policy: 'disabled' },
					} as never,
					leg.directory,
				);
				const args = {
					subagent_type: 'coder',
					background: true,
					task_id: '1.1',
					prompt:
						'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and tested',
				};
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: 'call-l3' },
					{ args },
				);
				expect(recordRouteFault(leg.directory, SESSION, 'call-l3')).toBe(true);
				let fired = 0;
				_internals.releaseBackgroundCoderReservationForDispatch = (async () => {
					fired += 1;
					throw new Error('RESERVATION_RELEASE_FAULT');
				}) as never;
				await settle(hook, 'call-l3', args, {
					text: 'coder dispatch returned no envelope',
				});
				expect(fired).toBeGreaterThan(0);
				assertZeroResidue(leg.directory);
			} finally {
				_internals.releaseBackgroundCoderReservationForDispatch = orig;
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});
});

describe('capacity-message', () => {
	it('distinguishes leaked-terminal-call occupancy from live-call occupancy', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg(['1.1']);
			try {
				await prepareTask(leg.directory, '1.1');
				const hook = createDelegationGateHook(makeConfig(false), leg.directory);
				await before(hook, 'call-cap-h', reviewerArgs('1.1'));
				for (let i = 0; i < 256; i++) {
					expect(
						recordRouteFault(leg.directory, SESSION, `call-fill-${i}`),
					).toBe(true);
				}
				corruptGateState(leg.directory);
				let message = '';
				try {
					await before(hook, 'call-cap', reviewerArgs('1.1'));
					throw new Error('capacity refusal did not fire');
				} catch (err) {
					message = err instanceof Error ? err.message : String(err);
				}
				expect(message).toContain('ROUTE_INVALIDATION_CAPACITY');
				expect(message).toContain('LEAKED');
				expect(message).toMatch(/already ended/);
				expect(message).toMatch(/restart the plugin/);
				expect(message).toMatch(/\/swarm close/);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});
});

describe('registry obligation lifecycle', () => {
	it('reset clears obligations with the registry (the /swarm close remedy)', () => {
		expect(recordRouteFault('/tmp/own-3564-x', SESSION, 'call-r')).toBe(true);
		expect(
			registryTest.hasObligation('/tmp/own-3564-x', SESSION, 'call-r'),
		).toBe(true);
		registryTest.reset();
		expect(registryTest.size()).toBe(0);
		expect(
			registryTest.hasObligation('/tmp/own-3564-x', SESSION, 'call-r'),
		).toBe(false);
	});

	it('double retirement is idempotent and prunes empty containers', () => {
		const dir = '/tmp/own-3564-y';
		expect(recordRouteFault(dir, SESSION, 'call-d')).toBe(true);
		retireRouteInvalidationsForCall(dir, SESSION, 'call-d');
		expect(registryTest.sessionCount(dir)).toBe(0);
		expect(() =>
			retireRouteInvalidationsForCall(dir, SESSION, 'call-d'),
		).not.toThrow();
		expect(registryTest.hasObligation(dir, SESSION, 'call-d')).toBe(false);
	});
});
