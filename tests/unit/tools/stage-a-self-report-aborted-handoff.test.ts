/**
 * Stage A self-report — ABORTED background-handoff live wedge (task 2.17,
 * 2026-11-26 swarm_communication_debug).
 *
 * The 2.17 shape: a background coder delegation's foreground settlement WAL
 * is ABORTED ("ownership transferred to durable background completion"),
 * the background round recorded its accepted mutation (last transition
 * `background-coder:…`), and the task sits at `coder_delegated` with no
 * pre_check gate proof. The architect completed the remaining work itself
 * (45-min session breaker NEED-handoff) and ran a green `pre_check_batch`
 * through Code Mode — the only Stage A producer on regressed hosts. Before
 * the fix the durable fallback ignored ABORTED WALs entirely and the exact-
 * path binding rejected directory-valued declared scopes, so the green pass
 * dead-ended as `no_task_correlation` and the only remediation was the
 * human-only `/swarm recover`.
 *
 * These tests pin the healed contract: the green pass binds through the
 * ABORTED WAL's declared scope (directory-aware) and records the mechanical
 * `stage_a_passed` in the same gate run — plus the fail-closed controls
 * (no mutation, ambiguity, out-of-scope files, WAL-less background rounds).
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

interface RouteEvent {
	route: string;
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
	directory = canonicalMkdtemp('swarm-self-report-aborted-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

/** The 2.17 evidence shape: background-coder accepted mutation, no proof. */
async function settleBackgroundAccepted(
	taskId: string,
	transitionId: string,
): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId,
	});
}

/** The ABORTED handoff WAL carrying the declared scope. */
function writeAbortedHandoffWal(taskId: string, declaredFiles: string[]): void {
	fs.mkdirSync(path.join(directory, '.swarm', 'coder-settlements'), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`),
		JSON.stringify({
			version: 1,
			state: 'ABORTED',
			taskId,
			transitionId: `coder:call-${taskId}`,
			actor: 'test',
			processId: process.pid,
			runtimeId: '00000000-0000-4000-8000-000000000000',
			expectedGeneration: 0,
			context: {
				declaredFiles,
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
			recordedAt: new Date().toISOString(),
			abortReason: 'ownership transferred to durable background completion',
			cleanupComplete: true,
		}),
	);
}

function reportPass(files: string[], callId: string): Promise<void> {
	ensureAgentSession('architect');
	return reportToolSideStageA({
		sessionID: 'architect',
		directory,
		serializedResult: PASS_PAYLOAD,
		files,
		toolCallId: callId,
	});
}

describe('stage-a-self-report — ABORTED background-handoff live wedge', () => {
	test('a green pre_check under the handed-off directory scope records stage_a_passed in the same gate run', async () => {
		await settleBackgroundAccepted('2.17', 'background-coder:child-1');
		writeAbortedHandoffWal('2.17', ['tools/native_reference']);

		await reportPass(
			['tools/native_reference/imported_profile.py'],
			'self:aborted:1',
		);

		const evidence = await readTaskEvidence(directory, '2.17');
		const snapshot = getTaskWorkflowSnapshot(evidence);
		expect(snapshot.state).toBe('pre_check_passed');
		expect(snapshot.lastOutcome).toBe('stage_a_passed');
		expect(typeof snapshot.lastTransitionId).toBe('string');
		expect(snapshot.lastTransitionId).toMatch(/^pre-check-tool:self:aborted:1/);
		expect(evidence?.gates?.pre_check).toBeDefined();
		expect(evidence?.gates?.pre_check?.sessionId).toBe('system');
		const events = routeEvents(directory);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			route: 'valid_pass',
			taskId: '2.17',
		});
	});

	test('an aborted handoff without an accepted mutation stays unattributed', async () => {
		await transitionTaskWorkflowEvidence(directory, '2.17', {
			type: 'dispatch_no_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'background-coder:child-1',
		});
		writeAbortedHandoffWal('2.17', ['tools/native_reference']);

		await reportPass(
			['tools/native_reference/imported_profile.py'],
			'self:aborted:2',
		);

		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.17'),
		);
		expect(snapshot.state).toBe('idle');
		expect(snapshot.lastOutcome).toBe('dispatch_no_mutation');
		const session = ensureAgentSession('architect');
		const advisory = session.pendingAdvisoryMessages?.find((m) =>
			m.includes('STAGE A RECEIPT NOT ATTRIBUTED'),
		);
		expect(advisory).toBeDefined();
		expect(routeEvents(directory)[0]).toMatchObject({
			route: 'no_task_correlation',
		});
	});

	test('a foreground accepted_mutation (non-background transition) does not qualify through the ABORTED arm', async () => {
		await transitionTaskWorkflowEvidence(directory, '2.17', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:call-foreground',
		});
		writeAbortedHandoffWal('2.17', ['tools/native_reference']);

		await reportPass(
			['tools/native_reference/imported_profile.py'],
			'self:aborted:3',
		);

		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.17'),
		);
		expect(snapshot.state).toBe('coder_delegated');
		expect(routeEvents(directory)[0]).toMatchObject({
			route: 'no_task_correlation',
		});
	});

	test('two live-wedge candidates are ambiguous and fail closed', async () => {
		await settleBackgroundAccepted('2.17', 'background-coder:child-1');
		await settleBackgroundAccepted('2.18', 'background-coder:child-2');
		writeAbortedHandoffWal('2.17', ['tools/native_reference']);
		writeAbortedHandoffWal('2.18', ['tools/native_reference']);

		await reportPass(
			['tools/native_reference/imported_profile.py'],
			'self:aborted:4',
		);

		for (const taskId of ['2.17', '2.18']) {
			const snapshot = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, taskId),
			);
			expect(snapshot.state).toBe('coder_delegated');
		}
		expect(routeEvents(directory)[0]).toMatchObject({
			route: 'no_task_correlation',
		});
	});

	test('caller files outside the declared scope do not bind', async () => {
		await settleBackgroundAccepted('2.17', 'background-coder:child-1');
		writeAbortedHandoffWal('2.17', ['tools/native_reference']);

		await reportPass(['docs/unrelated.md'], 'self:aborted:5');

		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.17'),
		);
		expect(snapshot.state).toBe('coder_delegated');
		expect(routeEvents(directory)[0]).toMatchObject({
			route: 'no_task_correlation',
		});
	});

	test('a COMMITTED directory-scoped settlement binds its green pre_check (eligible-arm directory binding)', async () => {
		await transitionTaskWorkflowEvidence(directory, '2.19', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:call-committed',
		});
		fs.mkdirSync(path.join(directory, '.swarm', 'coder-settlements'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(directory, '.swarm', 'coder-settlements', '2.19.json'),
			JSON.stringify({
				version: 1,
				state: 'COMMITTED',
				taskId: '2.19',
				transitionId: 'coder:call-committed',
				actor: 'test',
				processId: process.pid,
				runtimeId: '00000000-0000-4000-8000-000000000000',
				expectedGeneration: 1,
				context: {
					declaredFiles: ['tests/prompt09_native'],
					baseline: {
						directory,
						gitHead: null,
						dirtyHash: null,
						prHeadSha: null,
						scope: null,
						changedFiles: [],
					},
				},
				accepted: true,
				recordedAt: new Date().toISOString(),
			}),
		);

		await reportPass(
			['tests/prompt09_native/test_coupled_prefix.py'],
			'self:aborted:6',
		);

		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '2.19'),
		);
		expect(snapshot.state).toBe('pre_check_passed');
		expect(snapshot.lastOutcome).toBe('stage_a_passed');
		expect(routeEvents(directory)[0]).toMatchObject({
			route: 'valid_pass',
			taskId: '2.19',
		});
	});
});
