import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// #3605 AC2: generate-recurrence-table.sh renders the Phase 4.2 disposition
// table from digest-bound TSV inputs and fails closed on unmatched joins,
// digest disagreement, orphan dispositions (count drift), and rendered/summary
// count disagreement.

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
	await fs.writeFile(target, lines.join('\n') + '\n', 'utf-8');
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
	test('matched inputs render a table whose counts agree with the summary', async () => {
		const hits = await writeInput('hits.tsv', [
			`tree-digest: ${DIGEST}`,
			'census-mislabel\t2\tsrc/a.ts src/b.ts',
			'census-stale\t1\tsrc/c.ts',
		]);
		const disp = await writeInput('disp.tsv', [
			`tree-digest: ${DIGEST}`,
			'census-mislabel\tFIXED\tre-labeled by the sweep',
			'census-stale\tFALSE_POSITIVE\tnot on a touched path',
		]);
		const outdir = path.join(directory, 'out-ok');
		const { status, output } = run(hits, disp, outdir);
		expect(status).toBe(0);
		expect(output).toContain('RECURRENCE-TABLE: ok rows=2');
		const table = await fs.readFile(
			path.join(outdir, 'recurrence-table.md'),
			'utf-8',
		);
		expect(table).toContain(
			'| census-mislabel | 2 | FIXED | re-labeled by the sweep |',
		);
		expect(table).toContain('rows: 2 fixed: 1');
	}, 60_000);

	test('a hit predicate without a disposition is refused unmatched', async () => {
		const hits = await writeInput('hits.tsv', [
			`tree-digest: ${DIGEST}`,
			'census-mislabel\t2\tsrc/a.ts',
			'census-stale\t1\tsrc/c.ts',
		]);
		const disp = await writeInput('disp.tsv', [
			`tree-digest: ${DIGEST}`,
			'census-mislabel\tFIXED\tnote',
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
			'p\tFIXED\tnote',
		]);
		const { status, output } = run(
			hits,
			disp,
			path.join(directory, 'out-digest'),
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
			'p\tFIXED\tnote',
			'ghost\tFIXED\tdisposition with no hit',
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
			'p\tFIXED\tnote',
		]);
		const { status, output } = run(hits, disp, path.join(directory, 'out-dup'));
		expect(status).toBe(1);
		expect(output).toContain('GENERATION-REFUSED: unmatched');
	}, 60_000);

	test('render join is exact column-1: a suffix predicate listed first cannot hijack the row', async () => {
		const hits = await writeInput('hits-suffix.tsv', [
			`tree-digest: ${DIGEST}`,
			'foo	1	src/a.ts',
			'bar-foo	1	src/b.ts',
		]);
		const disp = await writeInput('disp-suffix.tsv', [
			`tree-digest: ${DIGEST}`,
			'bar-foo	WONTFIX	note-bar',
			'foo	FIXED	note-foo',
		]);
		const outdir = path.join(directory, 'out-suffix');
		const { status, output } = run(hits, disp, outdir);
		expect(status).toBe(0);
		expect(output).toContain('RECURRENCE-TABLE: ok rows=2');
		const table = await fs.readFile(
			path.join(outdir, 'recurrence-table.md'),
			'utf-8',
		);
		expect(table).toContain('| foo | 1 | FIXED | note-foo |');
		expect(table).toContain('| bar-foo | 1 | WONTFIX | note-bar |');
	}, 60_000);
});
