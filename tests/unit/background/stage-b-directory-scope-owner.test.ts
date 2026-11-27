/**
 * Distinct-background-owner validation in the receipts handoff
 * (src/background/stage-b-gates.ts, hasDistinctBackgroundOwner).
 *
 * Split from stage-b-directory-scope-receipts.test.ts at the FR-006 500-line
 * cap. Covers the PR 3918 review regressions for the owner side:
 * - F-001: a directory-valued owner declaration is recognized for its
 *   descendant files.
 * - F-003 round 2: an owner whose routed (guardrail-observed) spelling
 *   differs in case from the Git-reported spelling ("Context/entry-a.md" vs
 *   "context/entry-a.md") still explains the observed file — live AND
 *   historical (ownership-tombstone) paths — with only the rightful owner
 *   credited. POSIX keys are identity, so a divergent routed spelling is a
 *   genuinely distinct file there and the handoff fails closed.
 * - Ambiguity fail-closed: two routed spellings folding onto one key on
 *   Windows are ambiguous provenance and must refuse settlement (on POSIX
 *   they are two distinct files and the exact-match owner stands).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import {
	claimReviewerScopeGeneration,
	getModifiedFilesForTask,
	markReviewerScopeGenerationReady,
	takeReviewerScopeGeneration,
} from '../../../src/state';
import { freezeClock } from '../../helpers/test-clock.js';
import {
	createDirectoryScopeFixture,
	type DirectoryScopeFixture,
	FROZEN_NOW,
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

function seedCaseDivergentOwnerAndCandidate(input: {
	ownerTaskId: string;
	ownerCallID: string;
	candidateTaskId: string;
	candidateCallID: string;
}): void {
	const now = FROZEN_NOW - 3_000;
	// The owner declared the DIRECTORY and routed its write under the
	// divergent (authored) spelling "Context/entry-a.md"; git reports the
	// tracked file as "context/entry-a.md".
	fixture.startBackgroundCoder({
		taskId: input.ownerTaskId,
		callID: input.ownerCallID,
		declaredFiles: ['context'],
		files: ['Context/entry-a.md'],
		createdAt: now,
	});
	fixture.startBackgroundCoder({
		taskId: input.candidateTaskId,
		callID: input.candidateCallID,
		declaredFiles: ['src/kept.ts'],
		files: ['src/kept.ts'],
		createdAt: now + 100,
	});
	fixture.writeFile('src/kept.ts', 'export const kept = 2;\n');
	fixture.writeFile('context/entry-a.md', 'entry a v2\n');
	fixture.recordFingerprintUnderSpelling({
		taskId: input.ownerTaskId,
		callID: input.ownerCallID,
		onDiskFile: 'context/entry-a.md',
		routedFile: 'Context/entry-a.md',
	});
	fixture.fingerprintRoutedFiles(input.candidateTaskId, input.candidateCallID, [
		'src/kept.ts',
	]);
}

describe('receipts handoff distinct owner — regression: directory-valued owner scope unrecognized (F-001)', () => {
	test('a directory-scoped concurrent owner explains its descendant file', async () => {
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
		// Previous code checked the distinct owner's declared scope with exact
		// Set.has: an owner that declared the DIRECTORY "context" was never
		// recognized as owning "context/entry-a.md", so the candidate's
		// completion was refused with "scope handoff could not be
		// reconstructed exactly" and settlement blocked despite an
		// unambiguous single owner.
		const snapshot = baseline(['src/kept.ts', 'context/entry-a.md']);
		const now = FROZEN_NOW - 3_000;
		startBackgroundCoder({
			taskId: '1.18',
			callID: 'coder-owner',
			declaredFiles: ['context'],
			files: ['context/entry-a.md'],
			createdAt: now,
		});
		startBackgroundCoder({
			taskId: '1.17',
			callID: 'coder-cand',
			declaredFiles: ['src/kept.ts'],
			files: ['src/kept.ts'],
			createdAt: now + 100,
		});
		fixture.writeFile('src/kept.ts', 'export const kept = 2;\n');
		fixture.writeFile('context/entry-a.md', 'entry a v2\n');
		fingerprintRoutedFiles('1.18', 'coder-owner', ['context/entry-a.md']);
		fingerprintRoutedFiles('1.17', 'coder-cand', ['src/kept.ts']);

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord({
				taskId: '1.17',
				callID: 'coder-cand',
				baseline: snapshot,
				declaredFiles: ['src/kept.ts'],
			}),
			result: terminalResult,
			reviewerReceiptOptions: receiptsOptions(),
		});
		expect(result).toEqual({ ok: true, consumed: true });
		// Only the candidate's own routed file is credited to it; the owner's
		// descendant file stays attributed to the distinct owner.
		expect(getModifiedFilesForTask(parentSession(), '1.17')).toEqual([
			'src/kept.ts',
		]);
	});
});

describe('distinct owner identity reconciliation — regression: case-divergent routed spelling (F-003)', () => {
	test('a live owner routed under a divergent spelling explains the Git-observed file', async () => {
		const {
			directory,
			terminalResult,
			baseline,
			coderRecord,
			parentSession,
			receiptsOptions,
		} = fixture;
		// Previous code compared the owner's routed membership and fingerprint
		// with exact strings, so a Windows owner routed as
		// "Context/entry-a.md" could never explain the Git-observed
		// "context/entry-a.md" and settlement was refused.
		const snapshot = baseline(['src/kept.ts', 'context/entry-a.md']);
		seedCaseDivergentOwnerAndCandidate({
			ownerTaskId: '1.24',
			ownerCallID: 'coder-owner-case',
			candidateTaskId: '1.23',
			candidateCallID: 'coder-cand-case',
		});

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord({
				taskId: '1.23',
				callID: 'coder-cand-case',
				baseline: snapshot,
				declaredFiles: ['src/kept.ts'],
			}),
			result: terminalResult,
			reviewerReceiptOptions: receiptsOptions(),
		});

		if (process.platform === 'win32') {
			expect(result).toEqual({ ok: true, consumed: true });
			// Only the rightful owner holds the context file; the candidate is
			// credited exactly its own routed file.
			expect(getModifiedFilesForTask(parentSession(), '1.23')).toEqual([
				'src/kept.ts',
			]);
		} else {
			// POSIX keys are identity: the divergent routed spelling is a
			// distinct file there, so the owner cannot explain the observed
			// one and the handoff fails closed.
			expect(result).toEqual({
				ok: false,
				consumed: false,
				reason:
					'background coder scope handoff could not be reconstructed exactly',
			});
			expect(getModifiedFilesForTask(parentSession(), '1.23')).toEqual([]);
		}
	});

	test('a consumed (historical) owner routed under a divergent spelling explains the Git-observed file', async () => {
		const {
			directory,
			terminalResult,
			baseline,
			coderRecord,
			parentSession,
			receiptsOptions,
		} = fixture;
		// Same regression through the ownership-tombstone path: the owner's
		// reviewer already consumed the live generation, so delayed sibling
		// ingestion must reconcile the historical tombstone's routed spelling
		// with the Git-observed one through the canonical key.
		const snapshot = baseline(['src/kept.ts', 'context/entry-a.md']);
		seedCaseDivergentOwnerAndCandidate({
			ownerTaskId: '1.26',
			ownerCallID: 'coder-owner-hist',
			candidateTaskId: '1.25',
			candidateCallID: 'coder-cand-hist',
		});
		const now = FROZEN_NOW - 3_000;
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '1.26',
				coderCallID: 'coder-owner-hist',
				readyAt: now + 500,
			}),
		).toBe(true);
		expect(
			claimReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '1.26',
				reviewerCallID: 'reviewer-coder-owner-hist',
				now: now + 500,
			}),
		).not.toBeNull();
		expect(
			takeReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '1.26',
				reviewerCallID: 'reviewer-coder-owner-hist',
				now: now + 600,
			}),
		).not.toBeNull();

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord({
				taskId: '1.25',
				callID: 'coder-cand-hist',
				baseline: snapshot,
				declaredFiles: ['src/kept.ts'],
			}),
			result: terminalResult,
			reviewerReceiptOptions: receiptsOptions(),
		});

		if (process.platform === 'win32') {
			expect(result).toEqual({ ok: true, consumed: true });
			expect(getModifiedFilesForTask(parentSession(), '1.25')).toEqual([
				'src/kept.ts',
			]);
		} else {
			expect(result).toEqual({
				ok: false,
				consumed: false,
				reason:
					'background coder scope handoff could not be reconstructed exactly',
			});
			expect(getModifiedFilesForTask(parentSession(), '1.25')).toEqual([]);
		}
	});
});

describe('distinct owner identity reconciliation — ambiguity fails closed (F-003)', () => {
	test('an owner routing two spellings that fold to one key cannot explain the file', async () => {
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
		// The owner's generation routed BOTH "Context/entry-a.md" and
		// "context/entry-a.md" (one fingerprint captured under the exact
		// spelling). On Windows the two routed spellings fold to one
		// canonical key — ambiguous provenance that must fail closed instead
		// of crediting the file to an owner whose own record cannot name
		// which file it wrote. On POSIX they are two genuinely distinct
		// files, the exact-match owner stands, and settlement succeeds.
		const snapshot = baseline(['src/kept.ts', 'context/entry-a.md']);
		const now = FROZEN_NOW - 3_000;
		startBackgroundCoder({
			taskId: '1.28',
			callID: 'coder-owner-ambiguous',
			declaredFiles: ['context'],
			files: ['Context/entry-a.md', 'context/entry-a.md'],
			createdAt: now,
		});
		startBackgroundCoder({
			taskId: '1.27',
			callID: 'coder-cand-ambiguous',
			declaredFiles: ['src/kept.ts'],
			files: ['src/kept.ts'],
			createdAt: now + 100,
		});
		fixture.writeFile('src/kept.ts', 'export const kept = 2;\n');
		fixture.writeFile('context/entry-a.md', 'entry a v2\n');
		fingerprintRoutedFiles('1.28', 'coder-owner-ambiguous', [
			'context/entry-a.md',
		]);
		fingerprintRoutedFiles('1.27', 'coder-cand-ambiguous', ['src/kept.ts']);

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord({
				taskId: '1.27',
				callID: 'coder-cand-ambiguous',
				baseline: snapshot,
				declaredFiles: ['src/kept.ts'],
			}),
			result: terminalResult,
			reviewerReceiptOptions: receiptsOptions(),
		});

		if (process.platform === 'win32') {
			expect(result).toEqual({
				ok: false,
				consumed: false,
				reason:
					'background coder scope handoff could not be reconstructed exactly',
			});
			expect(getModifiedFilesForTask(parentSession(), '1.27')).toEqual([]);
		} else {
			// Distinct files on POSIX: the owner unambiguously routed
			// "context/entry-a.md" and settlement proceeds.
			expect(result).toEqual({ ok: true, consumed: true });
			expect(getModifiedFilesForTask(parentSession(), '1.27')).toEqual([
				'src/kept.ts',
			]);
		}
	});
});
