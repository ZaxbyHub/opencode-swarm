/**
 * 2026-11-27 (task 2.18 retry-circuit wedge): an infrastructure-only
 * pre_check failure must not consume the task's retry budget.
 *
 * Observed live in the consumer project: the sast_scan evidence bundle
 * crossed its byte cap, every further gate run's save threw, and each run
 * recorded a `stage_a_failed` transition — the task burned its full retry
 * contingency (TASK_RETRY_USER_ESCALATION_REQUIRED) on infrastructure alone,
 * with no coder attempt ever failing on content.
 *
 * These tests pin the writer-level fix (same pattern as the scope-prep
 * refusal fix): an infra-classified failure writes NO transition at all —
 * retryCount, retryHistory, lastOutcome, and the workflow state stay
 * untouched; the architect gets a bounded route event
 * (`pre_check_infra_failed`) plus an always-visible advisory. A content
 * failure still records `stage_a_failed` exactly as before, and repeated
 * infra failures never spiral the counter.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
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

function gate(ran: boolean, extra: Record<string, unknown> = {}) {
	return { ran, duration_ms: 1, ...extra };
}

const CLEAN_SECRETSCAN = gate(true, {
	result: {
		count: 0,
		findings: [],
		files_scanned: 5,
		incomplete_files: 0,
		incomplete_paths: [],
	},
});

/** The 2.18 shape: the scan ran clean, the evidence save threw. */
const INFRA_FAIL_PAYLOAD = JSON.stringify({
	batch_status: 'completed',
	gates_passed: false,
	total_duration_ms: 1,
	lint: gate(true),
	secretscan: CLEAN_SECRETSCAN,
	sast_scan: gate(true, {
		result: { verdict: 'pass', findings: [] },
		error:
			'Failed to persist sast evidence: Evidence bundle size (528522 bytes) exceeds maximum (512000 bytes)',
	}),
	quality_budget: gate(false),
});

/** A real content rejection: secretscan found a new secret. */
const CONTENT_FAIL_PAYLOAD = JSON.stringify({
	batch_status: 'completed',
	gates_passed: false,
	total_duration_ms: 1,
	lint: gate(true),
	secretscan: gate(true, {
		result: {
			count: 1,
			findings: [{ path: 'src/a.ts', line: 1, type: 'aws-key' }],
			files_scanned: 5,
			incomplete_files: 0,
			incomplete_paths: [],
		},
	}),
	sast_scan: gate(true, { result: { verdict: 'pass', findings: [] } }),
	quality_budget: gate(false),
});

async function settleTask(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:setup-${taskId}`,
	});
}

async function runPreCheck(
	callID: string,
	payload: string,
	taskId: string,
): Promise<void> {
	// The correlation binds at toolBefore time from the session's task —
	// create the session and set currentTaskId BEFORE the gate call runs.
	const session = ensureAgentSession('architect');
	session.currentTaskId = taskId;
	const hooks = createGuardrailsHooks(directory, defaultConfig());
	await hooks.toolBefore(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID },
		{ args: { files: ['src/a.ts'] } },
	);
	await hooks.toolAfter(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID },
		{ title: '', output: payload, metadata: null },
	);
}

function readRouteEvents(): Array<Record<string, unknown>> {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	try {
		return fs
			.readFileSync(eventsPath, 'utf8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('stage-a-infra-retry'));
});

afterEach(() => {
	cleanup();
	resetSwarmState();
});

describe('Stage A infrastructure failure — retry budget untouched', () => {
	test('the 2.18 shape records NO stage_a_failed: state, retry, and lastOutcome untouched', async () => {
		await settleTask('2.18');

		await runPreCheck('call-infra-1', INFRA_FAIL_PAYLOAD, '2.18');

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.18'),
		);
		expect(workflow.state).toBe('coder_delegated');
		expect(workflow.retryCount).toBe(0);
		expect(workflow.retryHistory).toEqual([]);
		expect(workflow.lastOutcome).toBe('accepted_mutation');
		expect(workflow.lastTransitionId).toBe('coder:setup-2.18');
	});

	test('the infra failure is visible: route event + always-visible advisory', async () => {
		await settleTask('2.19');

		await runPreCheck('call-infra-2', INFRA_FAIL_PAYLOAD, '2.19');

		const routes = readRouteEvents().filter(
			(event) => event.type === 'stage_a_gate_route',
		);
		expect(
			routes.some(
				(event) =>
					event.route === 'pre_check_infra_failed' && event.taskId === '2.19',
			),
		).toBe(true);
		expect(routes.some((event) => event.route === 'pre_check_failed')).toBe(
			false,
		);

		const { swarmState } = await import('../../../src/state');
		const advisories =
			swarmState.agentSessions.get('architect')?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((message) =>
				message.includes('STAGE A FAILED ON INFRASTRUCTURE'),
			),
		).toBe(true);
	});

	test('FALSIFICATION: a content failure still records stage_a_failed exactly as before', async () => {
		await settleTask('2.20');

		await runPreCheck('call-content-1', CONTENT_FAIL_PAYLOAD, '2.20');

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.20'),
		);
		expect(workflow.state).toBe('rework_required');
		expect(workflow.retryCount).toBe(1);
		expect(workflow.retryHistory).toEqual(['stage_a_failed']);
		expect(workflow.lastOutcome).toBe('stage_a_failed');
		const routes = readRouteEvents().filter(
			(event) => event.type === 'stage_a_gate_route',
		);
		expect(
			routes.some(
				(event) =>
					event.route === 'pre_check_failed' && event.taskId === '2.20',
			),
		).toBe(true);
	});

	test('five repeated infra failures neither spiral the counter nor wedge the state', async () => {
		await settleTask('2.21');

		for (let i = 1; i <= 5; i++) {
			await runPreCheck(`call-infra-x${i}`, INFRA_FAIL_PAYLOAD, '2.21');
		}

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.21'),
		);
		expect(workflow.state).toBe('coder_delegated');
		expect(workflow.retryCount).toBe(0);
		expect(workflow.retryHistory).toEqual([]);
		const routes = readRouteEvents().filter(
			(event) =>
				event.type === 'stage_a_gate_route' &&
				event.route === 'pre_check_infra_failed',
		);
		expect(routes.length).toBe(5);
	});

	test('a content failure AFTER infra failures counts from zero — only content burns budget', async () => {
		await settleTask('2.22');

		await runPreCheck('call-mix-infra', INFRA_FAIL_PAYLOAD, '2.22');
		await runPreCheck('call-mix-infra-2', INFRA_FAIL_PAYLOAD, '2.22');
		await runPreCheck('call-mix-content', CONTENT_FAIL_PAYLOAD, '2.22');

		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.22'),
		);
		expect(workflow.state).toBe('rework_required');
		expect(workflow.retryCount).toBe(1);
		expect(workflow.retryHistory).toEqual(['stage_a_failed']);
	});
});
