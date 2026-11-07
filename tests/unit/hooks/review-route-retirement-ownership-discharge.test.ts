/**
 * Issue #3564 — sweep/observer discharge arms (FR-006 sibling of
 * review-route-retirement-ownership.test.ts): the pending-record stale sweep,
 * the completion observer's terminal arm entry, the Stage-B staleness arm,
 * and the settleCoder stale flip each discharge the call's route-invalidation
 * retirement obligation (#3577 PRR-003), while a RE-DRIVABLE settleCoder
 * failure ('settlement persistence failed') RETAINS the obligation — the
 * outcome-aware split of the final-critic r3 remediation.
 */
import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { $ } from 'bun';
import {
	createBackgroundCompletionObserver,
	_internals as observerInternals,
} from '../../../src/background/completion-observer';
import {
	recordPendingDelegation,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	recordRouteFault,
	_test_exports as registryTest,
} from '../../../src/review/route-invalidation-registry';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
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
	const directory = canonicalMkdtemp('discharge-3564-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'discharge 3564',
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

	it('the Stage-B staleness arm flushes the obligation (gate-bearing reviewer, stale workspace)', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg();
			try {
				// A gate-bearing reviewer record whose captured workspace went
				// stale: the completed terminal reaches the Stage-B staleness
				// arm, which flips the record to 'stale' — durably terminal, so
				// the #3577 flush must discharge the marker.
				await recordPendingDelegation(leg.directory, {
					correlationId: 'child-stalews',
					jobId: 'job-stalews',
					subagentSessionId: 'child-stalews',
					parentSessionId: SESSION,
					callID: 'call-stalews',
					normalizedAgent: 'reviewer',
					swarmPrefixedAgent: 'reviewer',
					planTaskId: null,
					evidenceTaskId: '1.1',
					workspace: {
						directory: path.join(leg.directory, 'different-project'),
						gitHead: null,
						dirtyHash: null,
						changedFiles: null,
						prHeadSha: null,
						scope: '1.1',
					},
				});
				expect(recordRouteFault(leg.directory, SESSION, 'call-stalews')).toBe(
					true,
				);
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
								text: '<task id="child-stalews" state="completed">\n<task_result>done</task_result>\n</task>',
							},
						},
					},
				} as never);
				// PRR-003: the staleness flush discharges the dead marker.
				expect(registryTest.size()).toBe(0);
				expect(registryTest.sessionCount(leg.directory)).toBe(0);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('the settleCoder stale flip flushes the obligation (coder, HEAD drift)', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg();
			try {
				// Mirror of the completion-observer-coder HEAD-drift harness:
				// a gate-bearing coder whose shared-root workspace went stale
				// after dispatch — settleCoder flips it 'stale' and returns
				// ok:false; the #3577 outcome-aware flush must discharge the
				// marker before the arm returns.
				const baseline = captureWorkspaceSnapshot(leg.directory);
				await recordPendingDelegation(leg.directory, {
					correlationId: 'child-cstale',
					jobId: null,
					subagentSessionId: 'child-cstale',
					parentSessionId: SESSION,
					callID: 'call-cstale',
					normalizedAgent: 'coder',
					swarmPrefixedAgent: 'coder',
					planTaskId: '1.1',
					evidenceTaskId: '1.1',
					workspace: baseline,
					taskChangeContext: {
						declaredFiles: ['src/foo.ts'],
						baseline,
					},
				});
				expect(recordRouteFault(leg.directory, SESSION, 'call-cstale')).toBe(
					true,
				);
				// Move HEAD after the captured baseline (external commit).
				fs.writeFileSync(path.join(leg.directory, 'external.txt'), 'x\n');
				await $`git -C ${leg.directory} -c user.email=t@local -c user.name=t add external.txt`.quiet();
				await $`git -C ${leg.directory} -c user.email=t@local -c user.name=t commit -q -m 'test: move target head'`.quiet();
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
								text: '<task id="child-cstale" state="completed">\n<task_result>done</task_result>\n</task>',
							},
						},
					},
				} as never);
				// The settleCoder stale flip is irreversible — the marker must
				// be discharged, not retained for a replay that cannot consult.
				expect(registryTest.size()).toBe(0);
				expect(registryTest.sessionCount(leg.directory)).toBe(0);
			} finally {
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('a re-drivable settleCoder failure RETAINS the obligation (settlement persistence failed)', async () => {
		const env = createIsolatedTestEnv();
		try {
			const leg = await newLeg();
			const origUpdate = observerInternals.updateCoderSettlement;
			try {
				// Mirror of the stale-flip harness with a FRESH workspace
				// (initial commit first so the baseline carries a real gitHead):
				// the shared-root path reaches updateCoderSettlement(state
				// 'settled') and fails transiently — 'settlement persistence
				// failed' leaves the claim resumable, so the obligation must
				// stay LIVE for the delivery that will settle and consume it
				// (#3509 replay retention; the PRR-004 class is an early flush).
				await $`git -C ${leg.directory} -c user.email=t@local -c user.name=t commit -q --allow-empty -m init`.quiet();
				const baseline = captureWorkspaceSnapshot(leg.directory);
				await recordPendingDelegation(leg.directory, {
					correlationId: 'child-cpersist',
					jobId: null,
					subagentSessionId: 'child-cpersist',
					parentSessionId: SESSION,
					callID: 'call-cpersist',
					normalizedAgent: 'coder',
					swarmPrefixedAgent: 'coder',
					planTaskId: '1.1',
					evidenceTaskId: '1.1',
					workspace: baseline,
					taskChangeContext: {
						declaredFiles: ['src/foo.ts'],
						baseline,
					},
				});
				expect(recordRouteFault(leg.directory, SESSION, 'call-cpersist')).toBe(
					true,
				);
				// First updateCoderSettlement call fails transiently (null —
				// the loadRecordsForWrite/lock class); any later call delegates
				// to the real primitive.
				let failedOnce = false;
				observerInternals.updateCoderSettlement = (async (
					...args: unknown[]
				) => {
					if (!failedOnce) {
						failedOnce = true;
						return null;
					}
					return origUpdate(...(args as []));
				}) as never;
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
								text: '<task id="child-cpersist" state="completed">\n<task_result>done</task_result>\n</task>',
							},
						},
					},
				} as never);
				// Re-drivable exit — the marker must be RETAINED, not flushed:
				// the resumable claim plus the armed Stage-B consult is exactly
				// what a later settling delivery consumes/retires through.
				expect(failedOnce).toBe(true);
				expect(
					registryTest.hasObligation(leg.directory, SESSION, 'call-cpersist'),
				).toBe(true);
				expect(registryTest.sessionCount(leg.directory)).toBe(1);
			} finally {
				observerInternals.updateCoderSettlement = origUpdate;
				leg.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it('the settle-arm flush classification pins the outcome-inventory table (r4 audit)', () => {
		// The final-critic r4 audit enumerated every settleCoder /
		// finishPublishedCoderWorktree ok:false outcome and classified it
		// terminal-by-ingestion-fence (flush) vs re-drivable (retain). This leg
		// pins the classification table so a future outcome string cannot
		// silently cross classes:
		// - flush: 'stale:*' flips, 'settlement preserved', and the three
		//   persist-first 'worktree settlement preserved:*' sites;
		// - retain: transient claim/persistence failures, the tracking recheck
		//   ('worktree settlement retry pending: tracked identity changed' —
		//   it does NOT persist 'preserved'), cleanup-debt retries, and any
		//   unknown string (fail-safe).
		const terminal = (outcome: string) =>
			observerInternals.isSettleCoderTerminalByFence(outcome);
		// terminal-by-fence — flush
		expect(terminal('stale: no coder baseline')).toBe(true);
		expect(
			terminal('stale: shared-root HEAD changed before coder completion'),
		).toBe(true);
		expect(terminal('settlement preserved')).toBe(true);
		expect(terminal('worktree settlement preserved: identity mismatch')).toBe(
			true,
		);
		expect(terminal('worktree settlement preserved: attribution failed')).toBe(
			true,
		);
		expect(
			terminal('worktree settlement preserved: merge refused: dirty index'),
		).toBe(true);
		// re-drivable — retain
		expect(terminal('settlement claim failed')).toBe(false);
		expect(terminal('settlement persistence failed')).toBe(false);
		expect(
			terminal('worktree settlement retry pending: tracked identity changed'),
		).toBe(false);
		expect(
			terminal(
				'worktree cleanup debt remains; durable reconciliation will retry: tracked identity changed',
			),
		).toBe(false);
		expect(
			terminal('worktree cleanup requires manual recovery: lane dirty'),
		).toBe(false);
		// unknown outcome — fail-safe retain
		expect(terminal('some future outcome string')).toBe(false);
	});
});
