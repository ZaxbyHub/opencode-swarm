/**
 * Epic Stage A attribution in a parallel wave — resolveEpicGateTaskAttribution.
 *
 * Live run (OpenCode, 4-task wave): the session's single currentTaskId held
 * the last coder that returned (2.4), so the pre_check_batch run over task
 * 2.1's files was credited to 2.4 and 2.1 never reached Stage B. While an
 * epic runs a multi-task wave, a gate run is credited by its files to the one
 * wave task whose frozen scope owns them, or to none.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	_internals,
	resolveEpicGateTaskAttribution,
} from '../../../src/epic/gate-policy';

const real = { ..._internals };
const DIR = path.resolve('/tmp/epic-gate-attribution-project');

afterEach(() => {
	Object.assign(_internals, real);
});

function openEpic(
	wave: { taskIds: string[]; files: Record<string, string[]> } | null,
	options: { status?: string; seq?: number | null } = {},
): void {
	_internals.epicSentinelExists = () => true;
	_internals.getOpenEpic = (() => ({
		activeWaveSeq: options.seq === undefined ? 3 : options.seq,
		waves: wave
			? [{ seq: 3, status: options.status ?? 'issued', ...wave }]
			: [],
	})) as never;
}

const WAVE = {
	taskIds: ['2.1', '2.2', '2.3', '2.4'],
	files: {
		'2.1': ['src/slugify.ts', 'tests/slugify.test.ts'],
		'2.2': ['src/stats.ts', 'tests/stats.test.ts'],
		'2.3': ['src/truncate.ts', 'tests/truncate.test.ts'],
		'2.4': ['src/case.ts', 'tests/case.test.ts'],
	},
};

describe('resolveEpicGateTaskAttribution', () => {
	test('no epic sentinel: upstream behaviour, and only the sentinel is probed', () => {
		let opened = false;
		_internals.epicSentinelExists = () => false;
		_internals.getOpenEpic = (() => {
			opened = true;
			return null;
		}) as never;
		expect(resolveEpicGateTaskAttribution(DIR, ['src/a.ts'])).toEqual({
			kind: 'none',
		});
		expect(opened).toBe(false);
	});

	test('no open epic, no active wave, or a closed wave: upstream behaviour', () => {
		_internals.epicSentinelExists = () => true;
		_internals.getOpenEpic = (() => null) as never;
		expect(resolveEpicGateTaskAttribution(DIR, ['src/a.ts']).kind).toBe('none');
		openEpic(WAVE, { seq: null });
		expect(resolveEpicGateTaskAttribution(DIR, ['src/slugify.ts']).kind).toBe(
			'none',
		);
		openEpic(WAVE, { status: 'closed' });
		expect(resolveEpicGateTaskAttribution(DIR, ['src/slugify.ts']).kind).toBe(
			'none',
		);
	});

	test('a single-task wave keeps upstream behaviour (currentTaskId is correct)', () => {
		openEpic({ taskIds: ['1.1'], files: { '1.1': ['src/types.ts'] } });
		expect(resolveEpicGateTaskAttribution(DIR, ['src/other.ts']).kind).toBe(
			'none',
		);
	});

	test('credits the one wave task whose frozen scope owns every checked file', () => {
		openEpic(WAVE);
		expect(
			resolveEpicGateTaskAttribution(DIR, [
				'src/slugify.ts',
				'tests/slugify.test.ts',
			]),
		).toEqual({ kind: 'task', taskId: '2.1' });
		expect(
			resolveEpicGateTaskAttribution(DIR, [path.join(DIR, 'src', 'case.ts')]),
		).toEqual({ kind: 'task', taskId: '2.4' });
	});

	test('a frozen directory covers the files beneath it', () => {
		openEpic({
			taskIds: ['2.1', '2.2'],
			files: { '2.1': ['src/slug'], '2.2': ['src/stats.ts'] },
		});
		expect(resolveEpicGateTaskAttribution(DIR, ['src/slug/index.ts'])).toEqual({
			kind: 'task',
			taskId: '2.1',
		});
	});

	test('fails closed with a remedy: no files, mixed tasks, foreign files, or ambiguous owners', () => {
		openEpic(WAVE);
		for (const files of [null, [], ['  ']]) {
			const result = resolveEpicGateTaskAttribution(DIR, files);
			expect(result.kind).toBe('unattributable');
			if (result.kind === 'unattributable')
				expect(result.message).toContain('names no files');
		}
		const mixed = resolveEpicGateTaskAttribution(DIR, [
			'src/slugify.ts',
			'src/stats.ts',
		]);
		expect(mixed.kind).toBe('unattributable');
		if (mixed.kind === 'unattributable')
			expect(mixed.message).toContain('no task of wave 3 owns every');
		expect(resolveEpicGateTaskAttribution(DIR, ['README.md']).kind).toBe(
			'unattributable',
		);
		openEpic({
			taskIds: ['2.1', '2.2'],
			files: { '2.1': ['src'], '2.2': ['src/stats.ts'] },
		});
		const ambiguous = resolveEpicGateTaskAttribution(DIR, ['src/stats.ts']);
		expect(ambiguous.kind).toBe('unattributable');
		if (ambiguous.kind === 'unattributable')
			expect(ambiguous.message).toContain('several');
	});

	test('unreadable epic state credits nothing', () => {
		_internals.epicSentinelExists = () => true;
		_internals.getOpenEpic = (() => {
			throw new Error('corrupt row');
		}) as never;
		const result = resolveEpicGateTaskAttribution(DIR, ['src/a.ts']);
		expect(result.kind).toBe('unattributable');
		if (result.kind === 'unattributable')
			expect(result.message).toContain('corrupt row');
	});
});
