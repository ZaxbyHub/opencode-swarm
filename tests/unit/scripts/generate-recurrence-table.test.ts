import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// #3605 AC2: generate-recurrence-table.sh renders the Phase 4.2 disposition
// table from digest-bound TSV inputs and fails closed on unmatched joins,
// digest disagreement, non-canonical dispositions, orphan dispositions (count
// drift), and rendered/summary count disagreement. The table carries ONE ROW
// PER HIT so the embedded table satisfies the phase-4.2 rows == hits-sum rule.

const ROOT = path.join(import.meta.dir, '..', '..', '..');
const SCRIPT = path.join(
	ROOT,
	'.opencode',
	'skills',
	'issue-tracer',
	'scripts',
	'generate-recurrence-table.sh',
);

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('recurrence-table-test-');
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

const DIGEST = '0123456789abcdef0123456789abcdef01234567';

async function writeInput(name: string, lines: string[]): Promise<string> {
	const target = path.join(directory, name);
	// join('\n') only: an explicit trailing-newline leg uses '' as its last
	// element to produce a file whose final line is unterminated.
	await fs.writeFile(target, lines.join('\n'), 'utf-8');
	return target;
}

function run(
	hits: string,
	disp: string,
	outdir: string,
): { status: number; output: string } {
	const [shell, ...rest] = bashCommand(
		path.relative(ROOT, SCRIPT),
		path.relative(ROOT, hits),
		path.relative(ROOT, disp),
		path.relative(ROOT, outdir),
	);
	const result = spawnSync(shell, rest, {
		cwd: ROOT,
		encoding: 'utf-8',
		stdin: 'ignore',
		timeout: 30_000,
	});
	return {
		status: result.status ?? -1,
		output: `${result.stdout}${result.stderr}`,
	};
}

describe('generate-recurrence-table (#3605 AC2)', () => {
	test('per-hit rows: a count-2 predicate renders twice and the summary counts hits, not predicates', async () => {
		const hits = await writeInput('hits.tsv', [
			`tree-digest: ${DIGEST}`,
			'census-mislabel\t2\tsrc/a.ts src/b.ts',
			'census-stale\t1\tsrc/c.ts',
		]);
		const disp = await writeInput('disp.tsv', [
			`tree-digest: ${DIGEST}`,
			'census-mislabel\tFIX\tre-labeled by the sweep',
			'census-stale\tFALSE_POSITIVE\tnot on a touched path',
		]);
		const outdir = path.join(directory, 'out-ok');
		const { status, output } = run(hits, disp, outdir);
		expect(status).toBe(0);
		expect(output).toContain('RECURRENCE-TABLE: ok rows=3');
		const table = await fs.readFile(
			path.join(outdir, 'recurrence-table.md'),
			'utf-8',
		);
		expect(table).toContain(
			'| census-mislabel | 2 | FIX | re-labeled by the sweep |',
		);
		expect(table).toContain(
			'| census-stale | 1 | FALSE_POSITIVE | not on a touched path |',
		);
		// One row per hit: the count-2 predicate appears exactly twice.
		const mislabelRows = table
			.split('\n')
			.filter((line) => line.startsWith('| census-mislabel |')).length;
		expect(mislabelRows).toBe(2);
		// Data rows (header and separator excluded) equal the hit sum.
		const dataRows = table
			.split('\n')
			.filter((line) => line.startsWith('| ') && !line.startsWith('|---'))
			.filter((line) => !line.startsWith('| Predicate')).length;
		expect(dataRows).toBe(3);
		expect(table).toContain('rows: 3 fixed: 2');
	}, 60_000);

	test('a hit predicate without a disposition is refused unmatched', async () => {
		const hits = await writeInput('hits.tsv', [
			`tree-digest: ${DIGEST}`,
			'census-mislabel\t2\tsrc/a.ts',
			'census-stale\t1\tsrc/c.ts',
		]);
		const disp = await writeInput('disp.tsv', [
			`tree-digest: ${DIGEST}`,
			'census-mislabel\tFIX\tnote',
		]);
		const { status, output } = run(
			hits,
			disp,
			path.join(directory, 'out-unmatched'),
		);
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: unmatched');
	}, 60_000);

	test('divergent tree digests are refused', async () => {
		const hits = await writeInput('hits.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\t1\tsrc/a.ts',
		]);
		const disp = await writeInput('disp.tsv', [
			`tree-digest: fedcba9876543210fedcba9876543210fedcba98`,
			'p\tFIX\tnote',
		]);
		const { status, output } = run(
			hits,
			disp,
			path.join(directory, 'out-digest'),
		);
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: digest');
	}, 60_000);

	test('an input missing its tree-digest header is refused as digest (F-09)', async () => {
		const hits = await writeInput('hits-headerless.tsv', [
			'p\t1\tsrc/a.ts',
			'',
		]);
		const disp = await writeInput('disp-headerless.tsv', ['p\tFIX\tnote', '']);
		const { status, output } = run(
			hits,
			disp,
			path.join(directory, 'out-headerless'),
		);
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: digest');
	}, 60_000);

	test('an orphan disposition (no hit) is refused as count drift', async () => {
		const hits = await writeInput('hits.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\t1\tsrc/a.ts',
		]);
		const disp = await writeInput('disp.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\tFIX\tnote',
			'ghost\tFIX\tdisposition with no hit',
		]);
		const { status, output } = run(
			hits,
			disp,
			path.join(directory, 'out-orphan'),
		);
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: count-drift');
	}, 60_000);

	test('duplicate predicate rows are refused (ambiguous joins)', async () => {
		const hits = await writeInput('hits.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\t1\tsrc/a.ts',
			'p\t2\tsrc/b.ts',
		]);
		const disp = await writeInput('disp.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\tFIX\tnote',
		]);
		const { status, output } = run(hits, disp, path.join(directory, 'out-dup'));
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: unmatched');
	}, 60_000);

	test('an empty or non-canonical disposition cell is refused with the vocabulary named', async () => {
		const hits = await writeInput('hits-bad.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\t1\tsrc/a.ts',
		]);
		const typoDisp = await writeInput('disp-typo.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\tFIXD\tnote',
		]);
		const { status, output } = run(
			hits,
			typoDisp,
			path.join(directory, 'out-typo'),
		);
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: disposition');
		expect(output).toContain(
			'FIX / FALSE_POSITIVE / OUT_OF_CLASS / DEFERRED_WITH_USER_APPROVAL',
		);

		const emptyDisp = await writeInput('disp-empty.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\t\tnote',
		]);
		const empty = run(hits, emptyDisp, path.join(directory, 'out-empty'));
		expect(empty.status).toBe(1);
		expect(empty.output).toContain('GENERATION-REFUSED: disposition');
	}, 60_000);

	test('zero hit rows are refused as count drift', async () => {
		const hits = await writeInput('hits-zero.tsv', [
			`tree-digest: ${DIGEST}`,
			'',
		]);
		const disp = await writeInput('disp-zero.tsv', [
			`tree-digest: ${DIGEST}`,
			'',
		]);
		const { status, output } = run(
			hits,
			disp,
			path.join(directory, 'out-zero'),
		);
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: count-drift');
	}, 60_000);

	test('a zero or non-numeric hit count is refused (vacuous-row guard)', async () => {
		const hits = await writeInput('hits-badcount.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\t0\tsrc/a.ts',
			'q\tnot-a-number\tsrc/b.ts',
		]);
		const disp = await writeInput('disp-badcount.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\tFIX\tnote',
			'q\tFIX\tnote',
		]);
		const { status, output } = run(
			hits,
			disp,
			path.join(directory, 'out-badcount'),
		);
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: count');
	}, 60_000);

	test('a final hit row without a trailing newline is still rendered', async () => {
		const hits = await writeInput('hits-noln.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\t1\tsrc/a.ts',
		]);
		const disp = await writeInput('disp-noln.tsv', [
			`tree-digest: ${DIGEST}`,
			'p\tFIX\tnote',
		]);
		const outdir = path.join(directory, 'out-noln');
		const { status, output } = run(hits, disp, outdir);
		expect(status).toBe(0);
		expect(output).toContain('RECURRENCE-TABLE: ok rows=1');
		const table = await fs.readFile(
			path.join(outdir, 'recurrence-table.md'),
			'utf-8',
		);
		expect(table).toContain('| p | 1 | FIX | note |');
	}, 60_000);

	test('render join is exact column-1: a suffix predicate listed first cannot hijack the row', async () => {
		const hits = await writeInput('hits-suffix.tsv', [
			`tree-digest: ${DIGEST}`,
			'foo	1	src/a.ts',
			'bar-foo	1	src/b.ts',
		]);
		const disp = await writeInput('disp-suffix.tsv', [
			`tree-digest: ${DIGEST}`,
			'bar-foo	FALSE_POSITIVE	note-bar',
			'foo	FIX	note-foo',
		]);
		const outdir = path.join(directory, 'out-suffix');
		const { status, output } = run(hits, disp, outdir);
		expect(status).toBe(0);
		expect(output).toContain('RECURRENCE-TABLE: ok rows=2');
		const table = await fs.readFile(
			path.join(outdir, 'recurrence-table.md'),
			'utf-8',
		);
		expect(table).toContain('| foo | 1 | FIX | note-foo |');
		expect(table).toContain('| bar-foo | 1 | FALSE_POSITIVE | note-bar |');
	}, 60_000);

	test('a backslash-bearing predicate joins exactly (no awk escape mangling)', async () => {
		const hits = await writeInput('hits-backslash.tsv', [
			`tree-digest: ${DIGEST}`,
			'foo\\.bar\t1\tsrc/a.ts',
		]);
		const disp = await writeInput('disp-backslash.tsv', [
			`tree-digest: ${DIGEST}`,
			'foo\\.bar\tFIX\tnote',
		]);
		const outdir = path.join(directory, 'out-backslash');
		const { status, output } = run(hits, disp, outdir);
		expect(status).toBe(0);
		expect(output).toContain('RECURRENCE-TABLE: ok rows=1');
		const table = await fs.readFile(
			path.join(outdir, 'recurrence-table.md'),
			'utf-8',
		);
		expect(table).toContain('| foo\\.bar | 1 | FIX | note |');
	}, 60_000);
});
