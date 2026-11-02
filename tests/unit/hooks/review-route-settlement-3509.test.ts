/**
 * Issues #3509 / #3516 — route-receipt settlement integration (C4/C5/C6).
 *
 * Selector groups (frozen -t filters, see the trace's 02-reproduction table):
 *  - 'settlement-integration': the REAL toolAfter settlement path consults the
 *    route-invalidation registry — a dispatch whose routing faulted before its
 *    receipt persisted must NOT settle on a stale prior receipt. Deleting the
 *    consult block in the settlement loop reddens these legs.
 *  - 'call-site': the fail-closed behavior proven at the REAL settlement call
 *    site (routeEnforcementEnabled from config.review_routing.enforce_receipts
 *    at the enforce call): a healthy bound dispatch settles identically under
 *    both enforcement settings; an invalidation-free ROUTE-VIOLATING dispatch
 *    (full receipt on disk, no dispatch binding) is refused under true and
 *    advances only when enforcement is flipped at that site.
 *  - 'single-instance': ONE hook instance across dispatches (production
 *    topology, src/index.ts:2309) — cross-dispatch isolation with an
 *    independent route-binding observable, the rememberReviewRoute
 *    kind-monotonicity interleaving (guard-deletion reddens), multi-task
 *    two-verdict blocks in both orders, and whole-call marker retirement.
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under so no test reads or writes the
 * developer's real app-data (persist-side symmetry: the receipt writes and
 * reads both authenticate with the per-test secret).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { workflowGateStatePath } from '../../../src/pr-review/persistence';
import {
	advanceTaskState,
	ensureAgentSession,
	getStageBRouteEvidence,
	getTaskState,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const SESSION = 'sess-3509';

function makeConfig(enforceReceipts?: boolean): PluginConfig {
	return {
		hooks: { delegation_gate: true },
		...(enforceReceipts === undefined
			? {}
			: { review_routing: { enforce_receipts: enforceReceipts } }),
	} as unknown as PluginConfig;
}

function writePlan(dir: string, taskIds: string[]): void {
	const plan = {
		schema_version: '1.0.0',
		title: 'route settlement 3509',
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
	};
	fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(plan));
}

const reviewerArgs = (taskId: string) => ({
	subagent_type: 'reviewer',
	prompt: `TASK: ${taskId} review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement`,
});

/** Stage-A evidence + session view so taskId is Stage-B eligible (probe-C1 recipe). */
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

/** The REVIEWED verdict line the settlement parser attributes per task. */
const reviewed = (taskId: string) =>
	`[REVIEWED] | task-${taskId} | APPROVED | settlement fixture`;

/** Corrupt the gate state with EISDIR (genuine fs fault, both platforms). */
function corruptGateState(dir: string): void {
	fs.mkdirSync(workflowGateStatePath(dir, SESSION), { recursive: true });
}

function repairGateState(dir: string): void {
	fs.rmSync(workflowGateStatePath(dir, SESSION), {
		recursive: true,
		force: true,
	});
}

describe('review route settlement (#3509/#3516)', () => {
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const dirs: string[] = [];

	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		for (const dir of dirs.splice(0)) {
			// Release the fixture's project DB handles BEFORE the tree removal —
			// a held WAL lock makes Windows rmSync fail EBUSY (probe-C1 pattern).
			closeAllProjectDbs();
			removeTreeWithRetry(dir);
		}
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	function fixture(taskIds: string[]): string {
		const dir = canonicalMkdtemp('route-settle-3509-');
		dirs.push(dir);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		writePlan(dir, taskIds);
		ensureAgentSession(SESSION, 'architect', dir);
		return dir;
	}

	describe('settlement-integration — real toolAfter consults the invalidation registry', () => {
		it('healthy control: a dispatch whose receipt persisted settles and advances (fail-open router-error receipt)', async () => {
			const dir = fixture(['1.1']);
			await prepareTask(dir, '1.1');
			const hook = createDelegationGateHook(makeConfig(), dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-h0' },
				{ args: reviewerArgs('1.1') },
			);
			const session = swarmState.agentSessions.get(SESSION)!;
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-h0',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});

		it("a pre-assignment routing fault does not settle on the prior dispatch's stale receipt", async () => {
			const dir = fixture(['1.1']);
			await prepareTask(dir, '1.1');
			const hook = createDelegationGateHook(makeConfig(), dir);
			const session = swarmState.agentSessions.get(SESSION)!;
			// Dispatch 1 (healthy) seeds the fail-open router-error receipt on
			// disk — the stale-authority surface.
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-s1' },
				{ args: reviewerArgs('1.1') },
			);
			// Dispatch 2 faults pre-assignment (EISDIR on the gate state); the
			// #3380 fall-through still admits it, and the registry records the
			// call-scoped fault.
			corruptGateState(dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-s2' },
				{ args: reviewerArgs('1.1') },
			);
			expect(_internals.routeInvalidationProbe).toBeInstanceOf(Function);
			expect(
				_internals.routeInvalidationProbe!('call-s2', SESSION, '1.1'),
			).toBe(true);
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-s2',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			// THE assertion: the settlement consult withheld advancement even
			// though the stale fail-open receipt would have authorized it (the
			// healthy control above proves the loop advances when allowed).
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
			expect(
				session.stageBCompletion?.get('1.1')?.has('reviewer') ?? false,
			).toBe(false);
		});

		it('the call marker retires at settlement loop end (a later healthy dispatch re-routes)', async () => {
			const dir = fixture(['1.1']);
			await prepareTask(dir, '1.1');
			const hook = createDelegationGateHook(makeConfig(), dir);
			const session = swarmState.agentSessions.get(SESSION)!;
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-r1' },
				{ args: reviewerArgs('1.1') },
			);
			corruptGateState(dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-r2' },
				{ args: reviewerArgs('1.1') },
			);
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-r2',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			// Retired at loop end: the whole-call fault marker is gone.
			expect(
				_internals.routeInvalidationProbe!('call-r2', SESSION, '1.1'),
			).toBe(false);
			// A later healthy dispatch settles normally through the same loop.
			repairGateState(dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-r3' },
				{ args: reviewerArgs('1.1') },
			);
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-r3',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});
	});

	describe('call-site — enforcement wired at the real settlement call site', () => {
		it('healthy-valid dispatch (full receipt, bound evidence) settles identically under both enforcement settings', async () => {
			for (const enforce of [true, false]) {
				const dir = fixture(['1.1']);
				await prepareTask(dir, '1.1');
				ensureAgentSession(SESSION, 'architect', dir);
				recordModifiedFilesForTask(
					swarmState.agentSessions.get(SESSION)!,
					'1.1',
					['src/foo.ts'],
					dir,
				);
				const hook = createDelegationGateHook(makeConfig(enforce), dir);
				const callID = `call-cs-${enforce ? 'on' : 'off'}`;
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID },
					{ args: reviewerArgs('1.1') },
				);
				// The host's child-identity event binds the route slot's
				// childSessionId (production: message.part.updated).
				await hook.taskMetadata({
					callID,
					parentSessionID: SESSION,
					childSessionID: `child-${callID}`,
				});
				const session = swarmState.agentSessions.get(SESSION)!;
				await hook.toolAfter(
					{
						tool: 'tool.execute.Task',
						sessionID: SESSION,
						callID,
						args: reviewerArgs('1.1'),
					},
					{ text: reviewed('1.1') },
				);
				// No invalidation exists for this call, so the invalidation arm
				// is inert; the settlement advances (and records bound evidence).
				expect(getTaskState(session, '1.1')).toBe('reviewer_run');
				expect(getStageBRouteEvidence(session, '1.1').length).toBe(1);
				resetSwarmState();
			}
		});

		it('invalidation-free ROUTE-VIOLATING settlement (full receipt on disk, no dispatch binding) is refused under default enforcement', async () => {
			const dir = fixture(['1.1']);
			await prepareTask(dir, '1.1');
			// A full receipt lands on disk via a healthy attributed dispatch...
			recordModifiedFilesForTask(
				swarmState.agentSessions.get(SESSION)!,
				'1.1',
				['src/foo.ts'],
				dir,
			);
			const seeding = createDelegationGateHook(makeConfig(), dir);
			await seeding.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-seed' },
				{ args: reviewerArgs('1.1') },
			);
			// ...but the settling dispatch holds no in-memory binding (a fresh
			// hook instance = the process-local binding was lost, issue #2829)
			// and records NO invalidation (its routing never ran — the verdict
			// arrives for a call the instance never dispatched).
			const session = swarmState.agentSessions.get(SESSION)!;
			session.stageBRouteRequiredTasks.add('1.1');
			_internals.recordStageBDispatchBindings(dir, {
				sessionID: SESSION,
				callID: 'call-violating',
				bindings: [{ taskId: '1.1', generation: 1 }],
			});
			const settling = createDelegationGateHook(makeConfig(), dir);
			await settling.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-violating',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			// The real call site: enforcePersistedReviewRouteReceipt under
			// enforce_receipts:true refuses the full receipt with no dispatch
			// binding (ROUTE_RECEIPT_DISPATCH_REQUIRED-class) — fail closed.
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});

		it('the same ROUTE-VIOLATING settlement advances only when enforcement is disabled at that site (discriminating arm)', async () => {
			const dir = fixture(['1.1']);
			await prepareTask(dir, '1.1');
			recordModifiedFilesForTask(
				swarmState.agentSessions.get(SESSION)!,
				'1.1',
				['src/foo.ts'],
				dir,
			);
			const seeding = createDelegationGateHook(makeConfig(), dir);
			await seeding.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-seed2' },
				{ args: reviewerArgs('1.1') },
			);
			const session = swarmState.agentSessions.get(SESSION)!;
			session.stageBRouteRequiredTasks.add('1.1');
			_internals.recordStageBDispatchBindings(dir, {
				sessionID: SESSION,
				callID: 'call-violating2',
				bindings: [{ taskId: '1.1', generation: 1 }],
			});
			const settling = createDelegationGateHook(makeConfig(false), dir);
			await settling.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-violating2',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			// With enforce_receipts:false at the real call site, the same
			// settlement advances — proving the leg discriminates the wired
			// enforcement (flip it at the call site and this is what happens).
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});
	});

	describe('single-instance — one hook instance across dispatches', () => {
		it('cross-dispatch isolation: the healthy dispatch settles with bound evidence while the faulted dispatch is blocked', async () => {
			const dir = fixture(['1.1']);
			await prepareTask(dir, '1.1');
			const hook = createDelegationGateHook(makeConfig(), dir);
			const session = swarmState.agentSessions.get(SESSION)!;
			recordModifiedFilesForTask(session, '1.1', ['src/foo.ts'], dir);
			// Dispatch A (healthy, full receipt remembered + slot bound).
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-xa' },
				{ args: reviewerArgs('1.1') },
			);
			await hook.taskMetadata({
				callID: 'call-xa',
				parentSessionID: SESSION,
				childSessionID: 'child-xa',
			});
			// Dispatch B faults pre-assignment (its OWN call marker).
			corruptGateState(dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-xb' },
				{ args: reviewerArgs('1.1') },
			);
			// Independent observable: A's route binding settled evidence; B's
			// settlement is blocked by B's marker.
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-xa',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
			expect(getStageBRouteEvidence(session, '1.1').length).toBe(1);
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-xb',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			// The task already advanced via A; B's verdict must not regress it,
			// and B's marker blocked its own settlement attempt from recording
			// a second reviewer completion on the stale receipt.
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
			expect(getStageBRouteEvidence(session, '1.1').length).toBe(1);
		});

		it('monotonicity interleaving: healthy full receipt survives a sibling non-full overwrite; a later dispatch binds on the SURVIVED record; a faulted sibling records its own marker', async () => {
			const dir = fixture(['1.1']);
			await prepareTask(dir, '1.1');
			const hook = createDelegationGateHook(makeConfig(), dir);
			const session = swarmState.agentSessions.get(SESSION)!;
			// (1) Healthy FULL receipt remembered for dispatch M (one reviewer
			// slot; M's live binding occupies it).
			recordModifiedFilesForTask(session, '1.1', ['src/foo.ts'], dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-ma' },
				{ args: reviewerArgs('1.1') },
			);
			await hook.taskMetadata({
				callID: 'call-ma',
				parentSessionID: SESSION,
				childSessionID: 'child-ma',
			});
			// (2) M is denied after the routing landed (the production abort
			// path), releasing its live slot reservation — the map's FULL
			// record and the freed slot are what the sibling window attacks.
			await hook.abortDeniedSettlementForCall('call-ma', SESSION);
			// (3) A sibling's routing fault records its OWN call marker (the
			// removed task-scoped forget no longer touches the shared slot).
			corruptGateState(dir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-mf' },
				{ args: reviewerArgs('1.1') },
			);
			expect(
				_internals.routeInvalidationProbe!('call-mf', SESSION, '1.1'),
			).toBe(true);
			// M's healthy dispatch is untouched by the sibling fault: its own
			// marker consult is false (no fault recorded for M).
			expect(
				_internals.routeInvalidationProbe!('call-ma', SESSION, '1.1'),
			).toBe(false);
			// The faulted dispatch is denied (production abort path): its live
			// slot reservation is released AND its marker retires with it.
			await hook.abortDeniedSettlementForCall('call-mf', SESSION);
			expect(
				_internals.routeInvalidationProbe!('call-mf', SESSION, '1.1'),
			).toBe(false);
			// (4) Sibling N (different callID) attempts a non-full overwrite:
			// with no attributed files its routing remembers PENDING and then
			// ROUTER-ERROR records — the monotonicity guard must keep M's FULL
			// record (same-callID overwrites alone proceed). N's OWN
			// dispatch-time slot binding (which runs AFTER the routing block in
			// the same toolBefore) then binds against the SURVIVED full record.
			repairGateState(dir);
			session.modifiedFilesByTask.set('1.1', []);
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID: 'call-mb' },
				{ args: reviewerArgs('1.1') },
			);
			await hook.taskMetadata({
				callID: 'call-mb',
				parentSessionID: SESSION,
				childSessionID: 'child-mb',
			});
			// (5) The survived record was BINDABLE: N's settlement records
			// route evidence through the slot N bound. If N's pending or
			// router-error remember had clobbered M's full record, N would
			// bind nothing and record NO route evidence — deleting the
			// monotonicity guard reddens this assertion.
			await hook.toolAfter(
				{
					tool: 'tool.execute.Task',
					sessionID: SESSION,
					callID: 'call-mb',
					args: reviewerArgs('1.1'),
				},
				{ text: reviewed('1.1') },
			);
			expect(getStageBRouteEvidence(session, '1.1').length).toBe(1);
		});

		it('multi-task two-verdict settlement is blocked for BOTH tasks in both verdict orders; the marker retires only after the whole call settles', async () => {
			for (const order of ['1.1-first', '1.2-first'] as const) {
				const dir = fixture(['1.1', '1.2']);
				await prepareTask(dir, '1.1');
				await prepareTask(dir, '1.2');
				const hook = createDelegationGateHook(makeConfig(), dir);
				const session = swarmState.agentSessions.get(SESSION)!;
				recordModifiedFilesForTask(session, '1.1', ['src/foo.ts'], dir);
				recordModifiedFilesForTask(session, '1.2', ['src/bar.ts'], dir);
				// Both tasks' receipts land on disk (healthy dispatches).
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: 'call-ka' },
					{ args: reviewerArgs('1.1') },
				);
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: 'call-kb' },
					{ args: reviewerArgs('1.2') },
				);
				// The faulted dispatch covers both tasks (set dispatch).
				corruptGateState(dir);
				await hook.toolBefore(
					{ tool: 'Task', sessionID: SESSION, callID: 'call-kf' },
					{
						args: {
							subagent_type: 'reviewer',
							prompt:
								'TASK: 1.1 and 1.2 review the changes\nACCEPTANCE: FR-001 the diff satisfies the requirement',
						},
					},
				);
				expect(
					_internals.routeInvalidationProbe!('call-kf', SESSION, '1.1'),
				).toBe(true);
				const verdictText =
					order === '1.1-first'
						? `${reviewed('1.1')}\n${reviewed('1.2')}`
						: `${reviewed('1.2')}\n${reviewed('1.1')}`;
				await hook.toolAfter(
					{
						tool: 'tool.execute.Task',
						sessionID: SESSION,
						callID: 'call-kf',
						// subagent_type MUST be present or the settlement loop
						// never runs (subagentType comes from toolAfter args).
						args: {
							subagent_type: 'reviewer',
							prompt:
								'TASK: 1.1 and 1.2 review the changes\nACCEPTANCE: FR-001 the diff satisfies the requirement',
						},
					},
					{ text: verdictText },
				);
				// BOTH tasks blocked (the whole-call fault is not consumed per
				// task): neither advanced nor recorded reviewer completion.
				expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
				expect(getTaskState(session, '1.2')).toBe('pre_check_passed');
				expect(
					session.stageBCompletion?.get('1.1')?.has('reviewer') ?? false,
				).toBe(false);
				expect(
					session.stageBCompletion?.get('1.2')?.has('reviewer') ?? false,
				).toBe(false);
				// Retired only after the WHOLE call's settlement invocation.
				expect(
					_internals.routeInvalidationProbe!('call-kf', SESSION, '1.1'),
				).toBe(false);
				resetSwarmState();
			}
		});
	});
});
