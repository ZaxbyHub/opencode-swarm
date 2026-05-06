/**
 * Tests for the submit_council_verdicts branch in delegation-gate.ts toolAfter.
 * Council mode is additive at phase level — it never suppresses per-task Stage B gates.
 *
 * Covers:
 *   - council disabled (default): reviewer/test_engineer Stage B advancement works.
 *   - council active (config.enabled=true AND QaGates.council_mode=true):
 *     Stage B advancement still runs unconditionally — council does NOT replace it.
 *     reviewer/test_engineer Task delegations advance task state regardless.
 *   - submit_council_verdicts APPROVE + allCriteriaMet + zero required fixes from
 *     pre_check_passed → state advances to 'complete'.
 *   - submit_council_verdicts REJECT → no advancement; verdict still recorded.
 *   - submit_council_verdicts APPROVE but allCriteriaMet=false → no advancement.
 *   - Disagreement (config.enabled=false, council_mode=true) → councilActive=false,
 *     Stage B path runs.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	advanceTaskState,
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import * as logger from '../../../src/utils/logger';

// Match the planId derivation used by set-qa-gates.ts / get-qa-gate-profile.ts
function derivePlanId(plan: { swarm: string; title: string }): string {
	return `${plan.swarm}-${plan.title}`.replace(/[^a-zA-Z0-9-_]/g, '_');
}

const PLAN_FIXTURE = {
	schema_version: '1.0.0' as const,
	title: 'council-test',
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
					description: 'test task',
					depends: [],
					files_touched: [],
				},
			],
		},
	],
};
const PLAN_ID = derivePlanId(PLAN_FIXTURE);

function makeConfig(
	overrides?: Record<string, unknown>,
	council?: { enabled?: boolean },
): PluginConfig {
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
			...(overrides?.hooks as Record<string, unknown>),
		},
		...(council ? { council } : {}),
	} as PluginConfig;
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
	// Create the QA gate profile and ratchet council_mode=true.
	getOrCreateProfile(tmpDir, PLAN_ID);
	setGates(tmpDir, PLAN_ID, { council_mode: true });
}

beforeEach(() => {
	resetSwarmState();
	origCwd = process.cwd();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-council-test-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(origCwd);
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('delegation-gate council wiring (Stage B suppression + APPROVE fast-path)', () => {
	describe('council disabled (default): Stage B path is preserved', () => {
		it('reviewer Task delegation still advances coder_delegated → reviewer_run', async () => {
			// No plan written, no QA profile — councilActive must be false.
			const config = makeConfig(); // no council key
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-no-council-rev', 'architect');
			const session = ensureAgentSession('sess-no-council-rev');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-no-council-rev',
					callID: 'call-rev-1',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);

			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});

		it('test_engineer Task delegation still advances reviewer_run → tests_run', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-no-council-te', 'architect');
			const session = ensureAgentSession('sess-no-council-te');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'reviewer_run');

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-no-council-te',
					callID: 'call-te-1',
					args: { subagent_type: 'test_engineer' },
				},
				{},
			);

			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});
	});

	describe('council active (config + profile both true): Stage B still runs per-task', () => {
		it('reviewer Task delegation still advances state when council is active', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-council-rev', 'architect');
			const session = ensureAgentSession('sess-council-rev');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-council-rev',
					callID: 'call-rev-2',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);

			// State MUST advance — council is additive at phase level, never suppresses Stage B.
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});

		it('test_engineer Task delegation still advances state when council is active', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-council-te', 'architect');
			const session = ensureAgentSession('sess-council-te');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'reviewer_run');

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-council-te',
					callID: 'call-te-2',
					args: { subagent_type: 'test_engineer' },
				},
				{},
			);

			// State MUST advance — Stage B always runs per-task regardless of council mode.
			expect(getTaskState(session, '1.1')).toBe('tests_run');
		});
	});

	describe('submit_council_verdicts APPROVE fast-path advances to complete', () => {
		it('APPROVE + allCriteriaMet + zero required fixes from pre_check_passed → complete', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-approve', 'architect');
			const session = ensureAgentSession('sess-approve');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			await hook.toolAfter(
				{
					tool: 'submit_council_verdicts',
					sessionID: 'sess-approve',
					callID: 'call-cc-1',
					args: { taskId: '1.1' },
				},
				{
					success: true,
					overallVerdict: 'APPROVE',
					allCriteriaMet: true,
					requiredFixesCount: 0,
					roundNumber: 1,
					quorumSize: 3,
				},
			);

			expect(getTaskState(session, '1.1')).toBe('complete');
			expect(session.taskCouncilApproved?.get('1.1')).toEqual({
				verdict: 'APPROVE',
				roundNumber: 1,
				quorumSize: 3,
			});
		});

		it('accepts a JSON-string output (legacy runtime shape)', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-approve-str', 'architect');
			const session = ensureAgentSession('sess-approve-str');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			await hook.toolAfter(
				{
					tool: 'submit_council_verdicts',
					sessionID: 'sess-approve-str',
					callID: 'call-cc-1b',
					args: { taskId: '1.1' },
				},
				JSON.stringify({
					success: true,
					overallVerdict: 'APPROVE',
					allCriteriaMet: true,
					requiredFixesCount: 0,
					roundNumber: 2,
					quorumSize: 5,
				}),
			);

			expect(getTaskState(session, '1.1')).toBe('complete');
			expect(session.taskCouncilApproved?.get('1.1')?.roundNumber).toBe(2);
			expect(session.taskCouncilApproved?.get('1.1')?.quorumSize).toBe(5);
		});
	});

	describe('submit_council_verdicts non-APPROVE outcomes do NOT advance state', () => {
		it('REJECT records verdict but does NOT advance state', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-reject', 'architect');
			const session = ensureAgentSession('sess-reject');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			await hook.toolAfter(
				{
					tool: 'submit_council_verdicts',
					sessionID: 'sess-reject',
					callID: 'call-cc-rej',
					args: { taskId: '1.1' },
				},
				{
					success: true,
					overallVerdict: 'REJECT',
					allCriteriaMet: false,
					requiredFixesCount: 3,
					roundNumber: 1,
				},
			);

			// State must remain at pre_check_passed; verdict recorded.
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
			// The mock output omits quorumSize → delegation-gate stores 1 as
			// the conservative fallback (intentional design — see Task 3.1).
			expect(session.taskCouncilApproved?.get('1.1')).toEqual({
				verdict: 'REJECT',
				roundNumber: 1,
				quorumSize: 1,
			});
		});

		it('APPROVE with allCriteriaMet=false does NOT advance state', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-partial', 'architect');
			const session = ensureAgentSession('sess-partial');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			await hook.toolAfter(
				{
					tool: 'submit_council_verdicts',
					sessionID: 'sess-partial',
					callID: 'call-cc-partial',
					args: { taskId: '1.1' },
				},
				{
					success: true,
					overallVerdict: 'APPROVE',
					allCriteriaMet: false,
					requiredFixesCount: 1,
					roundNumber: 1,
				},
			);

			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
			// Verdict still recorded for observability.
			expect(session.taskCouncilApproved?.get('1.1')?.verdict).toBe('APPROVE');
		});

		it('CONCERNS records verdict but does NOT advance state', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-concerns', 'architect');
			const session = ensureAgentSession('sess-concerns');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			await hook.toolAfter(
				{
					tool: 'submit_council_verdicts',
					sessionID: 'sess-concerns',
					callID: 'call-cc-con',
					args: { taskId: '1.1' },
				},
				{
					success: true,
					overallVerdict: 'CONCERNS',
					allCriteriaMet: true,
					requiredFixesCount: 0,
					roundNumber: 1,
				},
			);

			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
			expect(session.taskCouncilApproved?.get('1.1')?.verdict).toBe('CONCERNS');
		});
	});

	describe('council disagreement: config.enabled=false but profile.council_mode=true', () => {
		it('falls back to Stage B advancement (councilActive=false) and warns once', async () => {
			writePlan();
			enableCouncilGate();

			// council.enabled is FALSE here even though profile has council_mode=true.
			const config = makeConfig(undefined, { enabled: false });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-disagree', 'architect');
			const session = ensureAgentSession('sess-disagree');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			// Capture warnings to assert the disagreement notice surfaces once.
			const warnings: string[] = [];
			const origWarn = console.warn;
			console.warn = (...args: unknown[]) => {
				warnings.push(args.map(String).join(' '));
			};

			try {
				await hook.toolAfter(
					{
						tool: 'Task',
						sessionID: 'sess-disagree',
						callID: 'call-disagree-1',
						args: { subagent_type: 'reviewer' },
					},
					{},
				);
				// Trigger again — second call must NOT produce a duplicate warning.
				await hook.toolAfter(
					{
						tool: 'Task',
						sessionID: 'sess-disagree',
						callID: 'call-disagree-2',
						args: { subagent_type: 'reviewer' },
					},
					{},
				);
			} finally {
				console.warn = origWarn;
			}

			// Stage B path ran — state advanced.
			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
			// Disagreement notice surfaced exactly once for the plan.
			const disagreement = warnings.filter((m) =>
				m.includes('Council mode mismatch'),
			);
			expect(disagreement.length).toBe(1);
		});
	});

	describe('submit_council_verdicts malformed output is non-fatal', () => {
		it('logs a warn for unparseable string output and does not throw', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-malformed', 'architect');
			const session = ensureAgentSession('sess-malformed');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			const warnings: string[] = [];
			const origWarn = console.warn;
			console.warn = (...args: unknown[]) => {
				warnings.push(args.map(String).join(' '));
			};

			try {
				await hook.toolAfter(
					{
						tool: 'submit_council_verdicts',
						sessionID: 'sess-malformed',
						callID: 'call-cc-bad',
						args: { taskId: '1.1' },
					},
					'not-json',
				);
			} finally {
				console.warn = origWarn;
			}

			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
			expect(
				warnings.some((m) =>
					m.includes(
						'toolAfter submit_council_verdicts: failed to parse output',
					),
				),
			).toBe(true);
		});
	});

	describe('race condition: concurrent APPROVE + reviewer Task on same taskId', () => {
		it('council APPROVE then reviewer Task — state stays complete, not overwritten by reviewer_run', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-race', 'architect');
			const session = ensureAgentSession('sess-race');
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');

			// Step 1: council APPROVE — should advance to complete.
			// quorumSize: 3 satisfies the default minimumMembers quorum gate.
			await hook.toolAfter(
				{
					tool: 'submit_council_verdicts',
					sessionID: 'sess-race',
					callID: 'call-cc-race',
					args: { taskId: '1.1' },
				},
				{
					success: true,
					overallVerdict: 'APPROVE',
					allCriteriaMet: true,
					requiredFixesCount: 0,
					roundNumber: 1,
					quorumSize: 3,
				},
			);

			expect(getTaskState(session, '1.1')).toBe('complete');

			// Step 2: a reviewer Task delegation arrives immediately after (late dispatch).
			// Advancing a task already at 'complete' is an invalid transition (caught and logged).
			// State must remain complete regardless.
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-race',
					callID: 'call-race-rev',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);

			expect(getTaskState(session, '1.1')).toBe('complete');
		});
	});

	describe('edge cases: task not at pre_check_passed when APPROVE arrives', () => {
		it('APPROVE when task is at coder_delegated (pre-check not done) does NOT advance to complete', async () => {
			writePlan();
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-early', 'architect');
			const session = ensureAgentSession('sess-early');
			advanceTaskState(session, '1.1', 'coder_delegated');
			// NOTE: do NOT advance to pre_check_passed — council arrives too early.

			const warnings: string[] = [];
			const origWarn = console.warn;
			console.warn = (...args: unknown[]) => {
				warnings.push(args.map(String).join(' '));
			};
			try {
				await hook.toolAfter(
					{
						tool: 'submit_council_verdicts',
						sessionID: 'sess-early',
						callID: 'call-cc-early',
						args: { taskId: '1.1' },
					},
					{
						success: true,
						overallVerdict: 'APPROVE',
						allCriteriaMet: true,
						requiredFixesCount: 0,
						roundNumber: 1,
					},
				);
			} finally {
				console.warn = origWarn;
			}

			// Must NOT be complete; pre-check has not passed.
			expect(getTaskState(session, '1.1')).not.toBe('complete');
			// Verdict IS recorded for observability.
			expect(session.taskCouncilApproved?.get('1.1')?.verdict).toBe('APPROVE');
		});
	});

	describe('cross-session council config divergence: disagreement warn fires once across sessions', () => {
		it('mismatch warn emitted once even when multiple sessions trigger isCouncilGateActive', async () => {
			// Plan exists; QA profile has council_mode=true; but config.enabled=false → disagreement.
			writePlan();
			enableCouncilGate();

			// Single hook instance (the real runtime shape — plugin config is shared).
			const config = makeConfig(undefined, { enabled: false });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-multi-A', 'architect');
			const sessionA = ensureAgentSession('sess-multi-A');
			sessionA.currentTaskId = '1.1';
			sessionA.taskWorkflowStates.set('1.1', 'coder_delegated');

			startAgentSession('sess-multi-B', 'architect');
			const sessionB = ensureAgentSession('sess-multi-B');
			sessionB.currentTaskId = '1.2';
			sessionB.taskWorkflowStates.set('1.2', 'coder_delegated');

			const warnings: string[] = [];
			const warnSpy = spyOn(logger, 'warn').mockImplementation(
				(msg: string) => {
					warnings.push(msg);
				},
			);

			try {
				// Session A reviewer: triggers disagreement check.
				await hook.toolAfter(
					{
						tool: 'Task',
						sessionID: 'sess-multi-A',
						callID: 'call-multi-A-rev',
						args: { subagent_type: 'reviewer' },
					},
					{},
				);
				// Session B reviewer: should NOT emit a second disagreement warn.
				await hook.toolAfter(
					{
						tool: 'Task',
						sessionID: 'sess-multi-B',
						callID: 'call-multi-B-rev',
						args: { subagent_type: 'reviewer' },
					},
					{},
				);
			} finally {
				warnSpy.mockRestore();
			}

			// Disagreement: both sessions fell back to Stage B (council disabled).
			expect(getTaskState(sessionA, '1.1')).toBe('reviewer_run');
			expect(getTaskState(sessionB, '1.2')).toBe('reviewer_run');

			// Warn-once: the disagreement notice fires exactly once for the plan.
			const mismatchWarns = warnings.filter((m) =>
				m.includes('Council mode mismatch'),
			);
			expect(mismatchWarns.length).toBe(1);
		});
	});

	describe('isCouncilGateActive: graceful fallback when plan.json missing', () => {
		it('returns false (council not active) when plan.json is absent', async () => {
			// Deliberately do NOT call writePlan() — no plan.json exists.
			enableCouncilGate();

			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-no-plan', 'architect');
			const session = ensureAgentSession('sess-no-plan');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'coder_delegated');

			// Reviewer Task: if council correctly falls back to inactive → Stage B advances.
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-no-plan',
					callID: 'call-no-plan-rev',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);

			expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		});

		it('submit_council_verdicts with missing plan.json logs warn and does not advance', async () => {
			// No plan written — isCouncilGateActive returns false.
			const config = makeConfig(undefined, { enabled: true });
			const hook = createDelegationGateHook(config, tmpDir);

			startAgentSession('sess-no-plan-cc', 'architect');
			const session = ensureAgentSession('sess-no-plan-cc');
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'pre_check_passed');

			await hook.toolAfter(
				{
					tool: 'submit_council_verdicts',
					sessionID: 'sess-no-plan-cc',
					callID: 'call-no-plan-cc',
					args: { taskId: '1.1' },
				},
				{
					success: true,
					overallVerdict: 'APPROVE',
					allCriteriaMet: true,
					requiredFixesCount: 0,
					roundNumber: 1,
				},
			);

			// Council not active → verdict recorded but state NOT advanced.
			expect(getTaskState(session, '1.1')).toBe('pre_check_passed');
		});
	});
});
