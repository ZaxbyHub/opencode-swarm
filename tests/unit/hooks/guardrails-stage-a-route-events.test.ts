/**
 * Issue #2664 — Stage A attribution route events: unit coverage for route
 * classification and receipt shape through createGuardrailsHooks, in BOTH
 * guardrails modes. The route events are one bounded line per completed
 * pre_check_batch outcome in the core event store
 * (`type: "stage_a_gate_route"`), fields
 * route/sessionID/callID/taskId/guardrailsEnabled.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { readCoreEvents } from '../../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import {
	STAGE_A_ROUTE_EVENT_TYPE,
	STAGE_A_ROUTES,
} from '../../../src/hooks/guardrails/stage-a-route';
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

function config(enabled: boolean): GuardrailsConfig {
	return {
		enabled,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
	};
}

interface RouteEvent {
	route: string;
	sessionID: unknown;
	callID: unknown;
	taskId: unknown;
	guardrailsEnabled: unknown;
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
	directory = canonicalMkdtemp('swarm-route-events-');
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

async function drive(
	enabled: boolean,
	callID: string,
	payload: unknown,
	setup: 'correlated' | 'none',
): Promise<void> {
	if (setup === 'correlated') {
		await settle('1.1');
	}
	const session = ensureAgentSession('architect');
	if (setup === 'correlated') session.currentTaskId = '1.1';
	const hooks = createGuardrailsHooks(directory, config(enabled));
	await hooks.toolBefore(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID },
		{ args: {} },
	);
	await hooks.toolAfter(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID },
		{ title: '', output: payload, metadata: null },
	);
}

describe('stage-a-route-events', () => {
	test('vocabulary is closed with exactly the seven frozen routes', () => {
		expect([...STAGE_A_ROUTES].sort()).toEqual([
			'attribution_ambiguous',
			'duplicate_result',
			'invalid_result',
			'late_result',
			'no_task_correlation',
			'pre_check_failed',
			'valid_pass',
		]);
	});

	for (const enabled of [true, false]) {
		test(`valid pass receipt: route=valid_pass taskId set (guardrails ${enabled ? 'on' : 'off'})`, async () => {
			await drive(enabled, 'c-pass', PASS_PAYLOAD, 'correlated');
			const snapshot = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '1.1'),
			);
			expect(snapshot.state).toBe('pre_check_passed');
			const events = routeEvents(directory);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				route: 'valid_pass',
				sessionID: 'architect',
				callID: 'c-pass',
				taskId: '1.1',
				guardrailsEnabled: enabled,
			});
		});

		test(`invalid result: no transition, route=invalid_result (guardrails ${enabled ? 'on' : 'off'})`, async () => {
			await drive(
				enabled,
				'c-invalid',
				'definitely not json {{{',
				'correlated',
			);
			const snapshot = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '1.1'),
			);
			expect(snapshot.state).toBe('coder_delegated');
			const events = routeEvents(directory);
			expect(events).toHaveLength(1);
			expect(events[0]?.route).toBe('invalid_result');
			expect(events[0]?.taskId).toBe('1.1');
		});

		test(`no task correlation: bounded, no advance (guardrails ${enabled ? 'on' : 'off'})`, async () => {
			await drive(enabled, 'c-nocorr', PASS_PAYLOAD, 'none');
			const events = routeEvents(directory);
			expect(events).toHaveLength(1);
			expect(events[0]?.route).toBe('no_task_correlation');
			expect(events[0]?.taskId).toBeNull();
			expect(events[0]?.guardrailsEnabled).toBe(enabled);
		});

		test(`duplicate replay is idempotent: valid_pass then duplicate_result, state frozen (guardrails ${enabled ? 'on' : 'off'})`, async () => {
			await drive(enabled, 'c-dup', PASS_PAYLOAD, 'correlated');
			// Second delivery of the SAME callID after the pending receipt was
			// consumed: the durable pre-check:<callID> receipt already applied.
			const hooks = createGuardrailsHooks(directory, config(enabled));
			await hooks.toolAfter(
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-dup' },
				{ title: '', output: PASS_PAYLOAD, metadata: null },
			);
			const snapshot = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '1.1'),
			);
			expect(snapshot.state).toBe('pre_check_passed');
			expect(snapshot.generation).toBe(1);
			const events = routeEvents(directory);
			expect(events.map((e) => e.route)).toEqual([
				'valid_pass',
				'duplicate_result',
			]);
		});

		test(`late result: generation mismatch never advances (guardrails ${enabled ? 'on' : 'off'})`, async () => {
			await settle('1.1');
			const session = ensureAgentSession('architect');
			session.currentTaskId = '1.1';
			const hooks = createGuardrailsHooks(directory, config(enabled));
			await hooks.toolBefore(
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-late' },
				{ args: {} },
			);
			// Task repaired before the gate result arrives: generation bumps,
			// the pending correlation is now stale.
			await transitionTaskWorkflowEvidence(directory, '1.1', {
				type: 'repair_idle',
				expectedGeneration: 1,
				transitionId: 'repair:gen-bump',
			});
			await hooks.toolAfter(
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-late' },
				{ title: '', output: PASS_PAYLOAD, metadata: null },
			);
			const snapshot = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '1.1'),
			);
			expect(snapshot.state).toBe('idle');
			expect(snapshot.generation).toBe(2);
			const events = routeEvents(directory);
			expect(events).toHaveLength(1);
			expect(events[0]?.route).toBe('late_result');
			expect(events[0]?.taskId).toBe('1.1');
		});

		test(`non-authoritative evidence never classifies as duplicate (guardrails ${enabled ? 'on' : 'off'})`, async () => {
			// Production-shaped evidence whose workflow metadata is made
			// NON-authoritative (schema !== 'exact-task-v1') while its
			// lastTransitionId equals this call's pre-check receipt.
			// Without the authoritative precondition this exact shape
			// misclassifies the replay as duplicate_result (the R1-F4
			// fail-open window); the precondition fails it closed.
			await settle('1.1');
			const evidencePath = path.join(
				directory,
				'.swarm',
				'evidence',
				'1.1.json',
			);
			const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
				workflow: Record<string, unknown>;
			};
			evidence.workflow = {
				...evidence.workflow,
				schema: 'legacy-v0',
				lastTransitionId: 'pre-check:c-nonauth',
				lastOutcome: 'stage_a_passed',
			};
			fs.writeFileSync(evidencePath, JSON.stringify(evidence));
			const session = ensureAgentSession('architect');
			session.currentTaskId = '1.1';
			const hooks = createGuardrailsHooks(directory, config(enabled));
			await hooks.toolAfter(
				{
					tool: 'pre_check_batch',
					sessionID: 'architect',
					callID: 'c-nonauth',
				},
				{ title: '', output: PASS_PAYLOAD, metadata: null },
			);
			const events = routeEvents(directory);
			expect(events).toHaveLength(1);
			expect(events[0]?.route).toBe('no_task_correlation');
			expect(events[0]?.taskId).toBeNull();
		});
	}

	test('unbound durable fallback classifies as attribution_ambiguous (guardrails off)', async () => {
		// Sole durable candidate whose declared files do not match the scan.
		await settle('1.1');
		const walDir = path.join(directory, '.swarm', 'coder-settlements');
		fs.mkdirSync(walDir, { recursive: true });
		fs.writeFileSync(
			path.join(walDir, '1.1.json'),
			JSON.stringify({
				version: 1,
				state: 'COMMITTED',
				taskId: '1.1',
				transitionId: 'coder:test-1.1',
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
					declaredFiles: ['src/a.ts'],
				},
				accepted: true,
				recordedAt: '2026-01-01T00:00:00.000Z',
			}),
		);
		resetSwarmState();
		ensureAgentSession('architect');
		const hooks = createGuardrailsHooks(directory, config(false));
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-unbound' },
			{ args: { files: ['README.md'] } },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c-unbound' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(snapshot.state).toBe('coder_delegated');
		const events = routeEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]?.route).toBe('attribution_ambiguous');
		expect(events[0]?.taskId).toBeNull();
	});

	test('event lines stay within the 2048-byte contract bound', async () => {
		await drive(false, 'c-bounded'.padEnd(120, 'x'), PASS_PAYLOAD, 'none');
		const read = readCoreEvents(directory);
		for (const line of read.text.split('\n')) {
			if (line.includes(STAGE_A_ROUTE_EVENT_TYPE)) {
				expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(2048);
			}
		}
	});

	test('pending-route capacity bounds are pinned via _internals', () => {
		expect(_internals.MAX_PENDING_GATE_ROUTES_PER_SESSION).toBe(256);
		expect(_internals.MAX_PENDING_GATE_ROUTE_SESSIONS).toBe(500);
	});

	test('per-session pending-route overflow is bounded and never throws', async () => {
		resetSwarmState();
		ensureAgentSession('architect');
		const hooks = createGuardrailsHooks(directory, config(false));
		// Exceed the 256-per-session bound with unresolved toolBefore calls;
		// the capacity throw must be caught warn-only at the remember site.
		for (let i = 0; i < 260; i++) {
			await hooks.toolBefore(
				{
					tool: 'pre_check_batch',
					sessionID: 'architect',
					callID: `c-overflow-${i}`,
				},
				{ args: {} },
			);
		}
		// The lifecycle path stays fully functional after overflow.
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'after' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);
		const events = routeEvents(directory);
		expect(events.length).toBeGreaterThanOrEqual(1);
	});

	test('cross-session pending-route overflow is bounded and never throws', async () => {
		for (let i = 0; i < 503; i++) {
			const sessionID = `cap-session-${i}`;
			ensureAgentSession(sessionID);
			const hooks = createGuardrailsHooks(directory, config(false));
			await hooks.toolBefore(
				{ tool: 'pre_check_batch', sessionID, callID: `cs-${i}` },
				{ args: {} },
			);
		}
		resetSwarmState();
		ensureAgentSession('architect');
		const hooks = createGuardrailsHooks(directory, config(false));
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'cs-final' },
			{ args: {} },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'cs-final' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);
		expect(routeEvents(directory).length).toBeGreaterThanOrEqual(1);
	});
});
