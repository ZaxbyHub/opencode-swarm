/**
 * Epic v2 C2 — phase review and phase completion require every wave of the
 * phase to be closed, and review runs are recorded on the epic:
 *   - `epic_phase_review` refuses `waves-open` (no dispatch) while a wave of
 *     the phase is issued; afterwards each run increments `reviewRuns` and
 *     appends its verdicts;
 *   - the `phase_complete` Epic gate (`verifyEpicPhaseReadiness`) blocks
 *     `EPIC_PHASE_WAVES_OPEN`, and fails closed on an unreadable record.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { updateEpicRecord } from '../../../src/epic/lifecycle';
import {
	_internals as readinessInternals,
	verifyEpicPhaseReadiness,
} from '../../../src/epic/phase-readiness';
import {
	_internals,
	executeEpicPhaseReview,
} from '../../../src/tools/epic-phase-review';
import {
	type NextWaveProject,
	openNextWaveProject,
} from '../epic/next-wave-fixture';

const original = { ..._internals };
const originalReadiness = { ...readinessInternals };
let project: NextWaveProject;
let reviews = 0;

function issueWave(status: 'issued' | 'closed'): void {
	updateEpicRecord(project.dir, project.epic.epicKey, (record) => ({
		...record,
		activeWaveSeq: status === 'issued' ? 1 : null,
		waves: [
			{
				seq: 1,
				phase: 1,
				kind: 'parallel',
				taskIds: ['1.1'],
				files: { '1.1': ['src/t1_1.ts'] },
				cochange: null,
				baseHead: null,
				issuedAt: '2026-08-05T10:00:00.000Z',
				status,
			},
		],
	}));
}

beforeEach(async () => {
	project = await openNextWaveProject([[{ id: '1.1' }]]);
	reviews = 0;
	_internals.runEpicPhaseReview = (async () => {
		reviews += 1;
		return {
			success: true,
			phase: 1,
			ready: false,
			reviewer: { verdict: reviews === 1 ? 'NEEDS_REVISION' : 'APPROVED' },
			critic: reviews === 1 ? null : { verdict: 'APPROVED' },
			evidencePath: '.swarm/evidence/1/epic-phase-review.json',
			message: 'x',
		};
	}) as never;
});

afterEach(() => {
	Object.assign(_internals, original);
	Object.assign(readinessInternals, originalReadiness);
	project.cleanup();
});

describe('epic_phase_review — waves precondition and review history', () => {
	test('an open wave of the phase refuses waves-open without dispatching', async () => {
		issueWave('issued');
		const result = await executeEpicPhaseReview({ phase: 1 }, project.dir, 's');
		expect(result).toMatchObject({ success: false, reason: 'waves-open' });
		if (!result.success) expect(result.message).toContain('epic_next_wave');
		expect(reviews).toBe(0);
	});

	test('closed waves: each run is recorded with its verdicts', async () => {
		issueWave('closed');
		await executeEpicPhaseReview({ phase: 1 }, project.dir, 's');
		await executeEpicPhaseReview({ phase: 1 }, project.dir, 's');
		expect(reviews).toBe(2);
		expect(project.record().phases['1']).toEqual({
			status: 'review',
			reviewRuns: 2,
			verdicts: [
				'reviewer:NEEDS_REVISION critic:not-run',
				'reviewer:APPROVED critic:APPROVED',
			],
		});
	});
});

describe('phase_complete Epic gate — EPIC_PHASE_WAVES_OPEN', () => {
	test('an open wave blocks before any evidence check', async () => {
		issueWave('issued');
		expect(
			await verifyEpicPhaseReadiness(
				project.dir,
				1,
				Date.parse('2026-08-05T11:00:00.000Z'),
			),
		).toMatchObject({ ok: false, code: 'EPIC_PHASE_WAVES_OPEN' });
	});

	test('closed waves fall through to the review-evidence checks', async () => {
		issueWave('closed');
		expect(
			await verifyEpicPhaseReadiness(
				project.dir,
				1,
				Date.parse('2026-08-05T11:00:00.000Z'),
			),
		).toMatchObject({ ok: false, code: 'EPIC_PHASE_REVIEW_MISSING' });
	});

	test('an unreadable epic record fails closed', async () => {
		readinessInternals.getOpenEpic = (() => {
			throw new Error('multiple Epic lifecycle rows present');
		}) as never;
		const result = await verifyEpicPhaseReadiness(project.dir, 1, 0);
		expect(result).toMatchObject({ ok: false, code: 'EPIC_PHASE_WAVES_OPEN' });
		if (!result.ok) expect(result.reason).toContain('unreadable');
	});
});
