/**
 * r16 audit (P1): the context-map task-release reconciliation must fail
 * closed on missing or unprovable QA evidence.
 *
 * `resolveContextMapTaskReleaseStatus` previously read the task evidence with
 * `readTaskEvidence()` — which returns `null` BOTH for a missing file AND for
 * an unreadable/corrupt one — and then coerced `null` into an EMPTY required
 * gate list. Because `[].every(...) === true`, the gate check passed
 * vacuously whenever the evidence file was absent, so a plan that already
 * claimed `completed` (with no QA evidence at all) was promoted to `approved`
 * in the context map by `reconcileContextMapTaskReleases`.
 *
 * Every test here pins the fail-closed direction: no authoritative evidence ⇒
 * no release. The release proof must come from the same durable-authority
 * rules the real task completion applies (workflow-generation state, the
 * derived applicable gate set, and the plan-identity stamp), not from a
 * vacuous empty-gate pass.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import {
	reconcileContextMapTaskReleases,
	resolveContextMapTaskReleaseStatus,
} from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { recordAgentDispatch } from '../../../src/gate-evidence';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageBGates } from '../../helpers/task-workflow-evidence';
import { freezeClock } from '../../helpers/test-clock';

const TASK_ID = '1.1';

function writePlan(
	directory: string,
	taskStatus: 'pending' | 'completed',
): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'r16 Fail-Closed Plan',
		swarm: 'r16-fail-closed',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: TASK_ID,
						phase: 1,
						status: taskStatus as Plan['phases'][0]['tasks'][0]['status'],
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(
		join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ context_map: { enabled: true } }),
	);
}

function seedPendingEntry(directory: string): void {
	const map = loadContextMap(directory) ?? createEmptyContextMap();
	saveContextMap(
		appendTaskHistory(map, {
			task_id: TASK_ID,
			goal: '',
			files_touched: [],
			implementation_summary: 'OLD',
			final_status: 'pending',
		}),
		directory,
	);
}

function evidencePath(directory: string): string {
	return join(directory, '.swarm', 'evidence', `${TASK_ID}.json`);
}

function writeRawEvidence(directory: string, raw: string): void {
	fs.mkdirSync(join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(evidencePath(directory), raw, 'utf-8');
}

function gateEntry(agent: string): {
	sessionId: string;
	timestamp: string;
	agent: string;
} {
	const now = new Date().toISOString();
	return { sessionId: `ses-${agent}`, timestamp: now, agent };
}

/**
 * A hand-crafted, schema-valid evidence document for a task that genuinely
 * completed its full QA chain (Stage A + reviewer + test_engineer) and whose
 * workflow reached the terminal `complete` state.
 */
function validCompletedEvidenceJson(
	overrides: Record<string, unknown> = {},
): string {
	const now = new Date().toISOString();
	return JSON.stringify({
		taskId: TASK_ID,
		required_gates: ['pre_check', 'reviewer', 'test_engineer'],
		gates: {
			pre_check: gateEntry('pre_check'),
			reviewer: gateEntry('reviewer'),
			test_engineer: gateEntry('test_engineer'),
		},
		workflow: {
			schema: 'exact-task-v1',
			generation: 0,
			state: 'complete',
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'task_completed',
			lastTransitionId: 'test-seed:complete',
			updatedAt: now,
		},
		...overrides,
	});
}

describe('context-map task release — fail-closed on missing/unprovable QA evidence (r16 P1)', () => {
	let directory: string;
	let cleanup: () => void;
	let restoreClock: () => void;

	beforeEach(() => {
		restoreClock = freezeClock({
			// The numeric clock and the ISO stamp are the SAME instant
			// (2025-07-15T12:00:00Z): under a freeze they must not disagree.
			fixedNow: 1_752_580_800_000,
			isoNow: '2025-07-15T12:00:00.000Z',
		});
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('ctxmap-failclosed-'));
		writePlan(directory, 'completed');
		seedPendingEntry(directory);
	});

	afterEach(() => {
		restoreClock();
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('no evidence file at all ⇒ stays pending (the vacuous empty-gate pass)', async () => {
		// Plan claims completion; the context map carries a pending entry; the
		// evidence file does not exist. Before the repair, readTaskEvidence()
		// returned null, `null ?? []` produced an empty required-gate list, and
		// `[].every(...)` passed vacuously — reconciliation wrote 'approved'.
		expect(fs.existsSync(evidencePath(directory))).toBe(false);

		await reconcileContextMapTaskReleases(directory);

		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'pending',
		);
	});

	test('resolveContextMapTaskReleaseStatus alone is also fail-closed without evidence', async () => {
		expect(fs.existsSync(evidencePath(directory))).toBe(false);
		await expect(
			resolveContextMapTaskReleaseStatus(directory, TASK_ID),
		).resolves.toBe('in_progress');
	});

	test('evidence file with invalid JSON ⇒ stays pending', async () => {
		writeRawEvidence(directory, '{ not json !!');
		await reconcileContextMapTaskReleases(directory);
		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'pending',
		);
	});

	test('structurally invalid evidence (schema rejection) ⇒ stays pending', async () => {
		// required_gates must be an array of strings — this fails Zod parsing,
		// so the evidence is unparseable, not absent.
		writeRawEvidence(
			directory,
			JSON.stringify({ taskId: TASK_ID, required_gates: 'bogus', gates: {} }),
		);
		await reconcileContextMapTaskReleases(directory);
		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'pending',
		);
	});

	test('evidence stamped for a different plan (prior campaign) ⇒ stays pending', async () => {
		writeRawEvidence(
			directory,
			validCompletedEvidenceJson({
				planIdentityHash: 'a'.repeat(64),
			}),
		);
		await reconcileContextMapTaskReleases(directory);
		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'pending',
		);
	});

	test('gate proofs from an older workflow generation (superseded by a new dispatch) ⇒ stays pending', async () => {
		// Seed a genuine full QA chain, then re-dispatch the coder: the new
		// accepted_mutation rotates the generation and clears the Stage-B
		// proofs, so the surviving evidence no longer proves THIS generation.
		await seedStageBGates(directory, TASK_ID);
		await recordAgentDispatch(directory, TASK_ID, 'coder', false);
		writePlan(directory, 'completed');

		await reconcileContextMapTaskReleases(directory);
		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'pending',
		);
	});

	test('only the reviewer gate recorded (test_engineer missing) ⇒ stays pending', async () => {
		const now = new Date().toISOString();
		writeRawEvidence(
			directory,
			JSON.stringify({
				taskId: TASK_ID,
				required_gates: ['pre_check', 'reviewer', 'test_engineer'],
				gates: {
					pre_check: { sessionId: 's', timestamp: now, agent: 'pre_check' },
					reviewer: { sessionId: 's', timestamp: now, agent: 'reviewer' },
				},
				workflow: {
					schema: 'exact-task-v1',
					generation: 0,
					state: 'reviewer_run',
					retryCount: 0,
					retryHistory: [],
					retryEpoch: 0,
					lastOutcome: 'gate_recorded',
					lastTransitionId: 't',
					updatedAt: now,
				},
			}),
		);
		await reconcileContextMapTaskReleases(directory);
		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'pending',
		);
	});

	test('force-completed workflow without normal QA ⇒ stays pending', async () => {
		// A qaExempt completion leaves the durable forcedCompletion marker and
		// no gate proofs. The release reconciliation must not treat the
		// terminal 'complete' state alone as QA proof.
		const now = new Date().toISOString();
		writeRawEvidence(
			directory,
			JSON.stringify({
				taskId: TASK_ID,
				required_gates: [],
				gates: {},
				workflow: {
					schema: 'exact-task-v1',
					generation: 0,
					state: 'complete',
					retryCount: 0,
					retryHistory: [],
					retryEpoch: 0,
					lastOutcome: 'task_completed',
					lastTransitionId: 't',
					updatedAt: now,
					forcedCompletion: true,
				},
			}),
		);
		await reconcileContextMapTaskReleases(directory);
		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'pending',
		);
	});

	test('control: full current-generation QA proof ⇒ release is recovered', async () => {
		// The fix must not over-block: with a schema-valid terminal workflow,
		// every applicable gate recorded, and no prior-campaign stamp, a
		// completed plan task still promotes to 'approved'.
		writeRawEvidence(directory, validCompletedEvidenceJson());
		await reconcileContextMapTaskReleases(directory);
		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'approved',
		);
	});
});
