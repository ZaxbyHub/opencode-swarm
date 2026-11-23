/**
 * Tool-side Stage A self-report (src/tools/stage-a-self-report.ts).
 *
 * Coverage for the OpenCode 2.3.1/2.3.2 regression workaround
 * (anomalyco/opencode#65742): nested Code Mode tool calls no longer dispatch
 * plugin tool hooks, so `pre_check_batch` re-issues its Stage A receipt from
 * inside the tool. These tests pin the receipt contract of that self-report:
 * the attributed pass transition, the unattributed-pass advisory (the
 * silent-wedge communication fix), the mutation-required advisory for the
 * idle-after-repair wedge, hook-path duplicate idempotency, and the fail
 * verdict — all fail-open.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCoreEvents } from '../../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { STAGE_A_ROUTE_EVENT_TYPE } from '../../../src/hooks/guardrails/stage-a-route';
import { reportToolSideStageA } from '../../../src/tools/stage-a-self-report';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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

const FAIL_PAYLOAD = JSON.stringify({
	gates_passed: false,
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
	sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'fail' } },
	quality_budget: { ran: false, duration_ms: 0 },
});

interface RouteEvent {
	route: string;
	sessionID: unknown;
	callID: unknown;
	taskId: unknown;
}

function routeEvents(directory: string): RouteEvent[] {
	const read = readCoreEvents(directory);
	const events: RouteEvent[] = [];
	for (const line of read.text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.type === STAGE_A_ROUTE_EVENT_TYPE) {
				events.push(parsed as unknown as RouteEvent);
			}
		} catch {
			// skip non-JSON manifest line
		}
	}
	return events;
}

let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('swarm-self-report-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function settle(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:setup-${taskId}`,
	});
}

function report(
	payload: string,
	options: { sessionTaskId?: string; callId?: string } = {},
): Promise<void> {
	const session = ensureAgentSession('architect');
	if ('sessionTaskId' in options) {
		session.currentTaskId = options.sessionTaskId;
	}
	return reportToolSideStageA({
		sessionID: 'architect',
		directory,
		serializedResult: payload,
		files: undefined,
		toolCallId: options.callId ?? 'self:test:1',
	});
}

describe('stage-a-self-report', () => {
	test('attributed pass records stage_a_passed and the valid_pass route', async () => {
		await settle('1.1');
		await report(PASS_PAYLOAD, { sessionTaskId: '1.1' });
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(snapshot.state).toBe('pre_check_passed');
		expect(snapshot.lastOutcome).toBe('stage_a_passed');
		expect(snapshot.lastTransitionId).toBe('pre-check-tool:self:test:1');
		const events = routeEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			route: 'valid_pass',
			taskId: '1.1',
			sessionID: 'architect',
			callID: 'self:test:1',
		});
	});

	test('unattributed pass surfaces the STAGE A RECEIPT NOT ATTRIBUTED advisory', async () => {
		await report(PASS_PAYLOAD);
		const session = ensureAgentSession('architect');
		const advisory = session.pendingAdvisoryMessages?.find((m) =>
			m.includes('STAGE A RECEIPT NOT ATTRIBUTED'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('TASK_WORKFLOW_STAGE_A_REQUIRED');
		expect(advisory).toContain('/swarm recover');
		const events = routeEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			route: 'no_task_correlation',
			taskId: null,
		});
	});

	test('pass over an idle-after-repair task surfaces the mutation-required advisory with the recover remediation', async () => {
		// The observed 2.3.2 wedge tail: repair reopened the task to idle and
		// the background coder settlement never landed — no accepted mutation
		// for the current generation.
		await settle('1.1');
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'repair_idle',
			expectedGeneration: 1,
			transitionId: 'repair:gen-bump',
		});
		await report(PASS_PAYLOAD, { sessionTaskId: '1.1' });
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(snapshot.state).toBe('idle');
		const session = ensureAgentSession('architect');
		const advisory = session.pendingAdvisoryMessages?.find((m) =>
			m.includes('STAGE A WRITE FAILED'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('TASK_WORKFLOW_CODER_MUTATION_REQUIRED');
		expect(advisory).toContain('/swarm recover 1.1');
	});

	test('a Stage A pass already recorded for the generation is an idempotent duplicate', async () => {
		await settle('1.1');
		// The hook path (hosts where hooks fire) records the pass first with
		// its own pre-check transition id.
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'pre-check:call-hook-path',
		});
		await report(PASS_PAYLOAD, { sessionTaskId: '1.1' });
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(snapshot.state).toBe('pre_check_passed');
		expect(snapshot.generation).toBe(1);
		const events = routeEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]?.route).toBe('duplicate_result');
	});

	test('attributed fail records stage_a_failed and the pre_check_failed route', async () => {
		await settle('1.1');
		await report(FAIL_PAYLOAD, { sessionTaskId: '1.1' });
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(snapshot.state).toBe('rework_required');
		expect(snapshot.lastOutcome).toBe('stage_a_failed');
		const events = routeEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			route: 'pre_check_failed',
			taskId: '1.1',
		});
	});

	test('fail-open: a decode-skipped (invalid) result reports nothing', async () => {
		await report('definitely not json {{{');
		const session = ensureAgentSession('architect');
		expect(
			session.pendingAdvisoryMessages?.some((m) =>
				m.includes('STAGE A'),
			),
		).toBeFalsy();
		expect(routeEvents(directory)).toHaveLength(0);
	});
});
