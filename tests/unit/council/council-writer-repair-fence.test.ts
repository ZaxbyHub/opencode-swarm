/**
 * PR 3919 review finding: the council evidence writer bypassed the split-receipt
 * repair fence. The marker `<task>.receipt-repair-pending` must refuse every
 * writer of the flat evidence file, not only the gate transaction.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeCouncilEvidence } from '../../../src/council/council-evidence-writer';
import type { CouncilSynthesis } from '../../../src/council/types';
import {
	readTaskEvidence,
	TaskEvidenceRepairPendingError,
} from '../../../src/gate-evidence';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK = '1.1';

const synthesis: CouncilSynthesis = {
	taskId: TASK,
	swarmId: 'council-run',
	timestamp: '2026-08-14T00:00:00.000Z',
	overallVerdict: 'APPROVE',
	vetoedBy: null,
	memberVerdicts: [],
	unresolvedConflicts: [],
	requiredFixes: [],
	advisoryFindings: [],
	unifiedFeedbackMd: '',
	roundNumber: 1,
	allCriteriaMet: true,
	quorumSize: 3,
	blockingConcernsCount: 0,
};

describe('council evidence writer honours the receipt repair fence (PR 3919)', () => {
	let directory = '';
	let cleanup = (): void => {};
	let evidenceDir = '';
	let markerPath = '';

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('council-repair-fence-'));
		fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
		evidenceDir = path.join(directory, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		markerPath = path.join(evidenceDir, `${TASK}.receipt-repair-pending`);
	});

	afterEach(() => {
		cleanup();
	});

	test('refuses a council write while the split-receipt marker exists and leaves the evidence file untouched', async () => {
		fs.writeFileSync(markerPath, '{}');

		await expect(
			writeCouncilEvidence(directory, synthesis, 'council-attempt-fenced'),
		).rejects.toBeInstanceOf(TaskEvidenceRepairPendingError);

		expect(fs.existsSync(path.join(evidenceDir, `${TASK}.json`))).toBe(false);
		expect(await readTaskEvidence(directory, TASK)).toBeNull();
	});

	test('the same write succeeds once the marker is cleared (control)', async () => {
		fs.writeFileSync(markerPath, '{}');
		await expect(
			writeCouncilEvidence(directory, synthesis, 'council-attempt-blocked'),
		).rejects.toBeInstanceOf(TaskEvidenceRepairPendingError);

		fs.rmSync(markerPath);
		await writeCouncilEvidence(directory, synthesis, 'council-attempt-clear');

		expect(
			(await readTaskEvidence(directory, TASK))?.gates.council,
		).toMatchObject({ verdict: 'APPROVE', attemptId: 'council-attempt-clear' });
	});
});
