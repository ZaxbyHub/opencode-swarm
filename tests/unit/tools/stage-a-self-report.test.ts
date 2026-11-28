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
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCoreEvents } from '../../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { STAGE_A_ROUTE_EVENT_TYPE } from '../../../src/hooks/guardrails/stage-a-route';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { reportToolSideStageA } from '../../../src/tools/stage-a-self-report';
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

let restoreClock: Restore;

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: Date.now() });
	directory = canonicalMkdtemp('swarm-self-report-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	resetSwarmState();
});

afterEach(() => {
	restoreClock();
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

	test('2026-11-27 (task 2.18): an infrastructure-only fail records NO transition — retry budget untouched, infra route emitted', async () => {
		await settle('1.2');
		const infraPayload = JSON.stringify({
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
			sast_scan: {
				ran: true,
				duration_ms: 1,
				result: { verdict: 'pass', findings: [] },
				error:
					'Failed to persist sast evidence: Evidence bundle size (528522 bytes) exceeds maximum (512000 bytes)',
			},
			quality_budget: { ran: false, duration_ms: 0 },
		});
		await report(infraPayload, {
			sessionTaskId: '1.2',
			callId: 'self:infra:1',
		});
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.2'),
		);
		expect(snapshot.state).toBe('coder_delegated');
		expect(snapshot.retryCount).toBe(0);
		expect(snapshot.retryHistory).toEqual([]);
		expect(snapshot.lastOutcome).toBe('accepted_mutation');
		const events = routeEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			route: 'pre_check_infra_failed',
			taskId: '1.2',
		});
	});

	test('2026-11-27 (task 2.18): repeated infra fails never spiral the retry counter', async () => {
		await settle('1.3');
		const infraPayload = JSON.stringify({
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
			sast_scan: {
				ran: true,
				duration_ms: 1,
				result: { verdict: 'pass', findings: [] },
				error: 'Semgrep execution failed: spawn ENOENT',
			},
			quality_budget: { ran: false, duration_ms: 0 },
		});
		for (let i = 1; i <= 5; i++) {
			await report(infraPayload, {
				sessionTaskId: '1.3',
				callId: `self:infra:x${i}`,
			});
		}
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.3'),
		);
		expect(snapshot.state).toBe('coder_delegated');
		expect(snapshot.retryCount).toBe(0);
		expect(snapshot.retryHistory).toEqual([]);
		expect(
			routeEvents(directory).filter(
				(event) => event.route === 'pre_check_infra_failed',
			),
		).toHaveLength(5);
	});

	test('fail-open: a decode-skipped (invalid) result reports nothing', async () => {
		await report('definitely not json {{{');
		const session = ensureAgentSession('architect');
		expect(
			session.pendingAdvisoryMessages?.some((m) => m.includes('STAGE A')),
		).toBeFalsy();
		expect(routeEvents(directory)).toHaveLength(0);
	});

	test('uncorrelated pass over a terminal-settlement wedge routes terminal_settlement_wedge with the recover_stage_a_task remediation', async () => {
		// The 2026-11-23 swarm_communication_debug incident shape: the resume
		// session holds no currentTaskId, the task's COMMITTED settlement is
		// already terminal (no mutation attributed), and the workflow sits at
		// authoritative idle. On regressed hosts (nested Code Mode calls) this
		// module is the ONLY Stage A producer, so the wedge must be
		// distinguishable from an ad-hoc gate run here too.
		await transitionTaskWorkflowEvidence(directory, '1.8', {
			type: 'dispatch_no_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:wal-1.8',
		});
		fs.mkdirSync(path.join(directory, '.swarm', 'coder-settlements'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(directory, '.swarm', 'coder-settlements', '1.8.json'),
			JSON.stringify({
				version: 1,
				state: 'COMMITTED',
				taskId: '1.8',
				transitionId: 'coder:wal-1.8',
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
					declaredFiles: ['AGENTS.md'],
				},
				accepted: false,
				recordedAt: new Date().toISOString(),
			}),
		);

		// The session must exist before the report so the advisory has a live
		// surface to land on (mirrors the report() helper's ensureAgentSession).
		ensureAgentSession('architect');
		await reportToolSideStageA({
			sessionID: 'architect',
			directory,
			serializedResult: PASS_PAYLOAD,
			files: ['AGENTS.md'],
			toolCallId: 'self:wedge:1',
		});

		// No mechanical write from idle.
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.8'),
		);
		expect(snapshot.state).toBe('idle');
		const session = ensureAgentSession('architect');
		const advisory = session.pendingAdvisoryMessages?.find((m) =>
			m.includes('STAGE A WEDGE (TERMINAL SETTLEMENT)'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('1.8');
		expect(advisory).toContain('recover_stage_a_task');
		const events = routeEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			route: 'terminal_settlement_wedge',
			taskId: '1.8',
		});
	});

	test('a mis-settled background no-mutation reconciles and records stage_a_passed in the same gate run', async () => {
		// The exact pre-fix directory-scope wedge shape: the workflow's last
		// transition is a background-coder dispatch_no_mutation although the
		// delegation record's baseline shows real in-scope changes in the
		// working tree. The self-report must reconcile the accepted mutation
		// and then record stage_a_passed — no fresh coder round, no recover.
		const { spawnSync } = await import('node:child_process');
		const os = await import('node:os');
		const git = (...args: string[]) => {
			const result = spawnSync('git', args, {
				cwd: directory,
				stdio: 'ignore',
				timeout: 5_000,
				windowsHide: true,
			});
			if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
		};
		git('init', '-b', 'main');
		git('config', 'user.email', 'test@example.com');
		git('config', 'user.name', 'Test');
		fs.mkdirSync(path.join(directory, 'context'), { recursive: true });
		fs.writeFileSync(path.join(directory, 'context/entry-a.md'), 'v1\n');
		fs.writeFileSync(path.join(directory, 'context/entry-b.md'), 'v1\n');
		git('add', 'context/entry-a.md', 'context/entry-b.md');
		git('commit', '-m', 'fixture');
		const { captureWorkspaceSnapshot } = await import(
			'../../../src/background/workspace-snapshot'
		);
		const baseline = captureWorkspaceSnapshot(directory);
		// The coder's real (uncommitted) changes under the declared directory.
		fs.writeFileSync(path.join(directory, 'context/entry-a.md'), 'v2\n');

		const correlationId = 'child-reconcile-1';
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'background-delegations.jsonl'),
			`${JSON.stringify({
				schemaVersion: 3,
				correlationId,
				jobId: null,
				subagentSessionId: correlationId,
				parentSessionId: 'architect-parent',
				callID: 'call-reconcile-1',
				normalizedAgent: 'coder',
				swarmPrefixedAgent: 'astra_coder',
				planTaskId: '1.1',
				evidenceTaskId: '1.1',
				status: 'consumed',
				createdAt: Date.now() - 60_000,
				updatedAt: Date.now(),
				taskChangeContext: {
					baseline,
					declaredFiles: ['context'],
				},
			})}\n`,
		);

		// Wedge shape: idle with the background no-mutation as last transition.
		await settle('1.1');
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'repair_idle',
			expectedGeneration: 1,
			transitionId: 'repair:reconcile-test',
		});
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'dispatch_no_mutation',
			agentType: 'coder',
			expectedGeneration: 2,
			transitionId: `background-coder:${correlationId}`,
		});

		await report(PASS_PAYLOAD, { sessionTaskId: '1.1' });

		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(snapshot.state).toBe('pre_check_passed');
		expect(snapshot.lastOutcome).toBe('stage_a_passed');
		const session = ensureAgentSession('architect');
		const advisory = session.pendingAdvisoryMessages?.find((m) =>
			m.includes('STAGE A RECONCILED'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('1.1');
		const events = routeEvents(directory);
		expect(events.some((event) => event.route === 'valid_pass')).toBe(true);
	});
});
