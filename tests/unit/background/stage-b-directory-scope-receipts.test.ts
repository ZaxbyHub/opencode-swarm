/**
 * Receipts-enabled directory-scope attribution in the background coder
 * completion handoff (src/background/stage-b-gates.ts,
 * reviewerReceiptOptions.config.enabled === true).
 *
 * Split from stage-b-directory-scope-attribution.test.ts at the FR-006
 * 500-line cap. Covers the PR 3918 review regressions that require the
 * receipts handoff branch:
 * - F-005: directory descendants are attributed through the handoff filters.
 * - F-003: routed (guardrail-observed) and Git-reported path spellings that
 *   differ only by case on Windows reconcile to ONE canonical credited file
 *   (POSIX keeps exact identities and fails closed).
 * - F-002: overlapping directory/file declarations on one shared checkout
 *   cannot both receive mutation credit, even with identical fingerprints.
 *
 * The distinct-owner regressions (F-001 and the F-003 round-2 owner
 * identity reconciliation, live and historical) live in
 * stage-b-directory-scope-owner.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import {
	captureReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import {
	getModifiedFilesForTask,
	peekReadyReviewerScopeGeneration,
	recordReviewerScopeGenerationFileFingerprint,
} from '../../../src/state';
import { freezeClock } from '../../helpers/test-clock.js';
import {
	createDirectoryScopeFixture,
	type DirectoryScopeFixture,
	FROZEN_NOW,
	PARENT_SESSION_ID,
} from './stage-b-directory-scope-fixtures';

let fixture: DirectoryScopeFixture;
let restoreClock: () => void;

beforeEach(() => {
	// Deterministic timestamps (check:test-clock, issue #1782): every seeded
	// generation/record timestamp is FROZEN_NOW-relative and every production
	// now-read (sweeps, stamps, interval comparisons) reports FROZEN_NOW.
	restoreClock = freezeClock({ fixedNow: FROZEN_NOW });
	fixture = createDirectoryScopeFixture();
});

afterEach(() => {
	fixture.teardown();
	restoreClock();
});

describe('receipts-enabled directory-scope attribution (F-005)', () => {
	test('directory descendants are attributed through the receipts handoff', async () => {
		const {
			directory,
			terminalResult,
			baseline,
			coderRecord,
			parentSession,
			startBackgroundCoder,
			fingerprintRoutedFiles,
			receiptsOptions,
		} = fixture;
		// The receipts branch re-derives attribution from the generation's
		// routed files: without directory-aware membership every descendant of
		// a directory-valued declared scope would fall out of
		// changedWithinDeclaredScope and the handoff would be refused.
		const snapshot = baseline(['context/entry-a.md']);
		const now = FROZEN_NOW - 2_000;
		startBackgroundCoder({
			taskId: '1.16',
			callID: 'coder-receipts',
			declaredFiles: ['context'],
			files: ['context/entry-a.md'],
			createdAt: now,
		});
		fixture.writeFile('context/entry-a.md', 'entry a v2\n');
		fingerprintRoutedFiles('1.16', 'coder-receipts', ['context/entry-a.md']);

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord({
				taskId: '1.16',
				callID: 'coder-receipts',
				baseline: snapshot,
				declaredFiles: ['context'],
			}),
			result: terminalResult,
			reviewerReceiptOptions: receiptsOptions(),
		});
		expect(result).toEqual({ ok: true, consumed: true });

		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.16'),
		);
		expect(snapshotAfter.lastOutcome).toBe('accepted_mutation');
		expect(getModifiedFilesForTask(parentSession(), '1.16')).toEqual([
			'context/entry-a.md',
		]);
	});
});

describe('receipts handoff identity reconciliation — regression: case-divergent routed spelling stranded the handoff (F-003)', () => {
	test('routed and Git-reported spellings reconcile to one canonical credited file', async () => {
		const {
			directory,
			terminalResult,
			baseline,
			coderRecord,
			parentSession,
			startBackgroundCoder,
			receiptsOptions,
		} = fixture;
		// Previous code compared routed (guardrail-observed) and Git-reported
		// identities with exact strings: pathSetsEqual(routedFiles,
		// changedWithinDeclaredScope) and the fingerprint filename selection
		// both missed when the coder routed "Context/entry-a.md" while git
		// reports the tracked file as "context/entry-a.md", so the receipts
		// handoff was refused on Windows even though the write was permitted
		// and routed.
		const snapshot = baseline(['context/entry-a.md']);
		const now = FROZEN_NOW - 2_000;
		startBackgroundCoder({
			taskId: '1.22',
			callID: 'coder-case-divergent',
			declaredFiles: ['Context'],
			files: ['Context/entry-a.md'],
			createdAt: now,
		});
		fixture.writeFile('context/entry-a.md', 'entry a v2\n');
		// The generation's routed fingerprint carries the ROUTED spelling,
		// exactly as write-routing would have recorded it.
		const captured = captureReviewerScopeFileFingerprint(
			directory,
			'context/entry-a.md',
		);
		expect(captured?.kind).toBe('captured_file');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: PARENT_SESSION_ID,
				taskId: '1.22',
				coderCallID: 'coder-case-divergent',
				fingerprint: {
					...reviewerScopeCaptureToFingerprint(captured)!,
					file: 'Context/entry-a.md',
				},
			}),
		).toBe(true);

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord({
				taskId: '1.22',
				callID: 'coder-case-divergent',
				baseline: snapshot,
				declaredFiles: ['Context'],
			}),
			result: terminalResult,
			reviewerReceiptOptions: receiptsOptions(),
		});

		if (process.platform === 'win32') {
			expect(result).toEqual({ ok: true, consumed: true });
			const snapshotAfter = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '1.22'),
			);
			expect(snapshotAfter.lastOutcome).toBe('accepted_mutation');
			// Exactly ONE file is credited, under the canonical Git-reported
			// spelling — never both case spellings.
			expect(getModifiedFilesForTask(parentSession(), '1.22')).toEqual([
				'context/entry-a.md',
			]);
			expect(
				peekReadyReviewerScopeGeneration({
					parentSessionID: PARENT_SESSION_ID,
					taskId: '1.22',
				}),
			).not.toBeNull();
		} else {
			// POSIX keeps exact identities: the routed spelling is a distinct
			// path there, so the handoff fails closed and nothing is credited.
			expect(result).toEqual({
				ok: false,
				consumed: false,
				reason:
					'background coder scope handoff could not be reconstructed exactly',
			});
			expect(getModifiedFilesForTask(parentSession(), '1.22')).toEqual([]);
		}
	});
});

describe('receipts handoff shared checkout — regression: directory/file declared overlap missed (F-002)', () => {
	test('overlapping directory and exact-file declarations cannot both earn mutation credit', async () => {
		const {
			directory,
			terminalResult,
			baseline,
			coderRecord,
			parentSession,
			startBackgroundCoder,
			fingerprintRoutedFiles,
			receiptsOptions,
		} = fixture;
		// Previous code compared declarations with exact Set.has, so a sibling
		// generation declaring "context" and one declaring "context/shared.md"
		// looked disjoint: both could collect mutation credit for the same
		// file from one shared checkout, even with identical fingerprints.
		const snapshot = baseline(['context/shared.md']);
		const now = FROZEN_NOW - 2_000;
		startBackgroundCoder({
			taskId: '1.20',
			callID: 'coder-dir',
			declaredFiles: ['context'],
			files: ['context/shared.md'],
			createdAt: now,
		});
		startBackgroundCoder({
			taskId: '1.19',
			callID: 'coder-file',
			declaredFiles: ['context/shared.md'],
			files: ['context/shared.md'],
			createdAt: now + 100,
		});
		// One shared write; both generations record the identical fingerprint.
		fixture.writeFile('context/shared.md', 'shared v2\n');
		fingerprintRoutedFiles('1.20', 'coder-dir', ['context/shared.md']);
		fingerprintRoutedFiles('1.19', 'coder-file', ['context/shared.md']);

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord({
				taskId: '1.19',
				callID: 'coder-file',
				baseline: snapshot,
				declaredFiles: ['context/shared.md'],
			}),
			result: terminalResult,
			reviewerReceiptOptions: receiptsOptions(),
		});
		expect(result).toEqual({
			ok: false,
			consumed: false,
			reason:
				'background coder scope handoff could not be reconstructed exactly',
		});
		// No mutation credit may be recorded for the ambiguous task.
		expect(getModifiedFilesForTask(parentSession(), '1.19')).toEqual([]);
		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.19'),
		);
		expect(snapshotAfter.lastOutcome).not.toBe('accepted_mutation');
	});
});
