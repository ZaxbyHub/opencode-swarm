/**
 * Issue #3380: a reviewer/test_engineer dispatch whose route-receipt
 * PERSISTENCE fails must not silently skip the dispatch-time gates below the
 * routing block (ACCEPTANCE for coder/reviewer, TASK_GATE_AGENTS).
 *
 * Persist failures are forced deterministically on every matrix OS: a real
 * `.swarm` directory with `.swarm/pr-review` as a plain FILE (plan.json stays
 * readable). Every `.swarm` READ under that fixture stays well-formed
 * (ENOENT-tolerated readers return null on both platforms), so the ONLY fault
 * is the receipt parent mkdir inside persistReviewRouteReceipt — before
 * `routeDispatchStarted` is set, identically on Windows and POSIX. (The
 * first-draft `.swarm`-as-FILE shape was platform-divergent: POSIX ENOTDIR on
 * earlier reads vs Windows ENOENT — see the #3502 review, PRR-002.)
 *
 * Stage-B advancement stays fail-closed on the missing receipt under the
 * default `review_routing.enforce_receipts: true`. The settlement-layer proof
 * lives in the enforcement describe below: with the route-required marker set
 * and no receipt on disk, enforcePersistedReviewRouteReceipt (the exact
 * settlement entry point) refuses advancement; with `enforce_receipts: false`
 * it returns canAdvance:true (the documented config-rollback shape).
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under (LOCALAPPDATA / XDG data) so the
 * tests neither read nor write the developer's real app-data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import { enforcePersistedReviewRouteReceipt } from '../../../src/review/routing-enforcement';
import {
	ensureAgentSession,
	markStageBRouteRequired,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

function makeConfig(): PluginConfig {
	return {
		hooks: { delegation_gate: true },
	} as unknown as PluginConfig;
}

function writePlan(dir: string): void {
	const plan = {
		schema_version: '1.0.0',
		title: 'Route persist failure fixture',
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
						description: 'Exercise the gates',
						depends: [],
						files_touched: ['src/foo.ts'],
					},
				],
			},
		],
	};
	fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(plan));
}

/**
 * Shared fixture: a REAL `.swarm` directory whose `.swarm/pr-review` is a
 * plain FILE. Every `.swarm` read stays well-formed (ENOENT → null on every
 * platform); the receipt parent mkdir is the single fault. plan.json is
 * written when the legs need a plan workflow (test_engineer / route-success).
 */
function gateDir(options: {
	persistFails: boolean;
	withPlan?: boolean;
}): string {
	const dir = canonicalMkdtemp('route-persist-3380-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	if (options.withPlan) writePlan(dir);
	if (options.persistFails) {
		fs.writeFileSync(path.join(dir, '.swarm', 'pr-review'), 'not a directory');
	}
	return dir;
}

/** Route receipts land at `<dir>/.swarm/pr-review/route-receipts/*.json`. */
function receiptJsonFiles(dir: string): string[] {
	const receiptsDir = path.join(dir, '.swarm', 'pr-review', 'route-receipts');
	if (!fs.existsSync(receiptsDir)) return [];
	return fs.readdirSync(receiptsDir).filter((name) => name.endsWith('.json'));
}

describe('review/test_engineer route-receipt persist failure (#3380)', () => {
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const dirs: string[] = [];

	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		for (const dir of dirs.splice(0)) {
			// removeTreeWithRetry absorbs the Windows EBUSY/EPERM class (#3502
			// review PRR-016: bare rmSync leaked fixture handles on teardown).
			removeTreeWithRetry(dir);
		}
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	function dispatch(
		dir: string,
		sessionID: string,
		args: { subagent_type: string; prompt: string },
		callID = 'call-1',
	): Promise<unknown> {
		const hooks = createDelegationGateHook(makeConfig(), dir);
		// Created WITH the project directory so the session shape matches
		// production (disk rehydration registered; the PR-review re-entry
		// rehydration guard at the TASK_GATE block is exercised for real).
		ensureAgentSession(sessionID, 'architect', dir);
		return hooks.toolBefore({ tool: 'Task', sessionID, callID }, { args });
	}

	it('reviewer without ACCEPTANCE is still rejected when receipt persistence fails', async () => {
		const dir = gateDir({ persistFails: true });
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-reviewer', {
				subagent_type: 'reviewer',
				prompt: 'TASK: review it',
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
		// The persist failure is REAL: no receipt reached disk (PRR-003).
		expect(receiptJsonFiles(dir)).toEqual([]);
	});

	it('reviewer with ACCEPTANCE resolves when receipt persistence fails (gates ran; failure asserted by receipt absence)', async () => {
		const dir = gateDir({ persistFails: true });
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-reviewer-ok', {
				subagent_type: 'reviewer',
				prompt:
					'TASK: review it\nACCEPTANCE: FR-001 the diff satisfies the requirement',
			}),
		).resolves.toBeUndefined();
		// Companion to the no-ACCEPTANCE leg: together they prove the ACCEPTANCE
		// gate RAN on the persist-failure path (gate ran + passed here, refused
		// there) — and the missing receipt directory proves persistence failed.
		expect(receiptJsonFiles(dir)).toEqual([]);
	});

	it('reviewer without ACCEPTANCE rejects on the writable control fixture (persist OK; receipt persisted)', async () => {
		const dir = gateDir({ persistFails: false });
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-ctl', {
				subagent_type: 'reviewer',
				prompt: 'TASK: review it',
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
		// The control proves the receipt path is writable and the persist RAN.
		expect(receiptJsonFiles(dir).length).toBeGreaterThan(0);
	});

	it('reviewer with ACCEPTANCE resolves on the writable control fixture (persist OK; receipt persisted)', async () => {
		const dir = gateDir({ persistFails: false });
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-ctl-ok', {
				subagent_type: 'reviewer',
				prompt:
					'TASK: review it\nACCEPTANCE: FR-001 the diff satisfies the requirement',
			}),
		).resolves.toBeUndefined();
		expect(receiptJsonFiles(dir).length).toBeGreaterThan(0);
	});

	it('test_engineer under a plan workflow is still TASK-gate refused when persistence fails', async () => {
		const dir = gateDir({ persistFails: true, withPlan: true });
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-te', {
				subagent_type: 'test_engineer',
				prompt: 'TASK: 1.1 verify the change',
			}),
		).rejects.toThrow('TASK_WORKFLOW_STAGE_A_REQUIRED');
		expect(receiptJsonFiles(dir)).toEqual([]);
	});

	it('test_engineer control (persist OK) refuses with the same exact TASK gate class', async () => {
		const dir = gateDir({ persistFails: false, withPlan: true });
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-te-ctl', {
				subagent_type: 'test_engineer',
				prompt: 'TASK: 1.1 verify the change',
			}),
		).rejects.toThrow('TASK_WORKFLOW_STAGE_A_REQUIRED');
		expect(receiptJsonFiles(dir).length).toBeGreaterThan(0);
	});

	it('route SUCCESS persists a real route receipt (kind review_route_receipt) for a task-attributed reviewer dispatch', async () => {
		// The fragment's route-success claim, made real: with attributed files
		// for task 1.1 the routing block runs routeReviewForChanges and
		// persists an ACTUAL route receipt — assertable by kind, not the
		// NO_CHANGED_FILES router error the bare-control legs produce. The
		// dispatch is then TASK-gate refused (task 1.1 is idle/pre-check),
		// proving the receipt path and the TASK gate both execute.
		const dir = gateDir({ persistFails: false, withPlan: true });
		dirs.push(dir);
		const sessionID = 'sess-rf-route-ok';
		ensureAgentSession(sessionID, 'architect', dir);
		const session = swarmState.agentSessions.get(sessionID);
		expect(session).toBeDefined();
		recordModifiedFilesForTask(session!, '1.1', ['src/foo.ts'], dir);
		await expect(
			dispatch(dir, sessionID, {
				subagent_type: 'reviewer',
				prompt:
					'TASK: 1.1 review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement',
			}),
		).rejects.toThrow('TASK_WORKFLOW_');
		const receipts = receiptJsonFiles(dir);
		expect(receipts.length).toBeGreaterThan(0);
		const receipt = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'pr-review', 'route-receipts', receipts[0]!),
				'utf-8',
			),
		) as { kind?: string };
		expect(receipt.kind).toBe('review_route_receipt');
	});

	it('a failed persist invalidates THIS dispatch so a prior disk receipt cannot authorize it (#3502 PRR-007)', async () => {
		const dir = gateDir({ persistFails: false, withPlan: true });
		dirs.push(dir);
		const sessionID = 'sess-rs';
		ensureAgentSession(sessionID, 'architect', dir);
		const session = swarmState.agentSessions.get(sessionID);
		expect(session).toBeDefined();
		recordModifiedFilesForTask(session!, '1.1', ['src/foo.ts'], dir);
		const args = {
			subagent_type: 'reviewer',
			prompt:
				'TASK: 1.1 review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement',
		};
		// Dispatch 1 (call-r1): persist OK — a route receipt lands on disk.
		await expect(dispatch(dir, sessionID, args, 'call-r1')).rejects.toThrow(
			'TASK_WORKFLOW_',
		);
		expect(receiptJsonFiles(dir).length).toBeGreaterThan(0);
		// Break ONLY the receipt path: the prior receipt stays on disk (the
		// stale-authority surface), but every new persist now fails.
		fs.rmSync(path.join(dir, '.swarm', 'pr-review'), {
			recursive: true,
			force: true,
		});
		fs.writeFileSync(path.join(dir, '.swarm', 'pr-review'), 'not a directory');
		// Dispatch 2 (call-r2): persist fails; the routing failure is recorded
		// for THIS callID so the disk receipt cannot authorize its settlement.
		await expect(dispatch(dir, sessionID, args, 'call-r2')).rejects.toThrow(
			'TASK_WORKFLOW_',
		);
		const probe = _internals.routeInvalidationProbe;
		expect(probe).toBeInstanceOf(Function);
		expect(probe!('call-r2', sessionID, '1.1')).toBe(true);
		// Consumed on read: a later healthy dispatch re-routes normally.
		expect(probe!('call-r2', sessionID, '1.1')).toBe(false);
		// The unrelated dispatch was never invalidated.
		expect(probe!('call-r1', sessionID, '1.1')).toBe(false);
	});
});

describe('Stage-B advancement fails closed on the missing receipt (#3380 / plan F3 proof)', () => {
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	let dir: string;

	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		dir = canonicalMkdtemp('route-proof-3380-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		removeTreeWithRetry(dir);
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	it('with the route-required marker set and no receipt on disk, the settlement entry point refuses advancement under the default enforcement', () => {
		const sessionID = 'sess-proof';
		const session = ensureAgentSession(sessionID, 'architect', dir);
		// The exact state a persist-failure dispatch leaves: route-required
		// marker set (markStageBRouteRequired ran before the persist), no
		// receipt on disk (the persist threw).
		markStageBRouteRequired(session, '1.1');
		const result = enforcePersistedReviewRouteReceipt({
			projectRoot: dir,
			sessionId: sessionID,
			taskId: '1.1',
			receipts: [],
			enforcementEnabled: true,
			// Marker set ⇒ the settlement's legacyUnrouted escape is false.
			legacyUnrouted: !markStageBRouteRequiredMarkerSet(session, '1.1'),
			requireEvidenceBindings: true,
			requireCompleteEvidence: false,
		});
		expect(result.canAdvance).toBe(false);
	});

	it('with enforce_receipts disabled the receipt gate is the documented rollback surface', () => {
		const sessionID = 'sess-proof-disabled';
		const session = ensureAgentSession(sessionID, 'architect', dir);
		markStageBRouteRequired(session, '1.1');
		const result = enforcePersistedReviewRouteReceipt({
			projectRoot: dir,
			sessionId: sessionID,
			taskId: '1.1',
			receipts: [],
			enforcementEnabled: false,
			legacyUnrouted: false,
			requireEvidenceBindings: true,
			requireCompleteEvidence: false,
		});
		expect(result.canAdvance).toBe(true);
		expect(result.mode).toBe('disabled');
	});
});

function markStageBRouteRequiredMarkerSet(
	session: ReturnType<typeof ensureAgentSession>,
	taskId: string,
): boolean {
	return session.stageBRouteRequiredTasks.has(taskId);
}
