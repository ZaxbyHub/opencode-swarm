/**
 * PR 3919 (B-001 through B-006): a failed compensation must not mask the append
 * error, the durable split must be fenced until audited repair, and the fence
 * itself must be written before any uncertain state can arise.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
	clearTaskEvidenceRepairMarker,
	_internals as gateEvidenceInternals,
	isTaskEvidenceReceiptRollbackFailure,
	readTaskEvidence,
	TaskEvidenceReceiptRollbackError,
	TaskEvidenceRepairPendingError,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { resetSwarmState } from '../../../src/state';
import { _internals as taskFileInternals } from '../../../src/utils/atomic-write';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TASK = '1.40';
const originalAppend =
	gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded;
const originalRestore = gateEvidenceInternals.restoreEvidenceFile;
const originalRemove = gateEvidenceInternals.removeEvidenceFile;
const originalPrepared = gateEvidenceInternals.writePreparedMarker;

function failingAppend(): void {
	gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
		async () => {
			throw new Error('FORCED_RECEIPT_APPEND_FAILURE');
		};
}

function coderTransition(transitionId: string, expectedGeneration = 0) {
	return {
		type: 'accepted_mutation' as const,
		agentType: 'coder' as const,
		expectedGeneration,
		transitionId,
	};
}

describe('route-receipt append compensation fails closed (PR 3919 B-001..B-006)', () => {
	let directory: string;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		directory = canonicalMkdtemp('stage-b-receipt-rollback-');
		await mkdir(path.join(directory, '.git'), { recursive: true });
		await mkdir(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			originalAppend;
		gateEvidenceInternals.restoreEvidenceFile = originalRestore;
		gateEvidenceInternals.removeEvidenceFile = originalRemove;
		gateEvidenceInternals.writePreparedMarker = originalPrepared;
		resetSwarmState();
		await rm(directory, { recursive: true, force: true, maxRetries: 3 });
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	/**
	 * Leaves the durable split behind: the append fails and the compensating
	 * unlink also fails. Then the seams are restored, simulating a restart with
	 * no in-memory state.
	 */
	async function leaveFence(transitionId: string): Promise<void> {
		failingAppend();
		gateEvidenceInternals.removeEvidenceFile = async () => {
			throw new Error('FORCED_UNLINK_FAILURE');
		};
		await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition(transitionId),
		).catch(() => undefined);
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			originalAppend;
		gateEvidenceInternals.removeEvidenceFile = originalRemove;
	}

	test('a failed restore keeps both causes and leaves the durable split visible to callers', async () => {
		await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('prior-coder'),
		);
		const prior = await readTaskEvidence(directory, TASK);
		failingAppend();
		gateEvidenceInternals.restoreEvidenceFile = async () => {
			throw new Error('FORCED_RESTORE_FAILURE');
		};

		const error = await transitionTaskWorkflowEvidence(directory, TASK, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'append-then-restore-fails',
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(TaskEvidenceReceiptRollbackError);
		expect(isTaskEvidenceReceiptRollbackFailure(error)).toBe(true);
		const typed = error as TaskEvidenceReceiptRollbackError;
		expect((typed.appendError as Error).message).toBe(
			'FORCED_RECEIPT_APPEND_FAILURE',
		);
		expect((typed.rollbackError as Error).message).toBe(
			'FORCED_RESTORE_FAILURE',
		);
		// The restore did not happen: durable evidence stays advanced past the
		// prior snapshot. Callers must not treat this as a clean rollback.
		const durable = await readTaskEvidence(directory, TASK);
		expect(durable?.workflow.state).not.toBe(prior?.workflow.state);
	});

	test('a failed unlink of a newly created evidence file keeps both causes', async () => {
		failingAppend();
		gateEvidenceInternals.removeEvidenceFile = async () => {
			throw new Error('FORCED_UNLINK_FAILURE');
		};

		const error = await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('first-append-then-unlink-fails'),
		).catch((caught: unknown) => caught);

		expect(isTaskEvidenceReceiptRollbackFailure(error)).toBe(true);
		const typed = error as TaskEvidenceReceiptRollbackError;
		expect((typed.appendError as Error).message).toBe(
			'FORCED_RECEIPT_APPEND_FAILURE',
		);
		expect((typed.rollbackError as Error).message).toBe(
			'FORCED_UNLINK_FAILURE',
		);
		expect(await readTaskEvidence(directory, TASK)).not.toBeNull();
	});

	test('a successful compensation still rethrows the plain append error and drops the fence', async () => {
		failingAppend();

		const error = await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('compensation-succeeds'),
		).catch((caught: unknown) => caught);

		expect(isTaskEvidenceReceiptRollbackFailure(error)).toBe(false);
		expect((error as Error).message).toBe('FORCED_RECEIPT_APPEND_FAILURE');
		expect(await readTaskEvidence(directory, TASK)).toBeNull();
		// The compensated state is the prior state, so no fence may remain.
		expect(
			fs.existsSync(
				path.join(
					directory,
					'.swarm',
					'evidence',
					`${TASK}.receipt-repair-pending`,
				),
			),
		).toBe(false);
	});

	test('a failed compensation leaves a durable fence that refuses later transactions after a restart', async () => {
		await leaveFence('fence-first');

		const refused = await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('after-fence', 1),
		).catch((caught: unknown) => caught);

		expect(refused).toBeInstanceOf(TaskEvidenceRepairPendingError);
	});

	test('an audited clear releases the fence; an empty note and a second clear are refused', async () => {
		await leaveFence('fence-clear');

		await expect(
			clearTaskEvidenceRepairMarker(directory, TASK, '   '),
		).rejects.toThrow('non-empty audit note');
		expect(
			await clearTaskEvidenceRepairMarker(
				directory,
				TASK,
				'audited: receipt absent, evidence reviewed by hand',
			),
		).toBe(true);
		expect(
			await clearTaskEvidenceRepairMarker(directory, TASK, 'second clear'),
		).toBe(false);

		const next = await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('after-clear', 1),
		).catch((caught: unknown) => caught);
		expect(next).not.toBeInstanceOf(TaskEvidenceRepairPendingError);
	});

	test('a PREPARED fence that cannot be written aborts with its own error before any evidence changes (B-004)', async () => {
		// Force the write-ahead PREPARED write to fail after admission. The error
		// must be exactly this injected one, not the earlier admission refusal.
		gateEvidenceInternals.writePreparedMarker = async () => {
			throw new Error('FORCED_PREPARED_WRITE_FAILURE');
		};

		const failure = await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('prepared-cannot-write'),
		).catch((caught: unknown) => caught);

		expect((failure as Error).message).toBe('FORCED_PREPARED_WRITE_FAILURE');
		expect(failure).not.toBeInstanceOf(TaskEvidenceRepairPendingError);
		// The evidence write comes after the fence, so nothing was persisted.
		expect(await readTaskEvidence(directory, TASK)).toBeNull();
	});

	test('a failed audit append keeps the fence in place (B-005)', async () => {
		await leaveFence('audit-fail');
		// Force the audit append to fail for real: a directory at the audit path.
		fs.mkdirSync(
			path.join(
				directory,
				'.swarm',
				'evidence',
				`${TASK}.receipt-repair-audit.log`,
			),
			{ recursive: true },
		);

		await expect(
			clearTaskEvidenceRepairMarker(directory, TASK, 'audited by hand'),
		).rejects.toThrow();

		const stillFenced = await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('still-fenced', 1),
		).catch((caught: unknown) => caught);
		expect(stillFenced).toBeInstanceOf(TaskEvidenceRepairPendingError);
	});

	test('a clean evidence-write failure leaves the file unchanged and drops the fence (F-001)', async () => {
		const realRename = taskFileInternals.renameSync;
		taskFileInternals.renameSync = (source, target) => {
			if (target.endsWith(`${path.sep}evidence${path.sep}${TASK}.json`)) {
				throw new Error('FORCED_EVIDENCE_RENAME_FAILURE');
			}
			realRename(source, target);
		};
		try {
			const failure = await transitionTaskWorkflowEvidence(
				directory,
				TASK,
				coderTransition('clean-evidence-failure'),
			).catch((caught: unknown) => caught);
			expect((failure as Error).message).toBe('FORCED_EVIDENCE_RENAME_FAILURE');
		} finally {
			taskFileInternals.renameSync = realRename;
		}
		expect(await readTaskEvidence(directory, TASK)).toBeNull();
		expect(
			fs.existsSync(
				path.join(
					directory,
					'.swarm',
					'evidence',
					`${TASK}.receipt-repair-pending`,
				),
			),
		).toBe(false);

		const next = await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('after-clean-failure'),
		).catch((caught: unknown) => caught);
		expect(next).not.toBeInstanceOf(TaskEvidenceRepairPendingError);
	});

	test('an evidence write that lands before it throws keeps the fence (F-001 boundary)', async () => {
		const realRename = taskFileInternals.renameSync;
		taskFileInternals.renameSync = (source, target) => {
			realRename(source, target);
			if (target.endsWith(`${path.sep}evidence${path.sep}${TASK}.json`)) {
				throw new Error('FORCED_POST_RENAME_FAILURE');
			}
		};
		try {
			await transitionTaskWorkflowEvidence(
				directory,
				TASK,
				coderTransition('landed-then-failed'),
			).catch(() => undefined);
		} finally {
			taskFileInternals.renameSync = realRename;
		}

		const refused = await transitionTaskWorkflowEvidence(
			directory,
			TASK,
			coderTransition('after-landed', 1),
		).catch((caught: unknown) => caught);
		expect(refused).toBeInstanceOf(TaskEvidenceRepairPendingError);
	});
});
