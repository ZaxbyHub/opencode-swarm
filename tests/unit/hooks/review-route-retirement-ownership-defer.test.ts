/**
 * Issue #3564 — observer-deferred marker ownership (FR-006 sibling of
 * review-route-retirement-ownership.test.ts): every DURABLE, LIVE,
 * GATE-BEARING, observer-CONSUMABLE record class defers its route-invalidation
 * marker retirement to the completion observer; terminal/non-consumable
 * classes and the subagents-disabled trap flush at toolAfter instead.
 * Plan-critic round-2 matrix (fallback persistence, completed-awaiting-
 * ingestion, retryable ingestion_error included).
 */
import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { $ } from 'bun';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	recordPendingDelegation,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import {
	isRouteBlockedForSettlement,
	recordRouteFault,
	_test_exports as registryTest,
} from '../../../src/review/route-invalidation-registry';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const SESSION = 'sess-3564-defer';

const makeConfig = (background: boolean): PluginConfig =>
	({
		hooks: {
			delegation_gate: true,
			...(background ? { background_subagents: true } : {}),
		},
	}) as unknown as PluginConfig;

const newLeg = async (): Promise<{
	directory: string;
	cleanup: () => void;
}> => {
	registryTest.reset();
	resetSwarmState();
	const directory = canonicalMkdtemp('defer-3564-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'defer 3564',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Exercise the gate',
							depends: [],
							files_touched: ['src/foo.ts'],
						},
					],
				},
			],
		}),
	);
	await $`git -C ${directory} init -q`.quiet().catch(() => {});
	ensureAgentSession(SESSION, 'architect', directory);
	return {
		directory,
		cleanup: () => {
			registryTest.reset();
			resetSwarmState();
			try {
				closeAllProjectDbs();
			} catch {
				/* best-effort */
			}
			removeTreeWithRetry(directory);
		},
	};
};

const reviewerArgs = {
	subagent_type: 'reviewer',
	prompt:
		'TASK: 1.1 review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement',
};

const runningOutput = (id: string) => ({
	state: 'running',
	output: `<task id="${id}" state="running">Background task started</task>`,
	metadata: { background: true, jobId: `job-${id}` },
});

/** A durable pending-delegation record with the given status/evidenceTaskId. */
const durableRecord = (status: string, evidenceTaskId: string | null) =>
	({
		status,
		evidenceTaskId,
		parentSessionId: SESSION,
		callID: 'call-defer',
		normalizedAgent: 'reviewer',
	}) as never;

const deferMatrix: Array<{
	name: string;
	primary: string;
	record: unknown;
	fallback?: unknown;
	shouldDefer: boolean;
}> = [
	{
		name: 'recorded pending gate-bearing defers',
		primary: 'recorded',
		record: durableRecord('pending', '1.1'),
		shouldDefer: true,
	},
	{
		name: 'duplicate completed awaiting ingestion defers',
		primary: 'duplicate',
		record: durableRecord('completed', '1.1'),
		shouldDefer: true,
	},
	{
		name: 'duplicate retryable ingestion_error defers',
		primary: 'duplicate',
		record: durableRecord('ingestion_error', '1.1'),
		shouldDefer: true,
	},
	{
		name: 'duplicate stale does NOT defer (flush at toolAfter)',
		primary: 'duplicate',
		record: durableRecord('stale', '1.1'),
		shouldDefer: false,
	},
	{
		name: 'duplicate error does NOT defer',
		primary: 'duplicate',
		record: durableRecord('error', '1.1'),
		shouldDefer: false,
	},
	{
		name: 'null-evidenceTaskId (not gate-bearing) does NOT defer',
		primary: 'duplicate',
		record: durableRecord('pending', null),
		shouldDefer: false,
	},
	{
		name: 'failed primary with durable fallback defers',
		primary: 'failed',
		record: null,
		fallback: durableRecord('pending', '1.1'),
		shouldDefer: true,
	},
	{
		name: 'failed primary with NULL-evidence fallback does NOT defer (not observer-settleable)',
		primary: 'failed',
		record: null,
		fallback: durableRecord('pending', null),
		shouldDefer: false,
	},
];

describe('observer-deferred ownership — consumable record classes defer, terminal classes flush', () => {
	for (const row of deferMatrix) {
		it(row.name, async () => {
			const env = createIsolatedTestEnv();
			try {
				const leg = await newLeg();
				const origRecord = _internals.recordPendingDelegationForBackground;
				const origFallback = _internals.writeDelegationFallbackForBackground;
				try {
					const hook = createDelegationGateHook(
						makeConfig(true),
						leg.directory,
					);
					expect(recordRouteFault(leg.directory, SESSION, 'call-defer')).toBe(
						true,
					);
					_internals.recordPendingDelegationForBackground = (async () => ({
						status: row.primary,
						record: row.record,
					})) as never;
					// The production seam returns the fallback ARTIFACT
					// ({schemaVersion, correlationId, createdAt, record}), and the
					// ownership predicate reads artifact.record — wrap the row's
					// record so the seam stays shape-faithful.
					_internals.writeDelegationFallbackForBackground = (async () =>
						row.fallback
							? {
									schemaVersion: 1 as const,
									correlationId: 'corr-defer',
									createdAt: 1,
									record: row.fallback,
								}
							: null) as never;
					await hook.toolAfter(
						{
							tool: 'tool.execute.Task',
							sessionID: SESSION,
							callID: 'call-defer',
							args: reviewerArgs,
						},
						runningOutput('bg-defer'),
					);
					if (row.shouldDefer) {
						expect(
							isRouteBlockedForSettlement(
								leg.directory,
								'call-defer',
								SESSION,
								'1.1',
							),
						).toBe(true);
						expect(registryTest.sessionCount(leg.directory)).toBe(1);
					} else {
						expect(registryTest.size()).toBe(0);
						expect(registryTest.sessionCount(leg.directory)).toBe(0);
					}
				} finally {
					_internals.recordPendingDelegationForBackground = origRecord;
					_internals.writeDelegationFallbackForBackground = origFallback;
					leg.cleanup();
				}
			} finally {
				env.cleanup();
			}
		});
	}

	it('two overlapping deferring toolAfter calls each keep their own defer (concurrency)', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg();
			const origRecord = _internals.recordPendingDelegationForBackground;
			try {
				const hook = createDelegationGateHook(
					{
						hooks: { delegation_gate: true, background_subagents: true },
						worktree: { policy: 'disabled' },
					} as never,
					leg.directory,
				);
				expect(recordRouteFault(leg.directory, SESSION, 'call-ov-a')).toBe(
					true,
				);
				expect(recordRouteFault(leg.directory, SESSION, 'call-ov-b')).toBe(
					true,
				);
				// Controlled suspension for call A (released after B completes).
				let resolveA!: () => void;
				const suspendA = new Promise<void>((r) => {
					resolveA = r;
				});
				_internals.recordPendingDelegationForBackground = (async () => ({
					status: 'recorded',
					record: durableRecord('pending', '1.1'),
				})) as never;
				// Call A is a background CODER dispatch (holds a reservation, so it
				// reaches the AWAITED bindBackgroundCoderReservationForDispatch
				// seam AFTER the defer decision); that seam suspends A there while
				// call B (a reviewer) runs to completion and also defers. With
				// single-slot defer semantics B's set overwrites A's signal and
				// A's finally flushes A's observer-owned marker early; the
				// per-call set keeps both.
				const origBind = _internals.bindBackgroundCoderReservationForDispatch;
				_internals.bindBackgroundCoderReservationForDispatch = (async () => {
					await suspendA;
					return { bound: true } as never;
				}) as never;
				await writeApprovedPlan(leg.directory, [
					{ id: '1.1', files: ['src/foo.ts'] },
				]);
				const sessionOv = swarmState.agentSessions.get(SESSION)!;
				sessionOv.currentTaskId = '1.1';
				sessionOv.lastCoderDelegationTaskId = '1.1';
				const coderArgs = {
					subagent_type: 'coder',
					background: true,
					task_id: '1.1',
					prompt:
						'TASK: 1.1\nFILE: src/foo.ts\nACCEPTANCE: feature is implemented and tested',
				};
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: 'call-ov-a' },
					{ args: coderArgs },
				);
				const a = hook.toolAfter(
					{
						tool: 'tool.execute.Task',
						sessionID: SESSION,
						callID: 'call-ov-a',
						args: coderArgs,
					},
					runningOutput('bg-ov-a'),
				);
				// give A time to defer and reach the suspended bind seam
				await new Promise((resolve) => setTimeout(resolve, 80));
				const reviewerArgsOv = {
					subagent_type: 'reviewer',
					prompt:
						'TASK: 1.1 review the change ACCEPTANCE: FR-001 the diff satisfies the requirement',
				};
				const b = hook.toolAfter(
					{
						tool: 'tool.execute.Task',
						sessionID: SESSION,
						callID: 'call-ov-b',
						args: reviewerArgsOv,
					},
					runningOutput('bg-ov-b'),
				);
				await b;
				_internals.bindBackgroundCoderReservationForDispatch = origBind;
				expect(
					registryTest.hasObligation(leg.directory, SESSION, 'call-ov-b'),
				).toBe(true);
				// release A; its defer must SURVIVE B's completed finally
				resolveA();
				await a;
				expect(
					registryTest.hasObligation(leg.directory, SESSION, 'call-ov-a'),
				).toBe(true);
				expect(registryTest.size()).toBe(1);
				expect(registryTest.sessionCount(leg.directory)).toBe(1);
			} finally {
				_internals.recordPendingDelegationForBackground = origRecord;
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('background subagents disabled: running output never defers (no observer record exists)', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg();
			try {
				const hook = createDelegationGateHook(makeConfig(false), leg.directory);
				expect(recordRouteFault(leg.directory, SESSION, 'call-nobg')).toBe(
					true,
				);
				await hook.toolAfter(
					{
						tool: 'tool.execute.Task',
						sessionID: SESSION,
						callID: 'call-nobg',
						args: reviewerArgs,
					},
					runningOutput('bg-n'),
				);
				expect(registryTest.size()).toBe(0);
				expect(registryTest.sessionCount(leg.directory)).toBe(0);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});
});

describe('sweep and observer discharge', () => {
	it('the pending-record stale sweep discharges the swept call obligation', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg();
			try {
				await recordPendingDelegation(leg.directory, {
					correlationId: 'child-sweep',
					jobId: 'job-sweep',
					subagentSessionId: 'child-sweep',
					parentSessionId: SESSION,
					callID: 'call-sw',
					normalizedAgent: 'reviewer',
					swarmPrefixedAgent: 'reviewer',
					planTaskId: null,
					evidenceTaskId: null,
				});
				expect(recordRouteFault(leg.directory, SESSION, 'call-sw')).toBe(true);
				expect(
					registryTest.hasObligation(leg.directory, SESSION, 'call-sw'),
				).toBe(true);
				await new Promise((resolve) => setTimeout(resolve, 15));
				const swept = await sweepStaleDelegations(leg.directory, 1);
				expect(swept).toBe(1);
				expect(registryTest.size()).toBe(0);
				expect(registryTest.sessionCount(leg.directory)).toBe(0);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('the completion observer terminal arm flushes the obligation at arm entry', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg();
			try {
				await recordPendingDelegation(leg.directory, {
					correlationId: 'child-err',
					jobId: 'job-err',
					subagentSessionId: 'child-err',
					parentSessionId: SESSION,
					callID: 'call-err',
					normalizedAgent: 'reviewer',
					swarmPrefixedAgent: 'reviewer',
					planTaskId: null,
					evidenceTaskId: null,
				});
				expect(recordRouteFault(leg.directory, SESSION, 'call-err')).toBe(true);
				const observer = createBackgroundCompletionObserver({
					config: { enabled: true },
					directory: leg.directory,
				});
				await observer.event({
					event: {
						type: 'message.part.updated',
						properties: {
							part: {
								type: 'text',
								synthetic: true,
								sessionID: SESSION,
								text: '<task id="child-err" state="error">\n<task_error>error</task_error>\n</task>',
							},
						},
					},
				} as never);
				expect(registryTest.size()).toBe(0);
				expect(registryTest.sessionCount(leg.directory)).toBe(0);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});
});
