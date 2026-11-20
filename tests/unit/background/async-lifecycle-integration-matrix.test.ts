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
import { isPlanCriticApproved } from '../../../src/hooks/delegation-gate';
import {
	computePlanStructureHash,
	initLedger,
	readLedgerEventsWithIntegrity,
} from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { telemetry } from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

/**
 * r11-r13 integration matrix: the async lifecycle states from the repair
 * contract, driven end-to-end through the trusted completion observer.
 *
 | Zustand | Erwartung |
 | --- | --- |
 | Child gestartet, running | Keine terminalen Seiteneffekte |
 | Child erfolgreich abgeschlossen | Einmalige fachliche Closeout-Verarbeitung |
 | Child fehlgeschlagen | Keine falsche Erfolgsfreigabe |
 | Child abgebrochen | Korrekte Fehler-/Cleanup-Verarbeitung |
 | Doppeltes Completion-Event | Keine doppelten Seiteneffekte |
 | Out-of-order-Events | Keine unzulässige Zustandsrückwärtsbewegung |
 | Falsche Parent-/Child-ID | Ablehnung |
 | Geänderter Plan nach Critic-Dispatch | Kein altes Approval |
 | Prozessneustart und Replay | Korrekte Wiederaufnahme |
 | Gleichzeitige Child-Sessions | Keine gegenseitige Vermischung |
 | Synchroner Legacy-Abschluss | Unverändertes korrektes Verhalten |
 */

const PARENT = 'ses_matrix_parent';

function writePlan(directory: string, title = 'Matrix Plan'): Plan {
	const plan: Plan = {
		schema_version: '1.0.0',
		title,
		swarm: 'matrix',
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
	return plan;
}

function completionEvent(
	childSessionId: string,
	state: 'completed' | 'error' | 'cancelled',
	body: string,
	parentSessionId = PARENT,
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text: `<task id="${childSessionId}" state="${state}">\n${body}\n</task>`,
				},
			},
		},
	};
}

async function recordChild(
	directory: string,
	options: {
		child: string;
		callId: string;
		agent?: string;
		taskId?: string | null;
		planCritic?: boolean;
		plan?: Plan;
		workflowGeneration?: number;
	},
): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: options.child,
		jobId: `job-${options.child}`,
		subagentSessionId: options.child,
		parentSessionId: PARENT,
		callID: options.callId,
		normalizedAgent: options.agent ?? 'explorer',
		swarmPrefixedAgent: options.agent ?? 'explorer',
		planTaskId: options.taskId === undefined ? null : options.taskId,
		evidenceTaskId: options.taskId === undefined ? null : options.taskId,
		// Gate-bearing roles require a dispatch-time workflow generation for
		// Stage-B ingestion (same fixture shape as the docs-participation
		// observer tests).
		...(options.taskId
			? {
					workflowGeneration:
						options.workflowGeneration !== undefined
							? options.workflowGeneration
							: 0,
				}
			: {}),
		workspace: captureWorkspaceSnapshot(directory),
		...(options.planCritic && options.plan
			? {
					planCriticDispatch: {
						planStructureHash: computePlanStructureHash(options.plan),
						recordedAt: Date.now(),
					},
				}
			: {}),
	});
}

function captureEnds(): { count: () => number; restore: () => void } {
	let n = 0;
	const orig = telemetry.delegationEnd;
	(telemetry as { delegationEnd: unknown }).delegationEnd = () => {
		n += 1;
	};
	return {
		count: () => n,
		restore: () => {
			(telemetry as { delegationEnd: unknown }).delegationEnd = orig;
		},
	};
}

describe('async lifecycle integration matrix (r11-r13)', () => {
	let directory: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('async-matrix-'));
		plan = writePlan(directory);
		ensureAgentSession(PARENT, 'architect', directory);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('running start: a dispatch event for a live child has no terminal side effects', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordChild(directory, { child: 'ses_m_running', callId: 'c-run' });
		const ends = captureEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			// A running-state envelope is not terminal — the observer ignores it.
			await observer.event({
				event: {
					type: 'message.part.updated',
					properties: {
						part: {
							type: 'text',
							synthetic: true,
							sessionID: PARENT,
							text: '<task id="ses_m_running" state="running">\n<summary>started</summary>\n</task>',
						},
					},
				},
			});
		} finally {
			ends.restore();
		}
		const record = findByCorrelationId(directory, 'ses_m_running');
		expect(record?.status).toBe('pending');
		expect(record?.terminalResult).toBeUndefined();
		expect(ends.count()).toBe(0);
		expect(loadContextMap(directory)?.task_history['1.1']).toBeUndefined();
	});

	test('successful completion: exactly-once closeout across telemetry, context map, and advisory', async () => {
		await initLedger(directory, derivePlanId(plan));
		// r13 (P1-2): the context-map success summary requires a REAL Stage-B
		// success — seed the accepted-mutation state and bind the launch
		// generation, so the reviewer's APPROVED verdict genuinely ingests.
		const parent = ensureAgentSession(PARENT, 'architect', directory);
		parent.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(directory, '1.1');
		await recordChild(directory, {
			child: 'ses_m_ok',
			callId: 'c-ok',
			agent: 'reviewer',
			taskId: '1.1',
			workflowGeneration: generation,
		});
		const ends = captureEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			const event = completionEvent(
				'ses_m_ok',
				'completed',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | ok</task_result>',
			);
			await observer.event(event);
			await observer.event(event);
			const record = findByCorrelationId(directory, 'ses_m_ok');
			if (record) await observer.reconcilePending(record);
		} finally {
			ends.restore();
		}
		const record = findByCorrelationId(directory, 'ses_m_ok');
		// A fully-ingested Stage-B completion ends 'consumed' (post-terminal
		// machinery); the immutable terminal stays 'completed'.
		expect(record?.status).toBe('consumed');
		expect(record?.terminalResult?.status).toBe('completed');
		expect(ends.count()).toBe(1);
		// r14 (P1-5): the child-level success writes the NON-FINAL summary —
		// 'approved' only after the authoritative task release.
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'pending',
		);
		const session = swarmState.agentSessions.get(PARENT);
		const completions =
			session?.pendingAdvisoryMessages?.filter((m) =>
				m.includes('[BACKGROUND COMPLETION'),
			) ?? [];
		// The durable advisory inbox replaces on the same eventId: exactly one.
		expect(completions.length).toBe(1);
	});

	test('failed and cancelled children: no success side effects, cleanup advisories, no false approval', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordChild(directory, {
			child: 'ses_m_fail',
			callId: 'c-fail',
			taskId: '1.1',
		});
		await recordChild(directory, {
			child: 'ses_m_cancel',
			callId: 'c-cancel',
			taskId: '1.1',
		});
		const ends = captureEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			await observer.event(
				completionEvent(
					'ses_m_fail',
					'error',
					'<task_error>child crashed</task_error>',
				),
			);
			await observer.event(
				completionEvent(
					'ses_m_cancel',
					'cancelled',
					'<task_error>user cancelled</task_error>',
				),
			);
		} finally {
			ends.restore();
		}
		expect(findByCorrelationId(directory, 'ses_m_fail')?.status).toBe('error');
		expect(findByCorrelationId(directory, 'ses_m_cancel')?.status).toBe(
			'cancelled',
		);
		expect(ends.count()).toBe(2);
		const map = loadContextMap(directory);
		expect(map?.task_history['1.1']).toBeUndefined();
		expect(await isPlanCriticApproved(directory)).toBe(false);
	});

	test('wrong parent/child identity: rejected without any side effect', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordChild(directory, { child: 'ses_m_id', callId: 'c-id' });
		const ends = captureEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			// Wrong parent.
			await observer.event(
				completionEvent(
					'ses_m_id',
					'completed',
					'<task_result>x</task_result>',
					'ses_foreign_parent',
				),
			);
			// Unknown child.
			await observer.event(
				completionEvent(
					'ses_unknown_child',
					'completed',
					'<task_result>x</task_result>',
				),
			);
		} finally {
			ends.restore();
		}
		expect(findByCorrelationId(directory, 'ses_m_id')?.status).toBe('pending');
		expect(ends.count()).toBe(0);
	});

	test('out-of-order: a late conflicting terminal cannot undo a settled completion', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordChild(directory, { child: 'ses_m_ooo', callId: 'c-ooo' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_m_ooo',
				'completed',
				'<task_result>done</task_result>',
			),
		);
		// A late CANCELLED for the same child (different result digest) is a
		// distinct terminal event — rejected as a late terminal, never applied.
		await observer.event(
			completionEvent(
				'ses_m_ooo',
				'cancelled',
				'<task_error>late cancellation</task_error>',
			),
		);
		const record = findByCorrelationId(directory, 'ses_m_ooo');
		expect(record?.status).toBe('completed');
		expect(record?.terminalResult?.status).toBe('completed');
	});

	test('process restart and replay: a fresh observer instance resumes without double effects', async () => {
		await initLedger(directory, derivePlanId(plan));
		// r13 (P1-2): same real-Stage-B seeding as the success test above.
		const parent = ensureAgentSession(PARENT, 'architect', directory);
		parent.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(directory, '1.1');
		await recordChild(directory, {
			child: 'ses_m_restart',
			callId: 'c-restart',
			agent: 'reviewer',
			taskId: '1.1',
			workflowGeneration: generation,
		});
		const ends = captureEnds();
		try {
			// "Process 1": claims the terminal, runs the closeout, then "crashes".
			const observer1 = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			await observer1.event(
				completionEvent(
					'ses_m_restart',
					'completed',
					'<task_result>[REVIEWED] | 1.1 | APPROVED | ok</task_result>',
				),
			);
		} finally {
			ends.restore();
		}
		const ends2 = captureEnds();
		try {
			// "Process 2" (fresh instance over the same durable store): the same
			// completion event replays (host redelivery) and the durable
			// maintenance replay path both re-enter — no side effect repeats.
			const observer2 = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			await observer2.event(
				completionEvent(
					'ses_m_restart',
					'completed',
					'<task_result>[REVIEWED] | 1.1 | APPROVED | ok</task_result>',
				),
			);
			const record = findByCorrelationId(directory, 'ses_m_restart');
			if (record) await observer2.reconcilePending(record);
		} finally {
			ends2.restore();
		}
		expect(ends2.count()).toBe(0);
		const record = findByCorrelationId(directory, 'ses_m_restart');
		expect(record?.status).toBe('consumed');
		expect(record?.terminalResult?.status).toBe('completed');
		// r14 (P1-5): the child-level success writes the NON-FINAL summary —
		// 'approved' only after the authoritative task release.
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'pending',
		);
	});

	test('concurrent child sessions: completions settle their own records without cross-contamination', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordChild(directory, {
			child: 'ses_m_a',
			callId: 'c-a',
			agent: 'reviewer',
			taskId: '1.1',
		});
		await recordChild(directory, {
			child: 'ses_m_b',
			callId: 'c-b',
			agent: 'explorer',
			taskId: null,
		});
		const ends = captureEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			// Interleaved delivery.
			await observer.event(
				completionEvent(
					'ses_m_b',
					'completed',
					'<task_result>explored</task_result>',
				),
			);
			await observer.event(
				completionEvent(
					'ses_m_a',
					'completed',
					'<task_result>[REVIEWED] | 1.1 | APPROVED | ok</task_result>',
				),
			);
		} finally {
			ends.restore();
		}
		const a = findByCorrelationId(directory, 'ses_m_a');
		const b = findByCorrelationId(directory, 'ses_m_b');
		expect(a?.status).toBe('consumed');
		expect(a?.terminalResult?.status).toBe('completed');
		expect(b?.status).toBe('completed');
		expect(a?.callID).toBe('c-a');
		expect(b?.callID).toBe('c-b');
		expect(a?.terminalResult?.result.text).toContain('[REVIEWED]');
		expect(b?.terminalResult?.result.text).toContain('explored');
		expect(ends.count()).toBe(2);
	});

	test('changed plan after critic dispatch: no stale approval (matrix row 8)', async () => {
		await initLedger(directory, derivePlanId(plan));
		await recordChild(directory, {
			child: 'ses_m_critic',
			callId: 'c-critic',
			agent: 'critic',
			taskId: null,
			planCritic: true,
			plan,
		});
		// The plan is edited while the async critic runs.
		writePlan(directory, 'Edited During Critic Run');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_m_critic',
				'completed',
				'<task_result>VERDICT: APPROVED</task_result>',
			),
		);
		expect(await isPlanCriticApproved(directory)).toBe(false);
		const integrity = await readLedgerEventsWithIntegrity(directory);
		const gateSnapshots = integrity.events.filter(
			(e) =>
				e.event_type === 'snapshot' &&
				(e.payload as { approval?: { source?: string } })?.approval?.source ===
					'plan_critic_gate',
		);
		expect(gateSnapshots.length).toBe(0);
	});

	test('synchronous legacy completion stays intact: foreground Task results keep their handoff behavior', async () => {
		// The sync path is exercised through the real plugin hook (same harness
		// as the placeholder tests): a foreground completion must produce the
		// pipeline advisory and context-map summary exactly as before r11-r13.
		const { bootKnowledgeHost, createKnowledgeProject } = await import(
			'../../helpers/knowledge-real-host.js'
		);
		const { safeRmRecursive } = await import('../../helpers/safe-test-dir.js');
		const dir = createKnowledgeProject();
		try {
			const plugin = await bootKnowledgeHost(dir, {
				context_map: { enabled: true },
			});
			const after = plugin.hooks['tool.execute.after'];
			const session = ensureAgentSession('legacy-parent', 'reviewer', dir);
			session.currentTaskId = '1.1';
			session.taskWorkflowStates.set('1.1', 'coder_delegated');
			session.delegationActive = true;
			swarmState.activeAgent.set('legacy-parent', 'reviewer');
			await after(
				{
					tool: 'Task',
					sessionID: 'legacy-parent',
					callID: 'legacy-call',
				},
				{ state: 'completed', output: 'review passed' },
			);
			expect(swarmState.activeAgent.get('legacy-parent')).toBe('architect');
			expect(
				session.pendingAdvisoryMessages?.some((m) => m.includes('[PIPELINE]')),
			).toBe(true);
		} finally {
			resetSwarmState();
			safeRmRecursive(dir);
		}
	});
});
