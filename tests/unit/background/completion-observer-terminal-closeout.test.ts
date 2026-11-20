import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { telemetry } from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function writePlan(directory: string): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Closeout Plan',
		swarm: 'closeout',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

function completionEvent(
	childSessionId: string,
	state: 'completed' | 'error' | 'cancelled',
	body: string,
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: 'ses_closeout_parent',
					text: `<task id="${childSessionId}" state="${state}">\n${body}\n</task>`,
				},
			},
		},
	};
}

const COMPLETED_BODY =
	'<task_result>Work done. [REVIEWED] | 1.1 | APPROVED | ok</task_result>';

async function recordPending(
	directory: string,
	options: {
		childSessionId?: string;
		agent?: string;
		batchId?: string;
		planTaskId?: string | null;
	} = {},
): Promise<void> {
	const child = options.childSessionId ?? 'ses_closeout_child';
	const agent = options.agent ?? 'reviewer';
	await recordPendingDelegation(directory, {
		correlationId: child,
		jobId: `job-${child}`,
		subagentSessionId: child,
		parentSessionId: 'ses_closeout_parent',
		callID: 'call-closeout-1',
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: options.planTaskId === undefined ? '1.1' : options.planTaskId,
		evidenceTaskId:
			options.planTaskId === undefined ? '1.1' : options.planTaskId,
		...(options.batchId ? { batchId: options.batchId } : {}),
		workspace: captureWorkspaceSnapshot(directory),
	});
}

/** Stub telemetry.delegationEnd, capturing emissions; restored in finally. */
function captureDelegationEnds(): {
	events: Array<{
		sessionId: string;
		agentName: string;
		result: string;
		record_id?: string;
	}>;
	restore: () => void;
} {
	const events: Array<{
		sessionId: string;
		agentName: string;
		result: string;
		record_id?: string;
	}> = [];
	const orig = telemetry.delegationEnd;
	(telemetry as { delegationEnd: unknown }).delegationEnd = (
		sessionId: string,
		agentName: string,
		_taskId: string,
		result: string,
		costFields?: Record<string, unknown>,
	) => {
		events.push({
			sessionId,
			agentName,
			result,
			...(typeof costFields?.record_id === 'string'
				? { record_id: costFields.record_id }
				: {}),
		});
	};
	return {
		events,
		restore: () => {
			(telemetry as { delegationEnd: unknown }).delegationEnd = orig;
		},
	};
}

describe('background completion observer — shared terminal closeout (F2/F3/F4, r12)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-closeout-'));
		writePlan(directory);
		// The parent session must exist for in-memory advisories.
		ensureAgentSession('ses_closeout_parent', 'architect', directory);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('F2: a verified async completion writes the context-map summary exactly once', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		const event = completionEvent(
			'ses_closeout_child',
			'completed',
			COMPLETED_BODY,
		);
		await observer.event(event);
		// Duplicate delivery (host replay) must not double-append.
		await observer.event(event);

		const map = loadContextMap(directory);
		expect(map).not.toBeNull();
		const summary = map?.task_history['1.1'];
		expect(summary).toBeDefined();
		// deriveFinalStatus maps a verified successful completion to
		// 'approved' — the same mapping the sync handoff produces.
		expect(summary?.final_status).toBe('approved');
		// implementation_summary carries the verified result text (bounded).
		expect(summary?.implementation_summary).toContain('[REVIEWED]');
	});

	test('F2: a coder completion records the same approved mapping as the sync handoff', async () => {
		await recordPending(directory, { agent: 'coder' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(
			completionEvent(
				'ses_closeout_child',
				'completed',
				'<task_result>Implemented the change.</task_result>',
			),
		);
		const summary = loadContextMap(directory)?.task_history['1.1'];
		expect(summary).toBeDefined();
		expect(summary?.final_status).toBe('approved');
	});

	test('F2: no context-map write when the feature is disabled', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent('ses_closeout_child', 'completed', COMPLETED_BODY),
		);
		const map = loadContextMap(directory);
		expect(map?.task_history['1.1']).toBeUndefined();
	});

	test('F2: a failed child completion never records a completed summary', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(
			completionEvent(
				'ses_closeout_child',
				'error',
				'<task_error>provider failed</task_error>',
			),
		);
		const map = loadContextMap(directory);
		expect(map?.task_history['1.1']).toBeUndefined();
	});

	test('F4: a completed terminal emits exactly one pairing delegation_end', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const capture = captureDelegationEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			const event = completionEvent(
				'ses_closeout_child',
				'completed',
				COMPLETED_BODY,
			);
			await observer.event(event);
			await observer.event(event);
			const record = findByCorrelationId(directory, 'ses_closeout_child');
			if (record) await observer.reconcilePending(record);
		} finally {
			capture.restore();
		}
		expect(capture.events.length).toBe(1);
		expect(capture.events[0]?.sessionId).toBe('ses_closeout_parent');
		expect(capture.events[0]?.agentName).toBe('reviewer');
		expect(capture.events[0]?.result).toBe('completed');
		expect(capture.events[0]?.record_id).toHaveLength(32);
	});

	test('F4: a cancelled terminal emits the failed pairing delegation_end exactly once', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const capture = captureDelegationEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			const event = completionEvent(
				'ses_closeout_child',
				'cancelled',
				'<task_error>cancelled</task_error>',
			);
			await observer.event(event);
			await observer.event(event);
		} finally {
			capture.restore();
		}
		expect(capture.events.length).toBe(1);
		expect(capture.events[0]?.result).toBe('cancelled');
	});

	test('F4: lane records never emit a second delegation_end from the observer', async () => {
		await recordPending(directory, {
			agent: 'reviewer',
			batchId: 'batch-1',
		});
		const capture = captureDelegationEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			await observer.event(
				completionEvent('ses_closeout_child', 'completed', COMPLETED_BODY),
			);
		} finally {
			capture.restore();
		}
		expect(capture.events.length).toBe(0);
	});

	test('F3: a critic_sounding_board completion applies the shared verdict policy and advises the parent', async () => {
		await recordPending(directory, { agent: 'critic_sounding_board' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_closeout_child',
				'completed',
				'<task_result>Verdict: APPROVED\nCategory: architecture\nReasoning: sound approach</task_result>',
			),
		);
		const session = swarmState.agentSessions.get('ses_closeout_parent');
		expect(session).toBeDefined();
		const advisory = session?.pendingAdvisoryMessages?.find((message) =>
			message.includes('[SOUNDING_BOARD] Verdict: APPROVED'),
		);
		expect(advisory).toBeDefined();
		expect(session?.lastDelegationReason).toBe('critic_consultation');
	});

	test('F3: an unparseable sounding-board response is treated as REPHRASE, never approval', async () => {
		await recordPending(directory, { agent: 'critic_sounding_board' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_closeout_child',
				'completed',
				'<task_result>no structured verdict here at all</task_result>',
			),
		);
		const session = swarmState.agentSessions.get('ses_closeout_parent');
		const advisory = session?.pendingAdvisoryMessages?.find((message) =>
			message.includes('[SOUNDING_BOARD] WARNING'),
		);
		expect(advisory).toBeDefined();
		expect(advisory).toContain('Treat as REPHRASE');
	});

	test('F3/F4 parity: reviewer/critic completions prompt the pipeline continuation advisory once', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		const event = completionEvent(
			'ses_closeout_child',
			'completed',
			COMPLETED_BODY,
		);
		await observer.event(event);
		await observer.event(event);
		const session = swarmState.agentSessions.get('ses_closeout_parent');
		const pipeline = session?.pendingAdvisoryMessages?.filter((message) =>
			message.includes('[PIPELINE] reviewer delegation complete'),
		);
		expect(pipeline?.length).toBe(1);
	});

	test('F2/F4: a taskless completion emits delegation_end but no context-map summary', async () => {
		await recordPending(directory, {
			agent: 'reviewer',
			planTaskId: null,
		});
		const capture = captureDelegationEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			await observer.event(
				completionEvent('ses_closeout_child', 'completed', COMPLETED_BODY),
			);
		} finally {
			capture.restore();
		}
		expect(capture.events.length).toBe(1);
		const map = loadContextMap(directory);
		expect(Object.keys(map?.task_history ?? {})).toHaveLength(0);
	});
});
