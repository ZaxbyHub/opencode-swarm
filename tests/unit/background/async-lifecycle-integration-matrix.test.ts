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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import type { Plan } from '../../../src/config/plan-schema';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { isPlanCriticApproved } from '../../../src/hooks/delegation-gate';
import { initLedger } from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	captureEnds,
	completionEvent,
	PARENT,
	recordChild,
	writePlan,
} from '../../helpers/async-lifecycle-matrix';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

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
});
