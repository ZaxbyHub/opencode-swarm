/**
 * Issue #3380 suite, restructured for #3509/#3516 (selector: 'restructure').
 *
 * Persist failures are forced deterministically on every matrix OS: a real
 * `.swarm` directory with `.swarm/pr-review` as a plain FILE (plan.json stays
 * readable), so the only fault is the receipt parent mkdir, before
 * `routeDispatchStarted` is set, identically on Windows and POSIX.
 *
 * Honest claims scope (AC17): the legs prove the persist-side symmetry for
 * the fault classes they drive (mkdir-under-file, EISDIR, corrupt gate
 * state); POSIX ENOTDIR is pinned per-task in review-route-enotdir-3509;
 * the pre-v1 `legacy_unrouted` carve-out is disclosed in the fragment.
 *
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under (never the developer's real app-data).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import { resolveHiveDataDir } from '../../../src/knowledge/hive-paths';
import { workflowGateStatePath } from '../../../src/pr-review/persistence';
import {
	isRouteBlockedForSettlement,
	recordRouteInvalidation,
} from '../../../src/review/route-invalidation-registry';
import { enforcePersistedReviewRouteReceipt } from '../../../src/review/routing-enforcement';
import {
	advanceTaskState,
	ensureAgentSession,
	getTaskState,
	markStageBRouteRequired,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const SESSION = 'sess-3380';

function makeConfig(): PluginConfig {
	return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
}

const writePlan = (dir: string, taskIds = ['1.1']): void => {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Route persist failure fixture',
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
						description: 'Exercise the gates',
						depends: [],
						files_touched: ['src/foo.ts'],
					})),
				},
			],
		}),
	);
};

const reviewerArgs = (taskId: string) => ({
	subagent_type: 'reviewer',
	prompt: `TASK: ${taskId} review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement`,
});

const reviewed = (taskId: string) =>
	`[REVIEWED] | task-${taskId} | APPROVED | persist-failure fixture`;

function receiptJsonFiles(dir: string): string[] {
	const receiptsDir = path.join(dir, '.swarm', 'pr-review', 'route-receipts');
	if (!fs.existsSync(receiptsDir)) return [];
	return fs.readdirSync(receiptsDir).filter((name) => name.endsWith('.json'));
}

/** Break future persists WITHOUT deleting on-disk receipts (secret → dir). */
function breakSecret(): void {
	const secretPath = path.join(
		resolveHiveDataDir(),
		'review-route-receipts.key',
	);
	fs.rmSync(secretPath, { force: true });
	fs.mkdirSync(secretPath, { recursive: true });
}

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
const dirs: string[] = [];

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	for (const dir of dirs.splice(0)) {
		closeAllProjectDbs();
		removeTreeWithRetry(dir);
	}
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

/** Persist-failure fixture: `.swarm/pr-review` as a plain FILE. */
function gateDir(o: {
	persistFails: boolean;
	withPlan?: boolean;
	withPlanTaskIds?: string[];
}): string {
	const dir = canonicalMkdtemp('route-persist-3380-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	if (o.withPlanTaskIds) writePlan(dir, o.withPlanTaskIds);
	else if (o.withPlan) writePlan(dir);
	if (o.persistFails) {
		fs.writeFileSync(path.join(dir, '.swarm', 'pr-review'), 'not a directory');
	}
	return dir;
}

/** Single hook instance across dispatches (production topology). */
const makeHook = (dir: string) => createDelegationGateHook(makeConfig(), dir);

async function dispatch(
	dir: string,
	sessionID: string,
	args: { subagent_type: string; prompt: string; task_id?: string },
	callID = 'call-1',
	hook = makeHook(dir),
): Promise<unknown> {
	ensureAgentSession(sessionID, 'architect', dir);
	return hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
}

/** Seed a full route receipt for (sessionID, 1.1) via an attributed dispatch. */
async function seedFullReceipt(
	dir: string,
	sessionID: string,
	callID: string,
	hook = makeHook(dir),
): Promise<void> {
	ensureAgentSession(sessionID, 'architect', dir);
	recordModifiedFilesForTask(
		swarmState.agentSessions.get(sessionID)!,
		'1.1',
		['src/foo.ts'],
		dir,
	);
	await expect(
		hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{ args: reviewerArgs('1.1') },
		),
	).rejects.toThrow('TASK_WORKFLOW_');
}

describe('review/test_engineer route-receipt persist failure (#3380)', () => {
	it('reviewer ACCEPTANCE fall-through: refused without ACCEPTANCE, resolved with it — and the writable control persists', async () => {
		const dir = gateDir({ persistFails: true });
		await expect(
			dispatch(dir, 'sess-rf-reviewer', {
				subagent_type: 'reviewer',
				prompt: 'TASK: review it',
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
		expect(receiptJsonFiles(dir)).toEqual([]);
		await expect(
			dispatch(dir, 'sess-rf-reviewer-ok', {
				subagent_type: 'reviewer',
				prompt:
					'TASK: review it\nACCEPTANCE: FR-001 the diff satisfies the requirement',
			}),
		).resolves.toBeUndefined();
		expect(receiptJsonFiles(dir)).toEqual([]);
		// Writable control (persist OK): the same refusal STILL persists a
		// receipt — proving the receipt path itself is healthy.
		const ctl = gateDir({ persistFails: false });
		await expect(
			dispatch(ctl, 'sess-rf-ctl', {
				subagent_type: 'reviewer',
				prompt: 'TASK: review it',
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
		expect(receiptJsonFiles(ctl).length).toBeGreaterThan(0);
	});

	it('test_engineer under a plan workflow is still TASK-gate refused when persistence fails (control persists)', async () => {
		const dir = gateDir({ persistFails: true, withPlan: true });
		await expect(
			dispatch(dir, 'sess-rf-te', {
				subagent_type: 'test_engineer',
				prompt: 'TASK: 1.1 verify the change',
			}),
		).rejects.toThrow('TASK_WORKFLOW_STAGE_A_REQUIRED');
		expect(receiptJsonFiles(dir)).toEqual([]);
		const ctl = gateDir({ persistFails: false, withPlan: true });
		await expect(
			dispatch(ctl, 'sess-rf-te-ctl', {
				subagent_type: 'test_engineer',
				prompt: 'TASK: 1.1 verify the change',
			}),
		).rejects.toThrow('TASK_WORKFLOW_STAGE_A_REQUIRED');
		expect(receiptJsonFiles(ctl).length).toBeGreaterThan(0);
	});

	it('route SUCCESS persists a real route receipt (kind review_route_receipt) for a task-attributed reviewer dispatch', async () => {
		const dir = gateDir({ persistFails: false, withPlan: true });
		const sessionID = 'sess-rf-route-ok';
		await seedFullReceipt(dir, sessionID, 'call-route-ok');
		const receipts = receiptJsonFiles(dir);
		expect(receipts.length).toBeGreaterThan(0);
		const receipt = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'pr-review', 'route-receipts', receipts[0]!),
				'utf8',
			),
		) as { kind?: string };
		expect(receipt.kind).toBe('review_route_receipt');
	});

	it('a failed persist invalidates THIS dispatch; the call fault marker persists until whole-call retirement (#3502 PRR-007, #3509 semantics)', async () => {
		const dir = gateDir({ persistFails: false, withPlan: true });
		const sessionID = 'sess-rs';
		const hook = makeHook(dir);
		const args = reviewerArgs('1.1');
		await seedFullReceipt(dir, sessionID, 'call-r1', hook);
		expect(receiptJsonFiles(dir).length).toBeGreaterThan(0);
		breakSecret();
		await expect(
			dispatch(dir, sessionID, args, 'call-r2', hook),
		).rejects.toThrow('TASK_WORKFLOW_');
		const probe = _internals.routeInvalidationProbe;
		expect(probe).toBeInstanceOf(Function);
		// The task key consult blocks (callFault + task key recorded).
		expect(probe!('call-r2', sessionID, '1.1')).toBe(true);
		expect(probe!('call-r2', sessionID, '1.1')).toBe(true);
		// Unrelated dispatch never invalidated; the prior receipt survived.
		expect(probe!('call-r1', sessionID, '1.1')).toBe(false);
		expect(receiptJsonFiles(dir).length).toBeGreaterThan(0);
	});
});

describe('restructure — #3509/#3516 legs on the persist-failure fixture', () => {
	it('d1: corrupt gate state refuses the dispatch fail-closed at the wrapper (BLOCKED rethrow; admitted at base)', async () => {
		const dir = gateDir({ persistFails: true });
		fs.rmSync(path.join(dir, '.swarm', 'pr-review'), { force: true });
		fs.mkdirSync(path.dirname(workflowGateStatePath(dir, 'sess-d1')), {
			recursive: true,
		});
		fs.writeFileSync(workflowGateStatePath(dir, 'sess-d1'), 'not json {{{');
		await expect(
			dispatch(dir, 'sess-d1', {
				subagent_type: 'reviewer',
				prompt:
					'Review the staged change end to end.\nACCEPTANCE: FR-001 the review covers the requirement',
			}),
		).rejects.toThrow(/BLOCKED:|TASK_WORKFLOW_STAGE_A_REQUIRED/);
	});

	it('d2: a pre-assignment routing fault records the whole-call fault marker', async () => {
		const dir = gateDir({ persistFails: false, withPlan: true });
		await prepareTask(dir, '1.1', 'sess-d2');
		const hook = makeHook(dir);
		fs.mkdirSync(workflowGateStatePath(dir, 'sess-d2'), { recursive: true });
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'sess-d2', callID: 'call-d2' },
			{ args: reviewerArgs('1.1') },
		);
		expect(isRouteBlockedForSettlement(dir, 'call-d2', 'sess-d2', '1.1')).toBe(
			true,
		);
		recordRouteInvalidation(dir, 'sess-d2', 'call-d2k', '1.1');
		recordRouteInvalidation(dir, 'sess-d2', 'call-d2k', '1.2');
		expect(isRouteBlockedForSettlement(dir, 'call-d2k', 'sess-d2', '1.1')).toBe(
			true,
		);
		expect(isRouteBlockedForSettlement(dir, 'call-d2k', 'sess-d2', '1.1')).toBe(
			false,
		);
		expect(isRouteBlockedForSettlement(dir, 'call-d2k', 'sess-d2', '1.2')).toBe(
			true,
		);
	});

	it('d3: the persist attempt is observable through the _internals seam (attempted-and-threw vs never-attempted)', async () => {
		const dir = gateDir({ persistFails: true });
		const attempts: Array<{ kind?: string; error?: string }> = [];
		const realPersist = _internals.persistReviewRouteReceiptAtDispatch;
		_internals.persistReviewRouteReceiptAtDispatch = (async (input: {
			receipt: { kind: string };
		}) => {
			try {
				const result = await realPersist(input);
				attempts.push({ kind: input.receipt.kind });
				return result;
			} catch (error) {
				attempts.push({
					kind: input.receipt.kind,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}) as typeof realPersist;
		try {
			await dispatch(
				dir,
				'sess-d3',
				{
					subagent_type: 'reviewer',
					prompt:
						'TASK: review it\nACCEPTANCE: FR-001 the diff satisfies the requirement',
				},
				'call-d3a',
			);
			expect(attempts.length).toBeGreaterThan(0);
			expect(attempts[0]!.kind).toBe('review_route_pending');
			expect(attempts[0]!.error).toBeTruthy();
			attempts.length = 0;
			// A non-reviewer dispatch never enters the routing block: NO
			// persist attempt is recorded. (Its ACCEPTANCE refusal is
			// orthogonal — the point is no persist was attempted.)
			await dispatch(
				dir,
				'sess-d3',
				{ subagent_type: 'coder', prompt: 'TASK: implement it' },
				'call-d3b',
			).catch(() => undefined);
			expect(attempts).toEqual([]);
		} finally {
			_internals.persistReviewRouteReceiptAtDispatch = realPersist;
		}
	});

	it('d5: the corrected stale-receipt fixture keeps the prior full receipt on disk while the new persist fails', async () => {
		const dir = gateDir({ persistFails: false, withPlan: true });
		const sessionID = 'sess-d5';
		await seedFullReceipt(dir, sessionID, 'call-d5a');
		const before = receiptJsonFiles(dir);
		expect(before.length).toBeGreaterThan(0);
		breakSecret();
		await expect(
			dispatch(dir, sessionID, reviewerArgs('1.1'), 'call-d5b'),
		).rejects.toThrow('TASK_WORKFLOW_');
		expect(receiptJsonFiles(dir)).toEqual(before);
		expect(isRouteBlockedForSettlement(dir, 'call-d5b', sessionID, '1.1')).toBe(
			true,
		);
	});

	it('d6: a faulted multi-task dispatch is blocked for BOTH verdict tasks in both settlement orders', async () => {
		for (const order of ['1.1-first', '1.2-first'] as const) {
			const dir = gateDir({
				persistFails: false,
				withPlanTaskIds: ['1.1', '1.2'],
			});
			const sessionID = 'sess-d6';
			await prepareTask(dir, '1.1', sessionID);
			await prepareTask(dir, '1.2', sessionID);
			const hook = makeHook(dir);
			fs.mkdirSync(workflowGateStatePath(dir, sessionID), { recursive: true });
			const args = {
				subagent_type: 'reviewer',
				task_id: '1.1',
				prompt: `TASK: 1.1 and 1.2 review the changes\nACCEPTANCE: FR-001 the diff satisfies the requirement`,
			};
			await hook.toolBefore(
				{ tool: 'Task', sessionID, callID: 'call-d6' },
				{ args },
			);
			const verdict =
				order === '1.1-first'
					? `${reviewed('1.1')}\n${reviewed('1.2')}`
					: `${reviewed('1.2')}\n${reviewed('1.1')}`;
			await hook.toolAfter(
				{ tool: 'tool.execute.Task', sessionID, callID: 'call-d6', args },
				{ text: verdict },
			);
			const session = swarmState.agentSessions.get(sessionID)!;
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
			expect(getTaskState(session, '1.2')).toBe('pre_check_passed');
			expect(
				isRouteBlockedForSettlement(dir, 'call-d6', sessionID, '1.1'),
			).toBe(false);
			resetSwarmState();
		}
	});

	it('d7: a denied call retires its invalidation marker (no settlement will ever consult it)', async () => {
		const dir = gateDir({ persistFails: false, withPlan: true });
		await prepareTask(dir, '1.1', 'sess-d7');
		const hook = makeHook(dir);
		fs.mkdirSync(workflowGateStatePath(dir, 'sess-d7'), { recursive: true });
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'sess-d7', callID: 'call-d7' },
			{ args: reviewerArgs('1.1') },
		);
		expect(isRouteBlockedForSettlement(dir, 'call-d7', 'sess-d7', '1.1')).toBe(
			true,
		);
		await hook.abortDeniedSettlementForCall('call-d7', 'sess-d7');
		expect(isRouteBlockedForSettlement(dir, 'call-d7', 'sess-d7', '1.1')).toBe(
			false,
		);
	});

	it('p: healthy real toolAfter settlement — a receipt-persisted dispatch settles and advances (PRESERVING)', async () => {
		const dir = gateDir({ persistFails: false, withPlan: true });
		const sessionID = 'sess-p-healthy';
		await prepareTask(dir, '1.1', sessionID);
		const hook = makeHook(dir);
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-p1' },
			{ args: reviewerArgs('1.1') },
		);
		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID,
				callID: 'call-p1',
				args: reviewerArgs('1.1'),
			},
			{ text: reviewed('1.1') },
		);
		const session = swarmState.agentSessions.get(sessionID)!;
		expect(getTaskState(session, '1.1')).toBe('reviewer_run');
	});
});

describe('Stage-B advancement fails closed on the missing receipt (#3380 / plan F3 proof)', () => {
	it('fails closed on the missing receipt under default enforcement; enforce_receipts:false is the documented rollback', () => {
		for (const enforce of [true, false]) {
			const dir = gateDir({ persistFails: false });
			const sessionID = enforce ? 'sess-proof' : 'sess-proof-off';
			const session = ensureAgentSession(sessionID, 'architect', dir);
			markStageBRouteRequired(session, '1.1');
			const result = enforcePersistedReviewRouteReceipt({
				projectRoot: dir,
				sessionId: sessionID,
				taskId: '1.1',
				receipts: [],
				enforcementEnabled: enforce,
				legacyUnrouted: enforce
					? !session.stageBRouteRequiredTasks.has('1.1')
					: false,
				requireEvidenceBindings: true,
				requireCompleteEvidence: false,
			});
			expect(result.canAdvance).toBe(!enforce);
			if (!enforce) expect(result.mode).toBe('disabled');
		}
	});
});

/** Stage-A evidence + session view so taskId is Stage-B eligible. */
async function prepareTask(
	dir: string,
	taskId: string,
	sessionID = SESSION,
): Promise<void> {
	ensureAgentSession(sessionID, 'architect', dir);
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
	const session = swarmState.agentSessions.get(sessionID)!;
	advanceTaskState(session, taskId, 'coder_delegated');
	advanceTaskState(session, taskId, 'pre_check_passed');
}
