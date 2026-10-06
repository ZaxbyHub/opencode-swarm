/**
 * Epic v2 C6 — `/swarm epic learning` and `/swarm epic prior [show|reset]`
 * (`src/commands/epic-learning.ts`) over a real temp `.swarm/`:
 *   - learning: settings, source (posterior / prior / neutral / unreadable),
 *     hot files and learned co-writes; disabled says so;
 *   - prior show: absent / stored statistics + import marker / unreadable;
 *   - prior reset: two-step through the shared destructive-confirm primitive
 *     — the preview changes nothing and prints a single-use token bound to
 *     the prior's content; `--confirm=<token>` clears it (and names an open
 *     epic that keeps its posterior); a wrong, reused or stale token clears
 *     nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	renderEpicLearning,
	renderEpicPrior,
} from '../../../src/commands/epic-learning';
import { DEFAULT_EPIC_LEARNING_SETTINGS } from '../../../src/epic/learning';
import {
	EPIC_PRIOR_LEARNING_RELATIVE_PATH,
	readEpicPrior,
} from '../../../src/epic/learning-store';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realInternals = { ..._internals };
const ON = { ...DEFAULT_EPIC_LEARNING_SETTINGS };
const NOW = Date.parse('2026-10-01T00:00:00.000Z');
let dir: string;

function writePrior(content: unknown): void {
	const target = path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(
		target,
		typeof content === 'string' ? content : JSON.stringify(content),
	);
}

const PRIOR = {
	schema: 'epic-learning-v1',
	updatedAt: '2026-10-01T00:00:00.000Z',
	importedFrom: {
		source: 'epic-v1-import',
		at: '2026-09-01T00:00:00.000Z',
		calibrationHotModules: 3,
		divergenceRecords: 7,
	},
	mergedEpics: ['plan-abc-20260901T000000Z'],
	files: [
		{ path: 'src/hot.ts', alpha: 3, beta: 1 },
		{ path: 'src/cold.ts', alpha: 0, beta: 5 },
	],
	edges: [{ from: 'src/a.ts', to: 'src/hot.ts', weight: 1.5 }],
};

beforeEach(() => {
	dir = canonicalMkdtemp('epic-learning-cmd-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	_internals.getOpenEpic = (() => null) as never;
	_internals.now = () => NOW;
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('/swarm epic learning', () => {
	test('neutral start without a prior', () => {
		const out = renderEpicLearning(dir, ON);
		expect(out).toContain('## Epic Mode — Learning');
		expect(out).toContain(
			'Settings: enabled; decay_per_epic 0.7; half_life_days 60; hot_excess 0.25',
		);
		expect(out).toContain('nothing learned yet — a neutral start');
		expect(out).toContain('### Hot files');
		expect(out).toContain('_None._ A file becomes hot only on excess evidence');
	});

	test('the prior: hot files with their evidence and the learned co-writes', () => {
		writePrior(PRIOR);
		const out = renderEpicLearning(dir, ON);
		expect(out).toContain(
			'Source: the project prior (`.swarm/epic-prior/learning.json`)',
		);
		expect(out).toContain(
			// α' = 3 − 1.5 (strongest co-writer) ⇒ r = 1.7 / 4.5.
			'- `src/hot.ts` — incidents 3 (1.5 counted after its strongest co-writer), exposures 1, rate 0.38',
		);
		expect(out).not.toContain('`src/cold.ts` —');
		expect(out).toContain('- `src/a.ts` → `src/hot.ts` (weight 1.5)');
	});

	test('an open epic without a posterior falls back to the prior; disabled says so', () => {
		writePrior(PRIOR);
		_internals.getOpenEpic = (() => stubEpicRecord()) as never;
		expect(renderEpicLearning(dir, ON)).toContain('Source: the project prior');
		const off = renderEpicLearning(dir, { ...ON, enabled: false });
		expect(off).toContain('Settings: **disabled**');
		expect(off).toContain('Learning is disabled');
	});

	test('an unreadable prior is reported with the reset remedy', () => {
		writePrior('{ broken');
		expect(renderEpicLearning(dir, ON)).toContain('`/swarm epic prior reset`');
	});
});

describe('/swarm epic prior', () => {
	test('show: absent, stored, unreadable', () => {
		expect(renderEpicPrior(dir, [], ON)).toContain('No project prior yet');
		writePrior(PRIOR);
		const shown = renderEpicPrior(dir, ['show'], ON);
		expect(shown).toContain(
			'1 epic(s) merged (newest plan-abc-20260901T000000Z)',
		);
		expect(shown).toContain(
			'Imported once from Epic v1 at 2026-09-01T00:00:00.000Z: 3 hot module(s), 7 divergence record(s).',
		);
		expect(shown).toContain('2 file statistic(s), 1 learned co-write(s)');
		writePrior('[]');
		expect(renderEpicPrior(dir, ['show'], ON)).toContain('⚠️ Unreadable');
		expect(renderEpicPrior(dir, ['show', '--x'], ON)).toContain(
			'Unknown option(s)',
		);
	});

	function previewToken(): string {
		const out = renderEpicPrior(dir, ['reset'], ON);
		const match = /--confirm=([0-9a-f]+)/.exec(out);
		if (!match) throw new Error(`no token in: ${out}`);
		return match[1];
	}

	test('reset without --confirm previews, prints a token and changes nothing', () => {
		writePrior(PRIOR);
		const out = renderEpicPrior(dir, ['reset'], ON);
		expect(out).toContain('(preview)');
		expect(out).toContain(
			'This would clear 2 file statistic(s) and 1 learned co-write(s)',
		);
		expect(out).toContain('Nothing changed.');
		expect(out).toMatch(
			/--confirm=[0-9a-f]{24}` \(single use, valid 15 minutes\)/,
		);
		const prior = readEpicPrior(dir);
		expect(prior.status === 'ok' && prior.prior.stats.files.size).toBe(2);
	});

	test('reset --confirm=<token> clears it; an open epic keeps its posterior', () => {
		writePrior(PRIOR);
		_internals.getOpenEpic = (() => stubEpicRecord()) as never;
		const token = previewToken();
		const out = renderEpicPrior(dir, ['reset', `--confirm=${token}`], ON);
		expect(out).toContain('## Epic Mode — Project prior reset');
		expect(out).toContain('keeps its posterior');
		const prior = readEpicPrior(dir);
		if (prior.status !== 'ok') throw new Error('prior missing');
		expect(prior.prior.stats.files.size).toBe(0);
		expect(prior.prior.importedFrom?.divergenceRecords).toBe(7);
		// Single use: the same token cannot clear again.
		expect(renderEpicPrior(dir, ['reset', '--confirm', token], ON)).toContain(
			'Project prior NOT reset',
		);
	});

	test('a wrong token, or a prior that changed since the preview, clears nothing', () => {
		writePrior(PRIOR);
		previewToken();
		expect(renderEpicPrior(dir, ['reset', '--confirm=deadbeef'], ON)).toContain(
			'Project prior NOT reset: confirm token mismatch',
		);
		const token = previewToken();
		// An epic close merged into the prior after the preview.
		writePrior({ ...PRIOR, mergedEpics: ['a', 'b'] });
		expect(renderEpicPrior(dir, ['reset', `--confirm=${token}`], ON)).toContain(
			'Project prior NOT reset',
		);
		const prior = readEpicPrior(dir);
		expect(prior.status === 'ok' && prior.prior.stats.files.size).toBe(2);
	});

	test('bad options', () => {
		expect(renderEpicPrior(dir, ['reset', '--force'], ON)).toContain(
			'Unknown option(s)',
		);
		expect(renderEpicPrior(dir, ['reset', '--confirm'], ON)).toContain(
			'`--confirm` takes the token the preview printed',
		);
		expect(renderEpicPrior(dir, ['wipe'], ON)).toContain(
			"Unknown `/swarm epic prior` subcommand 'wipe'",
		);
	});
});
