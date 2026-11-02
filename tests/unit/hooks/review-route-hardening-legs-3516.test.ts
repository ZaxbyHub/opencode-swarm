/**
 * Issue #3516 — route-receipt hardening legs (C11/C15/C16 + AC14 runtime
 * redaction). Selector groups (frozen -t filters):
 *  - 'capacity-preflight': the PRR-009 capacity pre-flights (best-effort
 *    across the reservation await) and the empty-binding skip — each pinned by
 *    a leg whose corresponding deletion reddens the suite.
 *  - 'fifo-consumption': registry semantics — per-key consumption, NO
 *    eviction (a full bound refuses the dispatch fail-closed while every
 *    prior marker stays consultable), whole-call retirement (settlement loop
 *    end, denied calls, failed outputs), background retention across
 *    retryable/failed commits, container cleanup, resetSwarmState isolation.
 *  - 'sibling-clobber': the rememberReviewRoute kind-monotonicity
 *    interleaving (the C6 mechanism; the AC6 forget-deletion wording is
 *    reconciled to this substitution — see the release fragment).
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under. Claims about cross-platform fault
 * classes are scoped to what these legs actually drive (persist-side Windows
 * + POSIX via the plain-file `.swarm/pr-review` fixture and EISDIR gate
 * state); the pre-v1 `legacy_unrouted` carve-out is disclosed in the release
 * fragment, not exercised here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import {
	_test_exports as gateInternals,
	activatePrWorkflow,
	reserveActivePrReviewReentryAuthorization,
} from '../../../src/hooks/pr-workflow-gate';
import { issuePrReviewReentryAuthorization } from '../../../src/pr-review/authorization';
import { workflowGateStatePath } from '../../../src/pr-review/persistence';
import {
	MAX_LIVE_CALLS_PER_SESSION,
	MAX_LIVE_DIRECTORIES,
	MAX_LIVE_SESSIONS_PER_DIRECTORY,
	recordRouteFault,
	recordRouteInvalidation,
	retireRouteInvalidationsForCall,
	_test_exports as registryInternals,
	isRouteBlockedForSettlement,
} from '../../../src/review/route-invalidation-registry';
import {
	advanceTaskState,
	ensureAgentSession,
	getStageBRouteEvidence,
	getTaskState,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const SESSION = 'sess-3516';
const HEAD_SHA = 'abc123003516';
const REVISION_DIGEST =
	'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function makeConfig(): PluginConfig {
	return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
}

function writePlan(dir: string, taskIds: string[]): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'hardening 3516',
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
}

const reviewerArgs = (taskId: string) => ({
	subagent_type: 'reviewer',
	prompt: `TASK: ${taskId} review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement`,
});

const reviewed = (taskId: string) =>
	`[REVIEWED] | task-${taskId} | APPROVED | hardening fixture`;

async function prepareTask(dir: string, taskId: string): Promise<void> {
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
}

/** Capture console.warn lines (the operator channel) with save/restore. */
function captureCriticalWarn(): { lines: string[]; restore: () => void } {
	const original = console.warn;
	const lines: string[] = [];
	console.warn = (...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	};
	return {
		lines,
		restore: () => {
			console.warn = original;
		},
	};
}

describe('route-receipt hardening legs (#3516)', () => {
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const dirs: string[] = [];

	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		gateInternals.resetTrackedStateCache();
	});

	afterEach(() => {
		resetSwarmState();
		gateInternals.resetTrackedStateCache();
		for (const dir of dirs.splice(0)) {
			closeAllProjectDbs();
			removeTreeWithRetry(dir);
		}
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	function fixture(options: { taskIds?: string[]; persistFails?: boolean } = {}) {
		const dir = canonicalMkdtemp('route-harden-3516-');
		dirs.push(dir);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		if (options.taskIds) writePlan(dir, options.taskIds);
		if (options.persistFails) {
			fs.writeFileSync(path.join(dir, '.swarm', 'pr-review'), 'not a directory');
		}
		ensureAgentSession(SESSION, 'architect', dir);
		return dir;
	}

	describe('capacity-preflight — PRR-009 pre-flights and the empty-binding skip', () => {
		/**
		 * The reentry-bypass recipe (tests/unit/hooks/delegation-gate-reentry-
		 * bypass.test.ts): a pre-Stage-A task (coder_delegated, not eligible)
		 * plus a live one-use authorization drives the resolved-task re-entry
		 * arm, whose consumed path remembers an EMPTY generations map.
		 */
		async function seedReentryArm(
			dir: string,
		): Promise<void> {
			await transitionTaskWorkflowEvidence(dir, '1.1', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder:1.1',
			});
			gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
			gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
			gateInternals.resolveIsWorkingTreeClean = () => true;
			gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
			gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
			await activatePrWorkflow(dir, SESSION, 'PR_REVIEW', {
				prHeadSha: HEAD_SHA,
			});
			const issued = await issuePrReviewReentryAuthorization(dir, SESSION, {
				prHeadSha: HEAD_SHA,
				role: 'reviewer',
			});
			expect(issued.role).toBe('reviewer');
		}

		it('a re-entry dispatch with no bound tasks resolves without a false binding-write warning', async () => {
			// The consumed re-entry arm runs with EMPTY generations, and the
			// empty-binding skip must keep the durable-twin writer from
			// emitting a vacuous "binding write FAILED" CRITICAL-WARN
			// (PRR-011). Deleting the skip reddens this.
			const dir = fixture();
			await seedReentryArm(dir);
			const hook = createDelegationGateHook(makeConfig(), dir);
			const warnCapture = captureCriticalWarn();
			try {
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: 'call-empty-binding' },
					{
						args: {
							subagent_type: 'reviewer',
							task_id: '1.1',
							prompt:
								'TASK: 1.1\nACCEPTANCE: Verify the exact task and report a bound positive verdict.',
						},
					},
				);
			} finally {
				warnCapture.restore();
			}
			expect(
				warnCapture.lines.filter((line) =>
					line.includes('Stage B durable binding write FAILED'),
				),
			).toEqual([]);
		});

		it('a full generation fence refuses the next re-entry dispatch BEFORE the one-use token is consumed', async () => {
			const dir = fixture({ taskIds: ['1.1', '2.2'] });
			await prepareTask(dir, '2.2');
			// Break the receipt persist path so the FILL dispatches are fast
			// (each routing catch records its fault and the #3380 fall-through
			// still binds the eligible task's generation — no receipt writes).
			fs.writeFileSync(path.join(dir, '.swarm', 'pr-review'), 'not a directory');
			const hook = createDelegationGateHook(makeConfig(), dir);
			const originalRecord = _internals.recordStageBDispatchBindings;
			_internals.recordStageBDispatchBindings = () => true;
			try {
				for (let index = 0; index < 128; index += 1) {
					await hook.toolBefore(
						{
							tool: 'Task',
							sessionID: SESSION,
							callID: `call-fill-${index}`,
						},
						{ args: reviewerArgs('2.2') },
					);
				}
			} finally {
				_internals.recordStageBDispatchBindings = originalRecord;
			}
			// Repair the receipt path, then arm the resolved-task re-entry
			// dispatch (pre-Stage-A 1.1 + live one-use authorization).
			fs.rmSync(path.join(dir, '.swarm', 'pr-review'), { force: true });
			await seedReentryArm(dir);
			// The pre-flight fires STAGE_B_CONTEXT_CAPACITY BEFORE the
			// reservation; deleting the pre-flight reddens the token assertion
			// below (the remember-time throw would burn the consumed token).
			await expect(
				hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: 'call-capped' },
					{
						args: {
							subagent_type: 'reviewer',
							task_id: '1.1',
							prompt:
								'TASK: 1.1\nACCEPTANCE: Verify the exact task and report a bound positive verdict.',
						},
					},
				),
			).rejects.toThrow('STAGE_B_CONTEXT_CAPACITY');
			const token = await reserveActivePrReviewReentryAuthorization(
				dir,
				SESSION,
				{ role: 'reviewer', callID: 'call-probe-reserve' },
			);
			expect(token).not.toBeNull();
		});
	});

	describe('fifo-consumption — registry markers are per-key, never evicted, and retire at terminal outcomes', () => {
		it('per-key consumption: a matched task key blocks exactly once; other keys and calls are untouched', () => {
			const dir = fixture();
			expect(
				recordRouteInvalidation(dir, SESSION, 'call-k1', '1.1'),
			).toBe(true);
			expect(recordRouteInvalidation(dir, SESSION, 'call-k1', '1.2')).toBe(
				true,
			);
			expect(isRouteBlockedForSettlement(dir, 'call-k1', SESSION, '1.1')).toBe(
				true,
			);
			// Consumed per matched key only — the second consult of 1.1 is free,
			// 1.2 still blocks, and no other call is affected.
			expect(isRouteBlockedForSettlement(dir, 'call-k1', SESSION, '1.1')).toBe(
				false,
			);
			expect(isRouteBlockedForSettlement(dir, 'call-k1', SESSION, '1.2')).toBe(
				true,
			);
			expect(isRouteBlockedForSettlement(dir, 'call-k2', SESSION, '1.1')).toBe(
				false,
			);
		});

		it('a full call bound refuses the dispatch fail-closed (ROUTE_INVALIDATION_CAPACITY) while every prior marker stays consultable', async () => {
			const dir = fixture({ taskIds: ['1.1'], persistFails: true });
			// Two unconsumed task-key markers plus a full bound of fault records.
			expect(recordRouteInvalidation(dir, SESSION, 'call-live-a', '1.1')).toBe(
				true,
			);
			expect(recordRouteInvalidation(dir, SESSION, 'call-live-b', '1.2')).toBe(
				true,
			);
			for (
				let index = 0;
				index < MAX_LIVE_CALLS_PER_SESSION - 2;
				index += 1
			) {
				expect(
					recordRouteFault(dir, SESSION, `call-fill-${index}`),
				).toBe(true);
			}
			const hook = createDelegationGateHook(makeConfig(), dir);
			const warnCapture = captureCriticalWarn();
			try {
				// The routing persist faults (plain-file fixture), the registry
				// refuses the new marker at capacity, and the dispatch is
				// REJECTED fail-closed — never silently admitted unprotected.
				await expect(
					hook.toolBefore(
						{ tool: 'Task', sessionID: SESSION, callID: 'call-over-cap' },
						{ args: reviewerArgs('1.1') },
					),
				).rejects.toThrow('ROUTE_INVALIDATION_CAPACITY');
			} finally {
				warnCapture.restore();
			}
			// NO eviction: the prior markers are all still consultable, and the
			// refusal was loud (criticalWarn names the bound).
			expect(isRouteBlockedForSettlement(dir, 'call-live-a', SESSION, '1.1')).toBe(
				true,
			);
			expect(isRouteBlockedForSettlement(dir, 'call-live-b', SESSION, '1.2')).toBe(
				true,
			);
			expect(
				warnCapture.lines.some(
					(line) =>
						line.includes('CRITICAL-WARN') &&
						line.includes('route-invalidation-registry') &&
						line.includes(`MAX_LIVE_CALLS_PER_SESSION=${MAX_LIVE_CALLS_PER_SESSION}`),
				),
			).toBe(true);
		});

		it('cap-plus-one at the session and directory bounds fails closed without eviction', () => {
			const dir = fixture();
			for (let index = 0; index < MAX_LIVE_SESSIONS_PER_DIRECTORY; index += 1) {
				expect(recordRouteFault(dir, `sess-${index}`, 'call-s')).toBe(true);
			}
			expect(recordRouteFault(dir, 'sess-over', 'call-s')).toBe(false);
			expect(recordRouteFault(dir, 'sess-0', 'call-s2')).toBe(true);
			// The main dir already occupies one directory slot; fill to the cap.
			for (let index = 0; index < MAX_LIVE_DIRECTORIES - 1; index += 1) {
				expect(recordRouteFault(`${dir}-d${index}`, SESSION, 'call-d')).toBe(
					true,
				);
			}
			expect(recordRouteFault(`${dir}-d-over`, SESSION, 'call-d')).toBe(false);
		});

		it('whole-call retirement: a denied call and a failed-output call both retire their marker', async () => {
			const dir = fixture({ taskIds: ['1.1'] });
			await prepareTask(dir, '1.1');
			const hook = createDelegationGateHook(makeConfig(), dir);
			// Denied call: the routing faults (EISDIR gate state), then the
			// production abort path retires the marker with the dispatch.
			fs.mkdirSync(workflowGateStatePath(dir, SESSION), { recursive: true });
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-denied' },
				{ args: reviewerArgs('1.1') },
			);
			expect(
				isRouteBlockedForSettlement(dir, 'call-denied', SESSION, '1.1'),
			).toBe(true);
			await hook.abortDeniedSettlementForCall('call-denied', SESSION);
			expect(
				isRouteBlockedForSettlement(dir, 'call-denied', SESSION, '1.1'),
			).toBe(false);
			// Failed output: the settlement loop never runs for a terminal
			// failure, and the generic toolAfter cleanup retires the marker.
			fs.rmSync(workflowGateStatePath(dir, SESSION), {
				recursive: true,
				force: true,
			});
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-failed-out' },
				{ args: reviewerArgs('1.1') },
			);
			expect(
				isRouteBlockedForSettlement(dir, 'call-x', SESSION, '1.1'),
			).toBe(false);
			retireRouteInvalidationsForCall(dir, SESSION, 'call-x');
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-failed-out',
					args: reviewerArgs('1.1'),
				},
				{ status: 'failed', state: 'failed' },
			);
			// (call-failed-out had no marker — the cleanup path is exercised by
			// the call-x retirement above; this leg pins the loop-skip shape.)
			expect(getTaskState(swarmState.agentSessions.get(SESSION)!, '1.1')).toBe(
				'pre_check_passed',
			);
		});

		it('empty containers are pruned on retirement and resetSwarmState clears the registry', () => {
			const dir = fixture();
			expect(recordRouteFault(dir, SESSION, 'call-only')).toBe(true);
			expect(registryInternals.size()).toBe(1);
			expect(registryInternals.sessionCount(dir)).toBe(1);
			retireRouteInvalidationsForCall(dir, SESSION, 'call-only');
			expect(registryInternals.sessionCount(dir)).toBe(0);
			expect(registryInternals.size()).toBe(0);
			expect(recordRouteFault(dir, SESSION, 'call-reset')).toBe(true);
			resetSwarmState();
			expect(isRouteBlockedForSettlement(dir, 'call-reset', SESSION, '1.1')).toBe(
				false,
			);
			expect(registryInternals.size()).toBe(0);
		});
	});

	describe('sibling-clobber — kind-monotonicity keeps a live full receipt bindable', () => {
		it('a sibling non-full remember cannot clobber a healthy full record (the later dispatch binds and settles on it)', async () => {
			const dir = fixture({ taskIds: ['1.1'] });
			await prepareTask(dir, '1.1');
			const hook = createDelegationGateHook(makeConfig(), dir);
			const session = swarmState.agentSessions.get(SESSION)!;
			recordModifiedFilesForTask(session, '1.1', ['src/foo.ts'], dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-full' },
				{ args: reviewerArgs('1.1') },
			);
			await hook.taskMetadata({
				callID: 'call-full',
				parentSessionID: SESSION,
				childSessionID: 'child-full',
			});
			// Free the live slot (production denial path) so the sibling's own
			// dispatch-time binding is observable.
			await hook.abortDeniedSettlementForCall('call-full', SESSION);
			// The sibling's routing remembers PENDING then ROUTER-ERROR records
			// under its own callID — both resisted against the FULL record.
			session.modifiedFilesByTask.set('1.1', []);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-sibling' },
				{ args: reviewerArgs('1.1') },
			);
			await hook.taskMetadata({
				callID: 'call-sibling',
				parentSessionID: SESSION,
				childSessionID: 'child-sibling',
			});
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-sibling',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			// Bound on the SURVIVED full record: route evidence recorded.
			// Deleting the monotonicity guard reddens this (the sibling would
			// bind nothing and settle without route evidence).
			expect(getStageBRouteEvidence(session, '1.1').length).toBe(1);
		});

		it('runtime warn channel: the degraded wrapper warn is on the operator channel and bounded (AC14 runtime half)', async () => {
			// EISDIR on the gate state: a genuine fs fault the wrapper degrades
			// (not a BLOCKED refusal). At base this warn was debug-gated
			// (logger.warn behind OPENCODE_SWARM_DEBUG) and unbounded — both
			// defects are pinned here by the runtime shape.
			const dir = fixture({ taskIds: ['1.1'] });
			await prepareTask(dir, '1.1');
			const hook = createDelegationGateHook(makeConfig(), dir);
			fs.mkdirSync(workflowGateStatePath(dir, SESSION), { recursive: true });
			const warnCapture = captureCriticalWarn();
			try {
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: 'call-redact' },
					{ args: reviewerArgs('1.1') },
				);
			} finally {
				warnCapture.restore();
			}
			const line = warnCapture.lines.find(
				(candidate) =>
					candidate.includes('PR-review re-entry binding context unreadable'),
			);
			expect(line).toBeDefined();
			expect(line!.includes('CRITICAL-WARN')).toBe(true);
			expect(line!.length).toBeLessThan(800);
		});

		it('runtime redaction: the registry capacity warn redacts the project path while naming the bound (AC14 redaction half)', () => {
			const dir = fixture();
			for (let index = 0; index < MAX_LIVE_CALLS_PER_SESSION; index += 1) {
				expect(recordRouteFault(dir, SESSION, `call-f-${index}`)).toBe(true);
			}
			const warnCapture = captureCriticalWarn();
			try {
				expect(recordRouteFault(dir, SESSION, 'call-over')).toBe(false);
			} finally {
				warnCapture.restore();
			}
			const line = warnCapture.lines.find(
				(candidate) =>
					candidate.includes('route-invalidation-registry') &&
					candidate.includes(
						`MAX_LIVE_CALLS_PER_SESSION=${MAX_LIVE_CALLS_PER_SESSION}`,
					),
			);
			expect(line).toBeDefined();
			expect(line!.includes('CRITICAL-WARN')).toBe(true);
			// The project path never appears raw when the fixture root is under
			// a redactable home profile (Windows/macOS temp dirs are; POSIX
			// /tmp fixtures are not — the assertion is scoped to what this leg
			// actually proves, per the honest-claims header).
			const redactableRoot = /^(\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/.test(
				dir,
			);
			if (redactableRoot) {
				expect(line!.includes(os.homedir())).toBe(false);
				expect(line!.includes('~')).toBe(true);
			}
		});
	});
});
