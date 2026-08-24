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

// Deterministic fixture instant (explicit-arg Date constructor, not a raw
// clock read — see docs/testing/test-stability.md, issue #1782).
const FIXED_NOW_MS = new Date('2026-01-01T00:00:00.000Z').getTime();

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

function writeCommittedWal(
	taskId: string,
	options?: {
		declaredFiles?: string[];
		state?: 'COMMITTED' | 'DISPATCHED' | 'PREPARED';
	},
): void {
	require('node:fs').mkdirSync(`${directory}/.swarm/coder-settlements`, {
		recursive: true,
	});
	require('node:fs').writeFileSync(
		walPath(taskId),
		JSON.stringify({
			version: 1,
			state: options?.state ?? 'COMMITTED',
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
				declaredFiles: options?.declaredFiles ?? [],
			},
			accepted: true,
			recordedAt: new Date(FIXED_NOW_MS).toISOString(),
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
		writeCommittedWal('1.1', { declaredFiles: ['src/a.ts'] });
		// Simulate /swarm reset-session's in-memory wipe. The architect's fresh
		// session exists again (recreated by the next message turn) but has NO
		// currentTaskId.
		resetSwarmState();
		ensureAgentSession('architect');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c1' },
			// The scanned files must intersect the task's declared files for the
			// durable fallback to bind — this is the F-001 fix under test.
			{ args: { files: ['src/a.ts'] } },
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

	test('F-001: an unrelated session scanning unrelated files is NOT attributed to the sole durable candidate', async () => {
		await settleTask('1.1');
		writeCommittedWal('1.1', { declaredFiles: ['src/a.ts'] });
		resetSwarmState();
		ensureAgentSession('other-session');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'other-session', callID: 'c1u' },
			{ args: { files: ['README.md'] } },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'other-session', callID: 'c1u' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(workflow.state).toBe('coder_delegated');
		const session = swarmState.agentSessions.get('other-session');
		const advisories = session?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((message) =>
				message.includes('STAGE A ATTRIBUTION UNBOUND'),
			),
		).toBe(true);
	});

	test('F-001: a call with no files argument at all is NOT attributed', async () => {
		await settleTask('1.2');
		writeCommittedWal('1.2', { declaredFiles: ['src/b.ts'] });
		resetSwarmState();
		ensureAgentSession('no-files-session');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'no-files-session', callID: 'c1n' },
			{ args: {} },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'no-files-session', callID: 'c1n' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.2'),
		);
		expect(workflow.state).toBe('coder_delegated');
	});

	test('F-001: a shared empty-string file entry does NOT count as a file-scope match (test_engineer falsification)', async () => {
		await settleTask('1.3');
		// A wedged task whose WAL declared an empty-string entry (a genuinely
		// malformed/placeholder scope, not a real file).
		writeCommittedWal('1.3', { declaredFiles: [''] });
		resetSwarmState();
		ensureAgentSession('empty-string-session');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{
				tool: 'pre_check_batch',
				sessionID: 'empty-string-session',
				callID: 'c1e',
			},
			// The caller also passes an empty-string file entry — this must NOT
			// be treated as matching the WAL's empty-string declaredFiles entry.
			{ args: { files: [''] } },
		);
		await hooks.toolAfter(
			{
				tool: 'pre_check_batch',
				sessionID: 'empty-string-session',
				callID: 'c1e',
			},
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.3'),
		);
		expect(workflow.state).toBe('coder_delegated');
	});

	test('F-001: caller-side path normalization binds a non-byte-identical but equivalent file scope (closeout critic)', async () => {
		await settleTask('1.4');
		// declaredFiles is written already canonicalized (forward slashes, no
		// leading './') by the real dispatch path — src/scope/scope-binding.ts.
		writeCommittedWal('1.4', { declaredFiles: ['src/a.ts'] });
		resetSwarmState();
		ensureAgentSession('path-variant-session');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{
				tool: 'pre_check_batch',
				sessionID: 'path-variant-session',
				callID: 'c1p',
			},
			// The caller's raw args are NOT pre-normalized — a leading './' and
			// backslash separators must still bind to the canonical declared
			// entry above, not silently fail to match.
			{ args: { files: ['./src\\a.ts'] } },
		);
		await hooks.toolAfter(
			{
				tool: 'pre_check_batch',
				sessionID: 'path-variant-session',
				callID: 'c1p',
			},
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.4'),
		);
		expect(workflow.state).toBe('pre_check_passed');
	});

	test('F-006: a lane still mid-dispatch (DISPATCHED) at coder_delegated widens ambiguity instead of being invisible', async () => {
		await settleTask('4.1');
		writeCommittedWal('4.1', { declaredFiles: ['src/a.ts'] });
		// Task 4.2 is mid-dispatch: its evidence is already at coder_delegated
		// but its settlement WAL hasn't committed yet.
		await settleTask('4.2');
		writeCommittedWal('4.2', {
			declaredFiles: ['src/b.ts'],
			state: 'DISPATCHED',
		});
		resetSwarmState();
		ensureAgentSession('architect');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c6' },
			{ args: { files: ['src/a.ts'] } },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c6' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		// 4.1 would otherwise be the sole COMMITTED+accepted eligible candidate
		// (and its declared files DO match the caller's scan) — but 4.2's
		// in-flight dispatch must still force ambiguity rather than a guess.
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '4.1'),
		);
		expect(workflow.state).toBe('coder_delegated');
		const session = swarmState.agentSessions.get('architect');
		const advisories = session?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((message) =>
				message.includes('STAGE A ATTRIBUTION AMBIGUOUS'),
			),
		).toBe(true);
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

	test('F-007: a truncated settlement-WAL scan refuses to attribute even with an apparently-sole eligible candidate', async () => {
		await settleTask('1.1');
		writeCommittedWal('1.1', { declaredFiles: ['src/a.ts'] });
		// Pad past the 200-file settlement-WAL scan cap with names that sort
		// AFTER '1.1.json' so the real candidate stays inside the scanned
		// window while the scan as a whole is still truncated (matching.length
		// > 200) — a second candidate beyond the cap can never be ruled out.
		const fs = require('node:fs');
		const dir = `${directory}/.swarm/coder-settlements`;
		fs.mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 200; i++) {
			fs.writeFileSync(`${dir}/9.${i}.json`, 'not valid json');
		}
		resetSwarmState();
		ensureAgentSession('architect');

		const hooks = createGuardrailsHooks(directory, defaultConfig());
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c7' },
			{ args: { files: ['src/a.ts'] } },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c7' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(workflow.state).toBe('coder_delegated');
		const session = swarmState.agentSessions.get('architect');
		const advisories = session?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((message) =>
				message.includes('STAGE A ATTRIBUTION UNVERIFIABLE'),
			),
		).toBe(true);
	});
});
