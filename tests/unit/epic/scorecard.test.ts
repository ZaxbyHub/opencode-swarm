/**
 * Epic v2 C8 — `computeEpicScorecard` (pure over the record) and its
 * markdown lines. Every timestamp is an explicit ISO literal; the module
 * reads no clock.
 */
import { describe, expect, test } from 'bun:test';
import type {
	EpicTaskOutcome,
	EpicWaveRecord,
} from '../../../src/epic/lifecycle';
import {
	computeEpicScorecard,
	EPIC_CONCURRENCY_FACTOR_LABEL,
	EPIC_SCORECARD_FILES_KEEP,
	formatEpicDuration,
	formatEpicScorecardLines,
} from '../../../src/epic/scorecard';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';

const T0 = '2026-06-01T10:00:00.000Z';
const at = (minutes: number) =>
	new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function wave(
	seq: number,
	taskIds: string[],
	overrides: Partial<EpicWaveRecord> = {},
): EpicWaveRecord {
	return {
		seq,
		phase: 1,
		kind: taskIds.length > 1 ? 'parallel' : 'exclusive',
		taskIds,
		files: Object.fromEntries(taskIds.map((id) => [id, [`src/${id}.ts`]])),
		cochange: null,
		baseHead: null,
		issuedAt: at(0),
		status: 'closed',
		...overrides,
	};
}

function outcome(
	taskId: string,
	waveSeq: number,
	resolvedMinute: number,
	overrides: Partial<EpicTaskOutcome> = {},
): EpicTaskOutcome {
	return {
		taskId,
		phase: 1,
		waveSeq,
		resolution: 'completed',
		resolvedAt: at(resolvedMinute),
		generation: 1,
		stageAFailures: 0,
		stageBFailures: 0,
		mergeFailure: null,
		declared: [`src/${taskId}.ts`],
		undeclared: [],
		attribution: 'session',
		reopened: 0,
		marker: null,
		...overrides,
	};
}

/** Two closed waves (10 + 5 min span), one aborted, one still issued. */
function record() {
	return stubEpicRecord({
		forced: true,
		priorDigest: 'f'.repeat(64),
		waves: [
			wave(1, ['1.1', '1.2', '1.3'], { issuedAt: at(0), closedAt: at(10) }),
			wave(2, ['1.4'], {
				issuedAt: at(12),
				closedAt: at(17),
				kind: 'serial-component',
				mergeFailures: {
					'1.4': { outcome: 'conflict', stage: 'merge', message: 'x', at: 1 },
				},
				undeclared: ['src/wave-level.ts'],
			}),
			wave(3, ['1.5', '1.6'], { issuedAt: at(17), status: 'aborted' }),
			wave(4, ['1.7'], { issuedAt: at(20), status: 'issued' }),
		],
		tasks: {
			'1.1': outcome('1.1', 1, 4),
			'1.2': outcome('1.2', 1, 8, {
				generation: 3,
				stageBFailures: 2,
				undeclared: ['src/extra.ts'],
			}),
			'1.3': outcome('1.3', 1, 10, { stageAFailures: 1, reopened: 1 }),
			'1.4': outcome('1.4', 2, 16, {
				mergeFailure: { outcome: 'conflict', stage: 'merge' },
			}),
			'1.9': outcome('1.9', 1, 9, { resolution: 'closed' }),
		},
		phases: {
			'1': {
				status: 'complete',
				reviewRuns: 1,
				verdicts: ['reviewer:APPROVED critic:APPROVED'],
			},
			'2': {
				status: 'complete',
				reviewRuns: 2,
				verdicts: [
					'reviewer:NEEDS_REVISION critic:not-run',
					'reviewer:APPROVED critic:APPROVED',
				],
			},
			// First verdict truncated away: never counted as a first pass.
			'3': {
				status: 'complete',
				reviewRuns: 3,
				verdicts: ['reviewer:APPROVED critic:APPROVED'],
			},
			'4': { status: 'active', reviewRuns: 0, verdicts: [] },
		},
	});
}

describe('computeEpicScorecard', () => {
	test('tasks, waves, conflicts, rework, gates and learning from the record', () => {
		const card = computeEpicScorecard({
			record: record(),
			outcome: 'completed',
			closedAt: at(30),
			planTaskTotal: 9,
			adoptedAtStart: 2,
			hotFiles: Array.from({ length: 12 }, (_, i) => `src/hot-${i}.ts`),
		});
		expect(card).toMatchObject({
			schema: 'epic-scorecard-v1',
			outcome: 'completed',
			startedAt: '2026-01-01T00:00:00.000Z',
			closedAt: at(30),
			forced: true,
			tasks: {
				total: 9,
				completedInEpic: 4,
				adoptedAtStart: 2,
				exclusive: 1,
				serialComponent: 1,
			},
			// Aborted wave 3 excluded; widths 3, 1, 1.
			waves: { count: 3, parallel: 1, meanWidth: 1.67, maxWidth: 3 },
			conflicts: {
				mergeFailures: 1,
				undeclaredWriteTasks: 1,
				undeclaredFiles: ['src/extra.ts', 'src/wave-level.ts'],
				undeclaredFilesTotal: 2,
			},
			rework: { tasksWithRework: 1, extraGenerations: 2, reopened: 1 },
			gates: {
				stageAFirstPass: { passed: 3, of: 4, rate: 0.75 },
				stageBFirstPass: { passed: 3, of: 4, rate: 0.75 },
				phaseReviewFirstPass: { passed: 1, of: 3, rate: 0.333 },
				boundedHistory: true,
			},
			learning: { priorDigest: 'f'.repeat(64) },
		});
		expect(card.learning.topHotFiles).toHaveLength(10);
		expect(card.learning.topHotFiles[0]).toBe('src/hot-0.ts');
		expect(card.sizingAtStart).toEqual(record().sizing);
	});

	test('time: wave spans of CLOSED waves, task issue→resolve, idle gaps; a concurrency factor', () => {
		const { time } = computeEpicScorecard({
			record: record(),
			outcome: 'completed',
			closedAt: at(30),
		});
		// Spans: wave 1 = 10 min, wave 2 = 5 min (issued wave 4 has none).
		expect(time.spanMs).toBe(15 * 60_000);
		// Work: 1.1 4 + 1.2 8 + 1.3 10 (wave 1) + 1.4 4 (wave 2) = 26 min;
		// the closed (not completed) 1.9 is not work.
		expect(time.workMs).toBe(26 * 60_000);
		expect(time.concurrencyFactor).toBe(1.733);
		expect(time.label).toBe(EPIC_CONCURRENCY_FACTOR_LABEL);
		expect(time.label).toContain('not speedup');
		// Gaps: 10→12 (2 min), 17→20 (3 min; the aborted wave never closed).
		expect(time.interWaveIdleMs).toBe(5 * 60_000);
	});

	test('a fresh epic: zero counts, null factor and rates, no total', () => {
		const card = computeEpicScorecard({
			record: stubEpicRecord(),
			outcome: 'open',
			closedAt: null,
		});
		expect(card).toMatchObject({
			outcome: 'open',
			closedAt: null,
			tasks: { total: null, completedInEpic: 0 },
			waves: { count: 0, parallel: 0, meanWidth: 0, maxWidth: 0 },
			time: { spanMs: 0, workMs: 0, concurrencyFactor: null },
			gates: { stageAFirstPass: { of: 0, rate: null } },
			learning: { priorDigest: null, topHotFiles: [] },
		});
		expect(card.tasks).not.toHaveProperty('adoptedAtStart');
	});

	test('undeclared files are bounded; resolution before issue clamps to 0', () => {
		const files = Array.from(
			{ length: 30 },
			(_, i) => `src/u-${String(i).padStart(2, '0')}.ts`,
		);
		const card = computeEpicScorecard({
			record: stubEpicRecord({
				waves: [wave(1, ['1.1'], { issuedAt: at(5), closedAt: at(6) })],
				tasks: { '1.1': outcome('1.1', 1, 1, { undeclared: files }) },
			}),
			outcome: 'abandoned',
			closedAt: at(7),
		});
		expect(card.conflicts.undeclaredFiles).toEqual(
			files.slice(0, EPIC_SCORECARD_FILES_KEEP),
		);
		expect(card.conflicts.undeclaredFilesTotal).toBe(30);
		expect(card.time.workMs).toBe(0);
		expect(card.time.concurrencyFactor).toBe(0);
	});
});

describe('formatting', () => {
	test('durations', () => {
		expect(formatEpicDuration(0)).toBe('0s');
		expect(formatEpicDuration(12_400)).toBe('12s');
		expect(formatEpicDuration(185_000)).toBe('3m 05s');
		expect(formatEpicDuration(3_720_000)).toBe('1h 02m');
	});

	test('markdown lines name the factor as a concurrency factor, not a speedup', () => {
		const text = formatEpicScorecardLines(
			computeEpicScorecard({
				record: record(),
				outcome: 'completed',
				closedAt: at(30),
				planTaskTotal: 9,
				adoptedAtStart: 2,
				hotFiles: ['src/hot.ts'],
			}),
		).join('\n');
		expect(text).toContain('## Epic scorecard');
		expect(text).toContain('**forced**');
		expect(text).toContain('4 completed in the epic (plan: 9 task(s))');
		expect(text).toContain('2 already completed at start');
		expect(text).toContain('concurrency factor ×1.733');
		expect(text).toContain(EPIC_CONCURRENCY_FACTOR_LABEL);
		expect(text).toContain('Stage A 3/4 (75%)');
		expect(text).toContain('phase review 1/3 (33%)');
		expect(text).toContain('hot files: src/hot.ts');
		expect(text).not.toMatch(/\bspeedup ×/);
	});
});
