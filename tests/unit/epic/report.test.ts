/**
 * Epic v2 C8 — `/swarm epic report` selection (`report.ts`) and the
 * command surface: the live scorecard of the open epic (with its orphan /
 * config notes), past epics from their `epic-report-v2` close reports
 * (validated group by group), selection by `last`, report key and epic key
 * (newest by mtime), and every refusal. Real temp projects, real lifecycle
 * rows and closes, frozen clock.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../../src/commands/epic';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { closeEpic } from '../../../src/epic/close';
import { DEFAULT_EPIC_LEARNING_SETTINGS } from '../../../src/epic/learning';
import {
	listEpicPriorReports,
	MAX_EPIC_REPORT_BYTES,
	_internals as reportInternals,
	scorecardFromReport,
	selectEpicReport,
} from '../../../src/epic/report';
import { savePlan } from '../../../src/plan/manager';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	createStartProject,
	sizedPlan,
	writeProjectConfig,
} from './start-fixture';

const SESSION = 'ses_report';
const NOW = '2026-07-01T09:00:00.000Z';
const settings = DEFAULT_EPIC_LEARNING_SETTINGS;
let dir: string;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: NOW, fixedNow: Date.parse(NOW) });
	dir = await createStartProject('epic-report-', { git: false });
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

const reportsDir = () => path.join(dir, '.swarm', 'epic-prior', 'reports');

/** Open an epic for the on-disk plan with one closed 2-task wave. */
function openWithWave(startedAt = '2026-07-01T08:00:00.000Z') {
	return openEpicForTest(dir, {
		startedAt,
		forced: true,
		waves: [
			{
				seq: 1,
				phase: 1,
				kind: 'parallel',
				taskIds: ['1.1', '1.2'],
				files: { '1.1': ['src/file-1.ts'], '1.2': ['src/file-2.ts'] },
				cochange: null,
				baseHead: null,
				issuedAt: '2026-07-01T08:00:00.000Z',
				closedAt: '2026-07-01T08:10:00.000Z',
				status: 'closed',
			},
		],
		tasks: Object.fromEntries(
			['1.1', '1.2'].map((id) => [
				id,
				{
					taskId: id,
					phase: 1,
					waveSeq: 1,
					resolution: 'completed' as const,
					resolvedAt: '2026-07-01T08:08:00.000Z',
					generation: 1,
					stageAFailures: 0,
					stageBFailures: 0,
					mergeFailure: null,
					declared: [`src/file-${id.slice(2)}.ts`],
					undeclared: [],
					attribution: 'no-git' as const,
					reopened: 0,
					marker: null,
				},
			]),
		),
	});
}

async function closeAbandoned(): Promise<string> {
	const result = await closeEpic({ directory: dir, abandon: true });
	if (result.status !== 'closed') throw new Error(result.status);
	return result.report.reportKey;
}

describe('selectEpicReport', () => {
	test('nothing open, no reports ⇒ none (bare and last)', async () => {
		expect(await selectEpicReport(dir, null, settings)).toMatchObject({
			status: 'none',
			message: expect.stringContaining('No epic is open'),
		});
		expect(await selectEpicReport(dir, 'last', settings)).toMatchObject({
			status: 'none',
		});
	});

	test('bare: the live scorecard of the open epic (outcome open, plan total)', async () => {
		const epic = openWithWave();
		const selection = await selectEpicReport(dir, null, settings);
		expect(selection).toMatchObject({
			status: 'ok',
			source: 'live',
			reportKey: null,
			scorecard: {
				epicKey: epic.epicKey,
				outcome: 'open',
				closedAt: null,
				forced: true,
				tasks: { total: 6, completedInEpic: 2 },
				waves: { count: 1, parallel: 1, maxWidth: 2 },
				time: { spanMs: 600_000, workMs: 960_000, concurrencyFactor: 1.6 },
			},
		});
	});

	test('a v2 close report: by last, report key and epic key — the embedded scorecard', async () => {
		const epic = openWithWave();
		const key = await closeAbandoned();
		const embedded = JSON.parse(
			fs.readFileSync(path.join(reportsDir(), `${key}.json`), 'utf-8'),
		).scorecard;
		expect(embedded).toMatchObject({
			outcome: 'abandoned',
			closedAt: NOW,
			tasks: { completedInEpic: 2 },
		});
		for (const selector of [null, 'last', key, epic.epicKey]) {
			expect(await selectEpicReport(dir, selector, settings)).toEqual({
				status: 'ok',
				source: 'report',
				reportKey: key,
				scorecard: embedded,
			});
		}
	});

	test('live: an orphaned epic and unreadable lifecycle state are reported, not hidden', async () => {
		openWithWave();
		const realInspect = reportInternals.inspectEpic;
		try {
			reportInternals.inspectEpic = (d) => ({
				...realInspect(d),
				orphanReason: 'plan-renamed',
			});
			const orphaned = await selectEpicReport(dir, null, settings);
			expect(orphaned).toMatchObject({ status: 'ok', source: 'live' });
			if (orphaned.status !== 'ok') return;
			expect(orphaned.notes?.[0]).toContain(
				'no longer matches the current plan (plan-renamed)',
			);
			reportInternals.inspectEpic = (d) => ({
				...realInspect(d),
				record: null,
				unreadable: 'row payload is not JSON',
			});
			expect(await selectEpicReport(dir, null, settings)).toEqual({
				status: 'error',
				message: expect.stringContaining(
					'lifecycle state is unreadable (row payload is not JSON)',
				),
			});
			reportInternals.inspectEpic = () => {
				throw new Error('db locked');
			};
			expect(await selectEpicReport(dir, null, settings)).toMatchObject({
				status: 'error',
				message: expect.stringContaining('(db locked)'),
			});
		} finally {
			reportInternals.inspectEpic = realInspect;
		}
	});

	test('corrupted and oversized reports are refused, never half-rendered', async () => {
		openWithWave();
		const key = await closeAbandoned();
		const file = path.join(reportsDir(), `${key}.json`);
		const good = JSON.parse(fs.readFileSync(file, 'utf-8'));
		const corrupt = (mutate: (card: Record<string, any>) => void) => {
			const copy = structuredClone(good);
			mutate(copy.scorecard);
			fs.writeFileSync(file, JSON.stringify(copy));
			return selectEpicReport(dir, key, settings);
		};
		for (const [mutate, field] of [
			[(c) => delete c.conflicts, 'scorecard.conflicts'],
			[
				(c) => (c.rework.extraGenerations = '2'),
				'scorecard.rework.extraGenerations',
			],
			[
				(c) => (c.gates.stageBFirstPass.rate = 3),
				'scorecard.gates.stageBFirstPass.rate',
			],
			[
				(c) => (c.learning.topHotFiles = [1]),
				'scorecard.learning.topHotFiles.0',
			],
			[
				(c) => delete c.sizingAtStart.effectiveSpeedup,
				'scorecard.sizingAtStart.effectiveSpeedup',
			],
			[
				(c) => (c.tasks.completedInEpic = -1),
				'scorecard.tasks.completedInEpic',
			],
			[(c) => (c.waves = null), 'scorecard.waves'],
			[
				(c) => (c.time.spanMs = Number.POSITIVE_INFINITY),
				'scorecard.time.spanMs',
			],
		] as Array<[(c: Record<string, any>) => void, string]>) {
			expect(await corrupt(mutate)).toEqual({
				status: 'error',
				message: expect.stringContaining(`invalid ${field}:`),
			});
		}
		// An oversized report is not read at all.
		fs.writeFileSync(file, ' '.repeat(MAX_EPIC_REPORT_BYTES + 1));
		expect(await selectEpicReport(dir, key, settings)).toEqual({
			status: 'error',
			message: expect.stringContaining(
				`larger than ${MAX_EPIC_REPORT_BYTES} bytes`,
			),
		});
		// The command surfaces the refusal as text.
		expect(await handleEpicCommand(dir, ['report', key], SESSION)).toContain(
			'was not read',
		);
	});

	test('newest by mtime wins for last and for an epic key with several reports', async () => {
		openWithWave('2026-07-01T07:00:00.000Z');
		const older = await closeAbandoned();
		const epic = openWithWave('2026-07-01T08:00:00.000Z');
		const newer = await closeAbandoned();
		expect(older).not.toBe(newer);
		const stamp = (name: string, seconds: number) =>
			fs.utimesSync(path.join(reportsDir(), name), seconds, seconds);
		stamp(`${older}.json`, 2_000_000_000);
		stamp(`${newer}.json`, 1_000_000_000);
		expect(listEpicPriorReports(dir)).toEqual([
			`${older}.json`,
			`${newer}.json`,
		]);
		expect(await selectEpicReport(dir, 'last', settings)).toMatchObject({
			reportKey: older,
		});
		expect(await selectEpicReport(dir, epic.epicKey, settings)).toMatchObject({
			reportKey: older,
		});
		expect(await selectEpicReport(dir, newer, settings)).toMatchObject({
			reportKey: newer,
		});
	});

	test('refusals: bad selector, unknown key, still-open epic, unreadable reports', async () => {
		expect(await selectEpicReport(dir, '../escape', settings)).toMatchObject({
			status: 'error',
			message: expect.stringContaining('is not a report or epic key'),
		});
		expect(await selectEpicReport(dir, 'nope', settings)).toMatchObject({
			status: 'none',
			message: expect.stringContaining('No report for `nope`'),
		});
		const epic = openWithWave();
		expect(await selectEpicReport(dir, epic.epicKey, settings)).toMatchObject({
			status: 'none',
			message: expect.stringContaining('is still open'),
		});
		fs.mkdirSync(reportsDir(), { recursive: true });
		const broken = 'x-20260101T000000Z';
		fs.writeFileSync(path.join(reportsDir(), `${broken}.json`), '{oops');
		expect(await selectEpicReport(dir, broken, settings)).toMatchObject({
			status: 'error',
			message: expect.stringContaining('could not be read'),
		});
		fs.writeFileSync(
			path.join(reportsDir(), `${broken}.json`),
			JSON.stringify({ schema: 'epic-report-v9' }),
		);
		expect(await selectEpicReport(dir, broken, settings)).toMatchObject({
			status: 'error',
			message: expect.stringContaining('unknown report schema'),
		});
	});
});

describe('scorecardFromReport', () => {
	test('rejects malformed payloads and other schemas instead of throwing', () => {
		expect(scorecardFromReport(null)).toEqual({ error: 'not a JSON object' });
		expect(scorecardFromReport([])).toEqual({ error: 'not a JSON object' });
		expect(scorecardFromReport({ schema: 'epic-report-v2' })).toMatchObject({
			error: expect.stringContaining('invalid scorecard:'),
		});
		// Only the shipped schema is read (no reader for unreleased formats).
		expect(scorecardFromReport({ schema: 'epic-report-v1' })).toEqual({
			error: 'unknown report schema "epic-report-v1"',
		});
	});
});

describe('/swarm epic report (command)', () => {
	test('markdown and json; options are validated; works with Epic config off', async () => {
		writeProjectConfig(dir, {
			epic: { mode: { enabled: false } },
		});
		expect(await handleEpicCommand(dir, ['report'], SESSION)).toContain(
			'No epic is open and no past epic report exists',
		);
		openWithWave();
		const markdown = await handleEpicCommand(dir, ['report'], SESSION);
		expect(markdown).toContain('## Epic scorecard');
		expect(markdown).toContain('(open)');
		expect(markdown).toContain('concurrency factor ×1.6');
		expect(markdown).toContain('not speedup');
		expect(markdown).toContain('Live scorecard of the open epic');
		// Like status, the live view works with the config gate off (noted).
		expect(markdown).toContain('Epic Mode is disabled by config');
		const json = JSON.parse(
			await handleEpicCommand(dir, ['report', '--format', 'json'], SESSION),
		);
		expect(json).toMatchObject({
			source: 'live',
			reportKey: null,
			scorecard: { schema: 'epic-scorecard-v1', outcome: 'open' },
		});
		const key = await closeAbandoned();
		const past = await handleEpicCommand(
			dir,
			['report', 'last', '--format=json'],
			SESSION,
		);
		expect(JSON.parse(past)).toMatchObject({
			source: 'report',
			reportKey: key,
		});
		expect(await handleEpicCommand(dir, ['report', key], SESSION)).toContain(
			`.swarm/epic-prior/reports/${key}.json`,
		);
		for (const [args, text] of [
			[['report', '--format', 'xml'], '`--format` takes json or markdown'],
			[['report', 'a', 'b'], 'takes at most one report or epic key'],
			[['report', '--bogus'], 'Unknown option(s) for `/swarm epic report`'],
		] as const) {
			expect(await handleEpicCommand(dir, [...args], SESSION)).toContain(text);
		}
	});

	test('the close output points at the scorecard', async () => {
		const plan = sizedPlan('Start Plan', 6);
		for (const task of plan.phases[0].tasks) task.status = 'completed';
		await savePlan(dir, plan);
		openWithWave();
		const closed = await handleEpicCommand(dir, ['close'], SESSION);
		expect(closed).toContain('Scorecard: 1 wave(s) (1 with 2+ tasks)');
		expect(closed).toContain('concurrency factor ×1.6 (not a speedup)');
		expect(closed).toMatch(/full scorecard: `\/swarm epic report [\w-]+`/);
	});
});
