/**
 * A.4 — Council reward capture: HOOK-level regression tests.
 *
 * Exercises the `submit_council_verdicts` toolAfter branch in
 * `src/hooks/delegation-gate.ts` that fires `applyCouncilReward` once an
 * APPROVE verdict advances a task to `'complete'`. Covers:
 *
 *   6. Dedup across re-submission — the `priorRewarded` flag is carried
 *      forward across the `session.taskCouncilApproved.set(...)` overwrite,
 *      so a task that completes a SECOND time (e.g. after being reopened for
 *      a redo round) is never rewarded twice.
 *   7. `memory.enabled` is false (the default) — the reward branch is a
 *      complete no-op; the task still completes normally.
 *   8. Completion guard — reward only fires when
 *      `getTaskState(session, taskId) === 'complete'` really holds. Covers
 *      both documented false-positive paths: a whitespace-only taskId (which
 *      `advanceTaskState` silently no-ops on) and a precondition failure
 *      (task not yet past `pre_check_passed`, so the council fast-path
 *      throws `INVALID_TASK_STATE_TRANSITION`).
 *   9. Isolation — a reward-capture failure (the provider's own
 *      `listRecallUsage` rejects) does not propagate out of
 *      `hook.toolAfter` and does not undo the task's completion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	computeMemoryContentHash,
	createMemoryId,
	LocalJsonlMemoryProvider,
	type MemoryRecord,
	resolveMemoryConfig,
} from '../../../src/memory';
import { derivePlanId } from '../../../src/plan/utils';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';

const PLAN_FIXTURE = {
	schema_version: '1.0.0' as const,
	title: 'council-reward-test',
	swarm: 'default',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'Phase 1',
			status: 'in_progress' as const,
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'in_progress' as const,
					size: 'small' as const,
					description: 'reward test task',
					depends: [],
					files_touched: [],
				},
			],
		},
	],
};
const PLAN_ID = derivePlanId(PLAN_FIXTURE);

function makeConfig(memory?: PluginConfig['memory']): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
		},
		// minimumMembers: 1 disables quorum enforcement so a single-verdict
		// approveOutput() below is sufficient to trigger the fast path.
		council: { enabled: true, minimumMembers: 1 },
		...(memory ? { memory } : {}),
	} as PluginConfig;
}

function approveOutput(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		success: true,
		overallVerdict: 'APPROVE',
		allCriteriaMet: true,
		requiredFixesCount: 0,
		roundNumber: 1,
		quorumSize: 1,
		...overrides,
	};
}

async function submitVerdict(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	taskId: string,
	output: Record<string, unknown>,
	callID: string,
): Promise<void> {
	await hook.toolAfter(
		{ tool: 'submit_council_verdicts', sessionID, callID, args: { taskId } },
		output,
	);
}

function makeMemoryRecord(id: string, text: string): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'repo_convention' as const,
		text,
	};
	// Ignore the caller-supplied id: content-addressed ids are required by
	// validateMemoryRecordRules, so we always derive the real one and expose
	// it via the return value for the caller to use in assertions.
	void id;
	return {
		id: createMemoryId(base),
		...base,
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: '2026-05-24T12:00:00.000Z',
		updatedAt: '2026-05-24T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

let tmpDir: string;
let origCwd: string;

function writePlan(): void {
	writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify(PLAN_FIXTURE),
	);
}

function enableCouncilGate(): void {
	getOrCreateProfile(tmpDir, PLAN_ID);
	setGates(tmpDir, PLAN_ID, { council_mode: true });
}

beforeEach(() => {
	resetSwarmState();
	origCwd = process.cwd();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-council-reward-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(origCwd);
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort — Windows may hold locks on JSONL files briefly */
	}
});

describe('delegation-gate: A.4 council reward capture — dedup across re-submission (F-A.4-6)', () => {
	it('rewards a memory only once even when the SAME task completes via council APPROVE a second time', async () => {
		writePlan();
		enableCouncilGate();
		const memoryConfig = resolveMemoryConfig({
			enabled: true,
			provider: 'local-jsonl',
		});
		const config = makeConfig(memoryConfig);
		const hook = createDelegationGateHook(config, tmpDir);
		const sessionID = 'sess-reward-dedup';

		startAgentSession(sessionID, 'architect');
		const session = ensureAgentSession(sessionID);
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');

		const memory = makeMemoryRecord('mem-dedup', 'Dedup reward test memory.');
		const seedProvider = new LocalJsonlMemoryProvider(tmpDir, memoryConfig);
		await seedProvider.upsert(memory);
		await seedProvider.recordRecallUsage({
			bundleId: 'bundle-dedup-1',
			query: 'q',
			scopes: [memory.scope],
			memoryIds: [memory.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: sessionID,
			timestamp: '2026-06-01T00:00:00.000Z',
		});

		// First APPROVE resolution: task advances pre_check_passed -> complete
		// and the recalled memory earns its first (and only expected) EMA step.
		await submitVerdict(
			hook,
			sessionID,
			'1.1',
			approveOutput(),
			'call-dedup-1',
		);
		expect(getTaskState(session, '1.1')).toBe('complete');

		const readerAfterFirst = new LocalJsonlMemoryProvider(tmpDir, memoryConfig);
		const eventsAfterFirst = await readerAfterFirst.listRewardEvents({
			memoryId: memory.id,
		});
		expect(eventsAfterFirst).toHaveLength(1);
		const recordAfterFirst = await readerAfterFirst.get(memory.id);
		expect(recordAfterFirst?.metadata.qValue).toBeCloseTo(0.55, 10);

		// Simulate the task being reopened for a redo round (e.g. a later
		// CONCERNS elsewhere in the plan sends this task through another
		// council pass) — reset the in-memory workflow state below
		// 'complete' so a second legitimate advance-to-complete is possible.
		// taskCouncilApproved.rewarded must survive this second resolution's
		// `.set(...)` overwrite so the memory is not rewarded again.
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');

		await submitVerdict(
			hook,
			sessionID,
			'1.1',
			approveOutput({ roundNumber: 2 }),
			'call-dedup-2',
		);
		expect(getTaskState(session, '1.1')).toBe('complete');

		const readerAfterSecond = new LocalJsonlMemoryProvider(
			tmpDir,
			memoryConfig,
		);
		const eventsAfterSecond = await readerAfterSecond.listRewardEvents({
			memoryId: memory.id,
		});
		// A broken dedup (e.g. `rewarded: false` hardcoded instead of carrying
		// `priorRewarded` forward) would append a SECOND reward event here and
		// drive qValue to a second compounded EMA step (0.55 -> 0.595).
		expect(eventsAfterSecond).toHaveLength(1);
		const recordAfterSecond = await readerAfterSecond.get(memory.id);
		expect(recordAfterSecond?.metadata.qValue).toBeCloseTo(0.55, 10);
		expect(recordAfterSecond?.metadata.qValue).not.toBeCloseTo(0.595, 6);
	});
});

describe('delegation-gate: A.4 council reward capture — memory disabled is a no-op (F-A.4-7)', () => {
	it('APPROVE -> complete does not attempt reward capture and does not error when memory.enabled is false', async () => {
		writePlan();
		enableCouncilGate();
		// makeConfig() with no memory argument leaves `config.memory` undefined,
		// matching the schema default (`enabled: false`).
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tmpDir);
		const sessionID = 'sess-reward-disabled';

		startAgentSession(sessionID, 'architect');
		const session = ensureAgentSession(sessionID);
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');

		// Seed recall usage under a provider that COULD reward the memory if
		// the hook attempted it — proves the absence of reward events is
		// because the disabled-memory gate skipped the attempt, not because
		// there was nothing to reward.
		const memoryConfigForSeeding = resolveMemoryConfig({
			enabled: true,
			provider: 'local-jsonl',
		});
		const memory = makeMemoryRecord(
			'mem-disabled',
			'Memory-disabled no-op test memory.',
		);
		const seedProvider = new LocalJsonlMemoryProvider(
			tmpDir,
			memoryConfigForSeeding,
		);
		await seedProvider.upsert(memory);
		await seedProvider.recordRecallUsage({
			bundleId: 'bundle-disabled-1',
			query: 'q',
			scopes: [memory.scope],
			memoryIds: [memory.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: sessionID,
			timestamp: '2026-06-01T00:00:00.000Z',
		});

		let thrown: unknown;
		try {
			await submitVerdict(
				hook,
				sessionID,
				'1.1',
				approveOutput(),
				'call-disabled-1',
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		// Task still completes normally — memory being disabled must not
		// interfere with the council fast-path advancement.
		expect(getTaskState(session, '1.1')).toBe('complete');

		const reader = new LocalJsonlMemoryProvider(tmpDir, memoryConfigForSeeding);
		const events = await reader.listRewardEvents({ memoryId: memory.id });
		expect(events).toEqual([]);
		const recordAfter = await reader.get(memory.id);
		expect(recordAfter?.metadata.qValue).toBeUndefined();
	});
});

describe('delegation-gate: A.4 council reward capture — completion guard (F-A.4-8)', () => {
	it('a whitespace-only taskId (advanceTaskState silent no-op) yields zero reward events', async () => {
		writePlan();
		enableCouncilGate();
		const memoryConfig = resolveMemoryConfig({
			enabled: true,
			provider: 'local-jsonl',
		});
		const config = makeConfig(memoryConfig);
		const hook = createDelegationGateHook(config, tmpDir);
		const sessionID = 'sess-reward-guard-whitespace';

		startAgentSession(sessionID, 'architect');
		const session = ensureAgentSession(sessionID);

		const memory = makeMemoryRecord(
			'mem-guard-ws',
			'Completion guard whitespace-taskId test memory.',
		);
		const seedProvider = new LocalJsonlMemoryProvider(tmpDir, memoryConfig);
		await seedProvider.upsert(memory);
		await seedProvider.recordRecallUsage({
			bundleId: 'bundle-guard-ws-1',
			query: 'q',
			scopes: [memory.scope],
			memoryIds: [memory.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: sessionID,
			timestamp: '2026-06-01T00:00:00.000Z',
		});

		// ' ' passes the truthy `if (taskId)` gate in delegation-gate.ts (it is
		// a non-empty string) but fails `isValidTaskId` (trims to ''), so
		// advanceTaskState silently returns without mutating state AND
		// without throwing. If the hook's reward guard only checked "the
		// advance call did not throw" (rather than actually reading back
		// getTaskState() === 'complete'), it would incorrectly reward here.
		let thrown: unknown;
		try {
			await submitVerdict(
				hook,
				sessionID,
				' ',
				approveOutput(),
				'call-guard-ws-1',
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		expect(getTaskState(session, ' ')).toBe('idle');

		const reader = new LocalJsonlMemoryProvider(tmpDir, memoryConfig);
		const events = await reader.listRewardEvents({ memoryId: memory.id });
		expect(events).toEqual([]);
		const recordAfter = await reader.get(memory.id);
		expect(recordAfter?.metadata.qValue).toBeUndefined();
	});

	it('a task below pre_check_passed (advance throws INVALID_TASK_STATE_TRANSITION) yields zero reward events', async () => {
		writePlan();
		enableCouncilGate();
		const memoryConfig = resolveMemoryConfig({
			enabled: true,
			provider: 'local-jsonl',
		});
		const config = makeConfig(memoryConfig);
		const hook = createDelegationGateHook(config, tmpDir);
		const sessionID = 'sess-reward-guard-precheck';

		startAgentSession(sessionID, 'architect');
		const session = ensureAgentSession(sessionID);
		session.currentTaskId = '1.1';
		// Below 'pre_check_passed' — the council fast-path in advanceTaskState
		// requires currentIndex >= indexOf('pre_check_passed'), so this
		// advance throws INVALID_TASK_STATE_TRANSITION before ever reaching
		// the reward-capture code.
		session.taskWorkflowStates.set('1.1', 'coder_delegated');

		const memory = makeMemoryRecord(
			'mem-guard-precheck',
			'Completion guard precheck-guard test memory.',
		);
		const seedProvider = new LocalJsonlMemoryProvider(tmpDir, memoryConfig);
		await seedProvider.upsert(memory);
		await seedProvider.recordRecallUsage({
			bundleId: 'bundle-guard-precheck-1',
			query: 'q',
			scopes: [memory.scope],
			memoryIds: [memory.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: sessionID,
			timestamp: '2026-06-01T00:00:00.000Z',
		});

		let thrown: unknown;
		try {
			await submitVerdict(
				hook,
				sessionID,
				'1.1',
				approveOutput(),
				'call-guard-precheck-1',
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		expect(getTaskState(session, '1.1')).toBe('coder_delegated');

		const reader = new LocalJsonlMemoryProvider(tmpDir, memoryConfig);
		const events = await reader.listRewardEvents({ memoryId: memory.id });
		expect(events).toEqual([]);
	});
});

describe('delegation-gate: A.4 council reward capture — isolation (F-A.4-9)', () => {
	it('a reward-capture provider failure does not propagate and does not undo task completion', async () => {
		writePlan();
		enableCouncilGate();
		// storageDir escapes .swarm/, so the provider's own lazy initialize()
		// (invoked from listRecallUsage, the first call applyCouncilReward
		// makes) rejects with a real path-traversal error — a genuine
		// provider-level failure, not a mock. This exercises the delegation
		// gate's own try/catch isolation around reward capture with no
		// module mocking required.
		const memoryConfig = resolveMemoryConfig({
			enabled: true,
			provider: 'local-jsonl',
			storageDir: '../escapes-swarm-root',
		});
		const config = makeConfig(memoryConfig);
		const hook = createDelegationGateHook(config, tmpDir);
		const sessionID = 'sess-reward-isolation';

		startAgentSession(sessionID, 'architect');
		const session = ensureAgentSession(sessionID);
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');

		let thrown: unknown;
		try {
			await submitVerdict(
				hook,
				sessionID,
				'1.1',
				approveOutput(),
				'call-isolation-1',
			);
		} catch (err) {
			thrown = err;
		}

		// The gate must swallow the reward-capture failure entirely.
		expect(thrown).toBeUndefined();
		// And the task must still be complete — a reward-capture failure
		// must never roll back or block the completion it followed.
		expect(getTaskState(session, '1.1')).toBe('complete');
	});
});
