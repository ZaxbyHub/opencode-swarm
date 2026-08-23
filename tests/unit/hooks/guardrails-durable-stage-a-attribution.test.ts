/**
 * Durable Stage A attribution fallback + visible write-failure escalation
 * (TASK_WORKFLOW_STAGE_A_REQUIRED post-reset wedge).
 *
 * `/swarm reset-session` clears every agent session and `.swarm/session/`,
 * so the pre_check_batch gate correlation built from
 * `session.currentTaskId` dies and the stage_a_passed write is silently
 * skipped. These tests pin the replacement behavior:
 *  - toolBefore falls back to committed settlement WALs when currentTaskId
 *    is gone, requiring exactly one eligible candidate;
 *  - multiple eligible candidates produce an ambiguity advisory instead of a
 *    guess;
 *  - attribution-miss write failures escalate to a visible advisory instead
 *    of a swallowed warn;
 *  - the normal correlated flow is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let cleanup: () => void;
let directory: string;

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
	};
}

const PASS_PAYLOAD = JSON.stringify({
	gates_passed: true,
	total_duration_ms: 1,
	batch_status: 'completed',
	lint: { ran: true, duration_ms: 1 },
	secretscan: {
		ran: true,
		duration_ms: 1,
		result: {
			count: 0,
			findings: [],
			files_scanned: 5,
			incomplete_files: 0,
			incomplete_paths: [],
		},
	},
	sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
	quality_budget: { ran: false, duration_ms: 0 },
});

function walPath(taskId: string): string {
	return `${directory}/.swarm/coder-settlements/${taskId}.json`;
}

function writeCommittedWal(taskId: string): void {
	require('node:fs').mkdirSync(`${directory}/.swarm/coder-settlements`, {
		recursive: true,
	});
	require('node:fs').writeFileSync(
		walPath(taskId),
		JSON.stringify({
			version: 1,
			state: 'COMMITTED',
			taskId,
			transitionId: `coder:test-${taskId}`,
			actor: 'test',
			processId: process.pid,
			runtimeId: '00000000-0000-4000-8000-000000000000',
			expectedGeneration: 1,
			context: {
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
				declaredFiles: [],
			},
			accepted: true,
			recordedAt: new Date().toISOString(),
		}),
	);
}

async function settleTask(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:setup-${taskId}`,
	});
}

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('guardrails-stage-a'));
	resetSwarmState();
});

afterEach(() => {
	cleanup();
	resetSwarmState();
});

describe('durable Stage A attribution', () => {
	test('reset-flow: fallback attributes Stage A after session wipe and advances the store', async () => {
		await settleTask('1.1');
		writeCommittedWal('1.1');
		// Simulate /swarm reset-session's in-memory wipe. The architect's fresh
		// session exists again (recreated by the next message turn) but has NO
		// currentTaskId.
		resetSwarmState();
		ensureAgentSession('architect');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c1' },
			{ args: {} },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c1' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(1);
	});

	test('ambiguous candidates produce an advisory and never a guessed write', async () => {
		await settleTask('2.1');
		await settleTask('2.2');
		writeCommittedWal('2.1');
		writeCommittedWal('2.2');
		ensureAgentSession('architect');
		resetSwarmState();
		ensureAgentSession('architect');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c2' },
			{ args: {} },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c2' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		for (const taskId of ['2.1', '2.2']) {
			const workflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, taskId),
			);
			expect(workflow.state).toBe('coder_delegated');
		}
		const session = swarmState.agentSessions.get('architect');
		const advisories = session?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((message) =>
				message.includes('STAGE A ATTRIBUTION AMBIGUOUS'),
			),
		).toBe(true);
	});

	test('attribution-miss write failure escalates to a visible advisory', async () => {
		// Correlated task with NO durable coder_delegated evidence: the Stage A
		// pass transition throws TASK_WORKFLOW_CODER_MUTATION_REQUIRED — the
		// exact error class previously swallowed into an invisible warn.
		ensureAgentSession('architect').currentTaskId = '9.9';

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c3' },
			{ args: {} },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c3' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		const session = swarmState.agentSessions.get('architect');
		const advisories = session?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some(
				(message) =>
					message.includes('STAGE A WRITE FAILED') &&
					message.includes('TASK_WORKFLOW_CODER_MUTATION_REQUIRED'),
			),
		).toBe(true);
	});

	test('normal correlated flow is unchanged (no fallback needed)', async () => {
		await settleTask('3.1');
		const session = ensureAgentSession('architect');
		session.currentTaskId = '3.1';

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c4' },
			{ args: {} },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c4' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '3.1'),
		);
		expect(workflow.state).toBe('pre_check_passed');
	});
});
