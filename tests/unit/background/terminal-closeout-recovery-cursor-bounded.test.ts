/**
 * F-002 (PR 3922 review) regression: `terminalCloseoutRecoveryCursors` is
 * module-level state keyed by canonical project root.
 *
 * Prior buggy behavior: the map grew by one entry per distinct directory
 * seen over process lifetime — no delete/clear, no bound, no eviction, and
 * no `_internals` reset — while the sibling per-directory registries in the
 * same module are explicitly bounded (MAX_TERMINAL_CLOSEOUT_RECONCILERS=8,
 * MAX_LEGACY_CODER_SETTLEMENT_RECONCILERS=32, both with FIFO eviction). A
 * long-lived host process serving many repos/worktrees accumulated the map
 * indefinitely, violating AGENTS.md invariant 8 (module-level global state
 * must have an explicit eviction strategy).
 *
 * The fix bounds the map with the sibling FIFO-eviction pattern (insertion
 * order tracked, most-recently-updated root refreshed, oldest evicted past
 * MAX_TERMINAL_CLOSEOUT_RECOVERY_CURSORS). Eviction is safe: a lost cursor
 * only resets that root's rotation to the head of its next recovery pass.
 *
 * Test 1 drives the SAME `noteTerminalCloseoutRecoveryCursor` function the
 * production `reconcileTerminalCloseouts` pass uses, through the `_internals`
 * DI seam (no mock.module). Test 2 proves the wiring end-to-end: one real
 * `maintainBackgroundDelegations` recovery pass records the cursor under the
 * canonical root key with the last examined correlation id.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	_internals as delegationInternals,
	findByCorrelationId,
	maintainBackgroundDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { canonicalRootKeyFresh } from '../../../src/utils/canonical-root';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_f002_parent';

describe('terminal closeout recovery cursors — regression: bounded with FIFO eviction (F-002)', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		delegationInternals.resetTerminalCloseoutRecoveryCursors();
		({ dir, cleanup } = createSafeTestDir('bg-f002-cursors-'));
	});

	afterEach(() => {
		delegationInternals.resetTerminalCloseoutRecoveryCursors();
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('the cursor map evicts its oldest root past the bound and refreshes on re-note', () => {
		const max =
			delegationInternals.terminalCloseoutRecoveryCursorSnapshot().maxCursors;
		expect(max).toBeGreaterThanOrEqual(1);

		// Fill exactly to the bound: nothing evicted yet.
		for (let i = 0; i < max; i += 1) {
			delegationInternals.noteTerminalCloseoutRecoveryCursor(
				`root-${i}`,
				`corr-${i}`,
			);
		}
		const full = delegationInternals.terminalCloseoutRecoveryCursorSnapshot();
		expect(full.cursors.size).toBe(max);
		expect(full.order[0]).toBe('root-0');
		expect(full.cursors.get('root-0')).toBe('corr-0');

		// One more distinct root evicts the OLDEST root; the size stays bound.
		delegationInternals.noteTerminalCloseoutRecoveryCursor(
			'root-new',
			'corr-new',
		);
		const after = delegationInternals.terminalCloseoutRecoveryCursorSnapshot();
		expect(after.cursors.size).toBe(max);
		expect(after.cursors.has('root-0')).toBe(false);
		expect(after.cursors.has('root-new')).toBe(true);
		expect(after.order[0]).toBe('root-1');

		// Re-noting an existing root refreshes it (moved to the back), so the
		// next eviction takes the new oldest instead of the refreshed root.
		delegationInternals.noteTerminalCloseoutRecoveryCursor(
			'root-1',
			'corr-1-updated',
		);
		delegationInternals.noteTerminalCloseoutRecoveryCursor(
			'root-newer',
			'corr-newer',
		);
		const refreshed =
			delegationInternals.terminalCloseoutRecoveryCursorSnapshot();
		expect(refreshed.cursors.size).toBe(max);
		expect(refreshed.cursors.has('root-1')).toBe(true);
		expect(refreshed.cursors.get('root-1')).toBe('corr-1-updated');
		expect(refreshed.cursors.has('root-2')).toBe(false);
	});

	test('a real recovery pass records the cursor under the canonical root key', async () => {
		// Seed a terminal record with a pending closeout (parent_advisory left
		// pending because the advisory sink is stubbed out), mirroring the
		// closeout-lease fixtures.
		const parent = ensureAgentSession(PARENT, 'architect', dir);
		parent.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(dir, '1.1');
		await recordPendingDelegation(dir, {
			correlationId: 'ses_f002_wire',
			jobId: 'job-ses_f002_wire',
			subagentSessionId: 'ses_f002_wire',
			parentSessionId: PARENT,
			callID: 'call-ses_f002_wire',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: generation,
			workspace: captureWorkspaceSnapshot(dir),
		});
		const body =
			'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>';
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
			contextMap: { enabled: true },
			putPendingBackgroundAdvisoryImpl: async () => null,
		});
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: PARENT,
						text: `<task id="ses_f002_wire" state="completed">\n${body}\n</task>`,
					},
				},
			},
		});
		const record = findByCorrelationId(dir, 'ses_f002_wire');
		if (!record?.terminalResult) throw new Error('seed failed: no terminal');

		// Fresh cursor state for the pass under test (seeding may itself have
		// recorded one via an internal maintenance pass).
		delegationInternals.resetTerminalCloseoutRecoveryCursors();

		const examined: string[] = [];
		await maintainBackgroundDelegations(dir, {
			maxRecords: 4,
			reason: 'f002-wiring-pass',
			onTerminalCloseoutPending: async (pending) => {
				examined.push(pending.correlationId);
			},
		});

		expect(examined.length).toBeGreaterThan(0);
		const snap = delegationInternals.terminalCloseoutRecoveryCursorSnapshot();
		expect(snap.cursors.size).toBe(1);
		expect(snap.cursors.get(canonicalRootKeyFresh(dir))).toBe(
			examined[examined.length - 1],
		);
	});
});
