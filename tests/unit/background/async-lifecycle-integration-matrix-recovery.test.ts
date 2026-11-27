/**
 * r11-r13 integration matrix — recovery, approval integrity, and legacy rows.
 *
 * Split from tests/unit/background/async-lifecycle-integration-matrix.test.ts
 * (FR-006 file cap); the shared fixtures live in
 * tests/helpers/async-lifecycle-matrix.ts. Covered matrix rows:
 *
 * | Geänderter Plan nach Critic-Dispatch | Kein altes Approval |
 * | Prozessneustart und Replay | Korrekte Wiederaufnahme |
 * | Synchroner Legacy-Abschluss | Unverändertes korrektes Verhalten |
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import type { Plan } from '../../../src/config/plan-schema';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { isPlanCriticApproved } from '../../../src/hooks/delegation-gate';
import {
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
