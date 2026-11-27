/**
 * r13 audit repair (P2-2): durable closeout advisories.
 *
 * Split from tests/unit/background/completion-observer-closeout-recovery.test.ts
 * (FR-006 file cap); shared fixtures live in
 * tests/helpers/closeout-recovery-fixtures.ts. Sounding-board and pipeline
 * advisories survive on the delegation record's durable closeout advisory
 * list without a live parent session, never clobber the terminal advisory,
 * and dedupe by eventId (idempotent replay).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	claimTerminalResult,
	findByCorrelationId,
	preparePendingBackgroundAdvisories,
	putTerminalCloseoutAdvisory,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	completionEvent,
	manualTerminal,
	recordPending,
	writePlan,
} from '../../helpers/closeout-recovery-fixtures';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('background completion observer — durable closeout recovery (r13 P0-3)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-closeout-recovery-'));
		writePlan(directory);
		ensureAgentSession('ses_recovery_parent', 'architect', directory);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});
	test('P2-2: sounding-board and pipeline advisories are durable without a live parent session, and never clobber the terminal advisory', async () => {
		// No parent session in memory — the advisories must survive on the
		// record's durable closeout advisory list.
		resetSwarmState();
		await recordPending(directory, { agent: 'critic_sounding_board' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_recovery_child',
				'completed',
				'<task_result>Verdict: APPROVED\nCategory: architecture\nReasoning: sound</task_result>',
			),
		);

		const record = findByCorrelationId(directory, 'ses_recovery_child');
		// The terminal advisory (single slot) AND the two closeout advisories
		// (sounding-board verdict + pipeline) coexist — no clobbering.
		expect(record?.advisoryInbox).toBeDefined();
		const closeoutAdvisories = record?.closeoutAdvisories ?? [];
		expect(closeoutAdvisories.length).toBe(2);
		const sounding = closeoutAdvisories.find((entry) =>
			entry.message.includes('[SOUNDING_BOARD]'),
		);
		const pipeline = closeoutAdvisories.find((entry) =>
			entry.message.includes('[PIPELINE]'),
		);
		expect(sounding?.message).toContain('Verdict: APPROVED');
		expect(pipeline).toBeDefined();

		// The delivery contract drains them: prepare surfaces one pending
		// durable advisory for the parent, and a replayed completion does not
		// duplicate the stored entries (eventId-deduped).
		const prepared = await preparePendingBackgroundAdvisories(
			directory,
			'ses_recovery_parent',
			{ preparationId: 'prep-1' },
		);
		expect(prepared.length).toBe(1);
		await observer.event(
			completionEvent(
				'ses_recovery_child',
				'completed',
				'<task_result>Verdict: APPROVED\nCategory: architecture\nReasoning: sound</task_result>',
			),
		);
		const afterReplay = findByCorrelationId(directory, 'ses_recovery_child');
		expect((afterReplay?.closeoutAdvisories ?? []).length).toBe(2);
	});

	test('P2-2: putTerminalCloseoutAdvisory dedupes by eventId (idempotent replay)', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		// Establish the trusted terminal first — closeout advisories belong to
		// a terminal, never to an open record.
		const terminal = manualTerminal(
			'<task id="ses_recovery_child" state="completed">\n<task_result>done</task_result>\n</task>',
		);
		expect(terminal).not.toBeNull();
		if (terminal) {
			await claimTerminalResult(directory, 'ses_recovery_child', terminal);
		}
		const first = await putTerminalCloseoutAdvisory(
			directory,
			'ses_recovery_child',
			{
				eventId: 'evt-1:pipeline',
				parentSessionId: 'ses_recovery_parent',
				message: '[PIPELINE] reviewer delegation complete.',
			},
		);
		expect(first).not.toBeNull();
		const second = await putTerminalCloseoutAdvisory(
			directory,
			'ses_recovery_child',
			{
				eventId: 'evt-1:pipeline',
				parentSessionId: 'ses_recovery_parent',
				message: '[PIPELINE] reviewer delegation complete.',
			},
		);
		expect(second?.eventId).toBe(first?.eventId);
		const record = findByCorrelationId(directory, 'ses_recovery_child');
		expect(record?.closeoutAdvisories?.length).toBe(1);
	});
});
