import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmp = '';

function call(args: Record<string, unknown>): Promise<string> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable).execute(args, {
		directory: tmp,
	});
}

function parse(out: string): Record<string, unknown> {
	return JSON.parse(out) as Record<string, unknown>;
}

const UTIL_SOURCE = [
	'export function add(a: number, b: number) { return a + b; }',
	'export function sub(a: number, b: number) { return a - b; }',
	'',
].join('\n');

beforeEach(() => {
	tmp = canonicalMkdtemp('repo-map-kg14-diff-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(path.join(tmp, 'src/util.ts'), UTIL_SOURCE);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nconsole.log(add(1, 2));\n",
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map: diff_context (KG-14)', () => {
	it('parses a unified diff and maps hunks to changed symbols', async () => {
		await call({ action: 'build' });
		const diff = [
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -2,1 +2,1 @@',
			'-export function sub(a, b) { return a - b; }',
			'+export function sub(a: number, b: number) { return a - b; }',
		].join('\n');
		const r = parse(await call({ action: 'diff_context', diff }));
		expect(r.success).toBe(true);
		expect(r.granularity).toBe('hunk');
		const files = r.files as Array<Record<string, unknown>>;
		expect(files).toHaveLength(1);
		expect(files[0]?.file).toBe('src/util.ts');
		expect(files[0]?.known).toBe(true);
		const symbols = files[0]?.symbols as Array<Record<string, unknown>>;
		expect(symbols.map((s) => s.symbol)).toEqual(['sub']);
		expect(symbols[0]?.changedLines).toEqual([2]);
		const impact = r.impact as Record<string, unknown>;
		// The change to src/util.ts is consumed by src/main.ts → non-empty impact.
		expect(impact.files).toContain('src/main.ts');
		expect(['low', 'medium', 'high', 'critical']).toContain(impact.risk);
		// Nothing was dropped in this bounded request (OW-1 envelope).
		expect(r.truncated).toBe(false);
		expect((r.budget as Record<string, unknown>).dropped).toBe(0);
	});

	it('accepts a files list at file granularity', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'diff_context', files: ['src/util.ts'] }),
		);
		expect(r.granularity).toBe('file');
		const symbols = (
			(r.files as Array<Record<string, unknown>>)[0]?.symbols as Array<
				Record<string, unknown>
			>
		)
			.map((s) => s.symbol)
			.sort();
		expect(symbols).toEqual(['add', 'sub']);
	});

	it('errors when the graph is missing', async () => {
		const r = parse(
			await call({ action: 'diff_context', files: ['src/util.ts'] }),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('No repo graph found');
	});

	it('requires files or diff', async () => {
		await call({ action: 'build' });
		const r = parse(await call({ action: 'diff_context' }));
		expect(r.success).toBe(false);
		expect(r.error).toContain('requires `files` (non-empty) or `diff`');
	});

	it('returns a structured error for an unparseable diff', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'diff_context', diff: 'not a diff at all' }),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('no parseable file headers');
	});

	it('rejects control characters (beyond newline/tab) in diff text', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'diff_context',
				diff: '--- a/src/util.ts\n+++ b/src/util.ts\n\u0007@@ -1 +1 @@',
			}),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain(
			'diff contains control characters (class: control)',
		);
	});

	it('rejects bidi override characters in diff text', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'diff_context',
				diff: '--- a/src/util.ts\n+++ b/src/util.ts\n\u202e@@ -1 +1 @@',
			}),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('class: bidi');
	});

	it('skips traversal paths inside the diff with a warning', async () => {
		await call({ action: 'build' });
		const diff = [
			'--- a/../../outside.ts',
			'+++ b/../../outside.ts',
			'@@ -1,1 +1,1 @@',
			'+x',
		].join('\n');
		const r = parse(await call({ action: 'diff_context', diff }));
		expect(r.success).toBe(true);
		expect(r.files).toEqual([]);
		expect((r.warnings as string[]).join('\n')).toContain(
			'skipped unsafe or non-graph path',
		);
	});

	it('rejects traversal in the files list via validateFile', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'diff_context', files: ['../escape.ts'] }),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('path traversal');
	});

	it('bounds changed symbols by top_n', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'diff_context',
				files: ['src/util.ts'],
				top_n: 1,
			}),
		);
		const symbols = (
			(r.files as Array<Record<string, unknown>>)[0]?.symbols as Array<
				Record<string, unknown>
			>
		).map((s) => s.symbol);
		expect(symbols).toHaveLength(1);
		expect((r.warnings as string[]).join('\n')).toContain(
			'omitted in src/util.ts',
		);
	});
});
