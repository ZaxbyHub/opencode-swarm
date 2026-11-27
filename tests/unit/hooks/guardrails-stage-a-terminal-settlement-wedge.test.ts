/**
 * Terminal-settlement Stage A wedge attribution (the 2026-11-23
 * swarm_communication_debug pattern, consumer-project task 1.8).
 *
 * A task whose COMMITTED coder settlement settled terminal (accepted or
 * no-mutation) while its workflow sits at idle/blocked can never receive the
 * mechanical `stage_a_passed` write — pre-check runs on its files used to
 * route as `no_task_correlation` with an "ad-hoc run, no action needed"
 * remediation tail, hiding the real state. These tests pin the new contract:
 *  - the durable fallback recognizes the wedge by its declared file scope and
 *    routes the call as `terminal_settlement_wedge` with the task id in the
 *    bounded route event, never attempting a mechanical write;
 *  - the advisory names the task and the sanctioned recover_stage_a_task
 *    remediation;
 *  - a second durable candidate (eligible or in-flight) still forces
 *    ambiguity instead of a guess;
 *  - a file-scope mismatch stays generic (the run is not about the wedged
 *    task) and a WAL-less idle task is never a wedge candidate.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { readCoreEvents } from '../../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { STAGE_A_ROUTE_EVENT_TYPE } from '../../../src/hooks/guardrails/stage-a-route';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

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
	options?: { declaredFiles?: string[]; accepted?: boolean },
): void {
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
				declaredFiles: options?.declaredFiles ?? [],
			},
			accepted: options?.accepted ?? true,
			recordedAt: new Date(FIXED_NOW_MS).toISOString(),
		}),
	);
}

/**
 * The incident shape: a fresh task whose only coder round settled
 * no-mutation — the workflow stays at authoritative idle with the
 * dispatch_no_mutation outcome recorded.
 */
async function settleNoMutationIdle(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'dispatch_no_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:wal-${taskId}`,
	});
}

/** accepted_mutation → coder_delegated (the ordinary Stage-A-awaiting shape). */
async function settleTask(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:setup-${taskId}`,
	});
}

interface RouteEvent {
	route: string;
	taskId: unknown;
}

function routeEvents(): RouteEvent[] {
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

async function drive(
	callId: string,
	files: string[] | undefined,
): Promise<void> {
	const hooks = createGuardrailsHooks(directory, defaultConfig());
	await hooks.toolBefore(
		{
			tool: 'pre_check_batch',
			sessionID: 'architect',
			callID: callId,
		},
		{ args: files === undefined ? {} : { files } },
	);
	await hooks.toolAfter(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID: callId },
		{ title: '', output: PASS_PAYLOAD, metadata: null },
	);
}

function advisories(): string[] {
	return (
		swarmState.agentSessions.get('architect')?.pendingAdvisoryMessages ?? []
	);
}

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('stage-a-wedge'));
	resetSwarmState();
	ensureAgentSession('architect');
});

afterEach(() => {
	cleanup();
	resetSwarmState();
});

describe('terminal-settlement Stage A wedge', () => {
	test('no-mutation idle wedge: routes terminal_settlement_wedge with the task id, writes nothing, advises recover_stage_a_task', async () => {
		await settleNoMutationIdle('1.8');
		writeCommittedWal('1.8', {
			declaredFiles: ['AGENTS.md'],
			accepted: false,
		});

		await drive('c-wedge-1', ['AGENTS.md']);

		// No mechanical write: the reducer would reject it from idle, and the
		// supervised recover_stage_a_task path owns that state.
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.8'),
		);
		expect(snapshot.state).toBe('idle');
		expect(snapshot.lastOutcome).toBe('dispatch_no_mutation');

		const events = routeEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			route: 'terminal_settlement_wedge',
			taskId: '1.8',
		});

		const advisory = advisories().find((message) =>
			message.includes('STAGE A WEDGE (TERMINAL SETTLEMENT)'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('1.8');
		expect(advisory).toContain('no mutation attributed');
		expect(advisory).toContain('recover_stage_a_task');
		// The generic misleading advisory must not also fire for this route.
		expect(
			advisories().some((message) =>
				message.includes('STAGE A RECEIPT NOT ATTRIBUTED'),
			),
		).toBe(false);
	});

	test('accepted settlement drifted to blocked (#2828 shape) is the same wedge class', async () => {
		await settleTask('2.1');
		await transitionTaskWorkflowEvidence(directory, '2.1', {
			type: 'task_blocked',
			expectedGeneration: 1,
			transitionId: 'terminal:setup-2.1',
		});
		writeCommittedWal('2.1', {
			declaredFiles: ['src/changed.ts'],
			accepted: true,
		});

		await drive('c-wedge-2', ['src/changed.ts']);

		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.1'),
		);
		expect(snapshot.state).toBe('blocked');
		expect(routeEvents()[0]).toMatchObject({
			route: 'terminal_settlement_wedge',
			taskId: '2.1',
		});
		const advisory = advisories().find((message) =>
			message.includes('STAGE A WEDGE (TERMINAL SETTLEMENT)'),
		);
		expect(advisory).toBeDefined();
		// An accepted settlement must not be described as no-mutation.
		expect(advisory).not.toContain('no mutation attributed');
	});

	test('a wedge candidate plus an eligible coder_delegated candidate stays ambiguous', async () => {
		await settleNoMutationIdle('3.1');
		writeCommittedWal('3.1', {
			declaredFiles: ['AGENTS.md'],
			accepted: false,
		});
		await settleTask('3.2');
		writeCommittedWal('3.2', { declaredFiles: ['AGENTS.md'] });

		await drive('c-wedge-3', ['AGENTS.md']);

		expect(
			advisories().some((message) =>
				message.includes('STAGE A ATTRIBUTION AMBIGUOUS'),
			),
		).toBe(true);
		expect(
			advisories().some((message) =>
				message.includes('STAGE A WEDGE (TERMINAL SETTLEMENT)'),
			),
		).toBe(false);
		expect(routeEvents()[0]?.route).toBe('attribution_ambiguous');
		for (const taskId of ['3.1', '3.2']) {
			const snapshot = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, taskId),
			);
			expect(['idle', 'coder_delegated']).toContain(snapshot.state);
		}
	});

	test('a file-scope mismatch against the wedged task stays generic no_task_correlation', async () => {
		await settleNoMutationIdle('4.1');
		writeCommittedWal('4.1', {
			declaredFiles: ['AGENTS.md'],
			accepted: false,
		});

		await drive('c-wedge-4', ['README.md']);

		// The run is not about the wedged task: no wedge advisory, the generic
		// unattributed-pass advisory fires instead.
		expect(
			advisories().some((message) =>
				message.includes('STAGE A WEDGE (TERMINAL SETTLEMENT)'),
			),
		).toBe(false);
		expect(
			advisories().some((message) =>
				message.includes('STAGE A RECEIPT NOT ATTRIBUTED'),
			),
		).toBe(true);
		expect(routeEvents()[0]).toMatchObject({
			route: 'no_task_correlation',
			taskId: null,
		});
	});

	test('a WAL-less idle task is never a wedge candidate', async () => {
		// Authoritative idle with a no-mutation outcome but NO settlement WAL
		// (e.g. a background coder round, which writes no WAL): the durable
		// fallback has nothing to bind and stays generic.
		await settleNoMutationIdle('5.1');

		await drive('c-wedge-5', ['AGENTS.md']);

		expect(
			advisories().some((message) =>
				message.includes('STAGE A WEDGE (TERMINAL SETTLEMENT)'),
			),
		).toBe(false);
		expect(routeEvents()[0]?.route).toBe('no_task_correlation');
	});

	test('the ordinary eligible candidate flow is unchanged by the new candidate class', async () => {
		await settleTask('6.1');
		writeCommittedWal('6.1', { declaredFiles: ['src/a.ts'] });

		await drive('c-wedge-6', ['src/a.ts']);

		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '6.1'),
		);
		expect(snapshot.state).toBe('pre_check_passed');
		expect(routeEvents()[0]).toMatchObject({
			route: 'valid_pass',
			taskId: '6.1',
		});
	});
});
