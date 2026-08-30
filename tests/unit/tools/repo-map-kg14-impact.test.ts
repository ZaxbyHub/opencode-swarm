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

beforeEach(() => {
	tmp = canonicalMkdtemp('repo-map-kg14-impact-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		'export function add(a: number, b: number) { return a + b; }\n',
	);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nexport function run() { return add(1, 2); }\n",
	);
	fs.writeFileSync(
		path.join(tmp, 'src/util.test.ts'),
		"import { add } from './util';\nimport { test, expect } from 'bun:test';\ntest('add', () => { expect(add(1, 2)).toBe(3); });\n",
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map: impact_cone (KG-14)', () => {
	it('returns a symbol-level cone with provenance-bearing entries', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'impact_cone',
				file: 'src/util.ts',
				symbol: 'add',
			}),
		);
		expect(r.success).toBe(true);
		expect(r.target).toEqual({ file: 'src/util.ts', symbol: 'add' });
		const entries = r.entries as Array<Record<string, unknown>>;
		expect(entries.length).toBeGreaterThan(0);
		const callers = entries.filter((e) => e.direction === 'caller');
		expect(callers.length).toBeGreaterThan(0);
		for (const entry of callers) {
			expect(entry.confidence).not.toBeNull();
			expect(entry.resolution).not.toBeNull();
			expect(String(entry.file).startsWith('/')).toBe(false);
		}
		expect(r.risk).toBe((r.fileImpact as Record<string, unknown>).riskLevel);
	});

	it('aggregates cone-file ontology: tests and boundaries', async () => {
		await call({ action: 'build' });
		const r = parse(await call({ action: 'impact_cone', file: 'src/util.ts' }));
		expect(r.target).toEqual({ file: 'src/util.ts', symbol: null });
		expect((r.entries as unknown[]).length).toBe(0);
		expect(r.tests).toEqual(['src/util.test.ts']);
		expect((r.boundaries as unknown[]).length).toBeGreaterThan(0);
		const notes = (r.riskNotes as string[]).join('\n');
		expect(notes).toContain('test files affected');
	});

	it('errors when the graph is missing', async () => {
		const r = parse(await call({ action: 'impact_cone', file: 'src/util.ts' }));
		expect(r.success).toBe(false);
		expect(r.error).toContain('No repo graph found');
	});

	it('requires a file argument', async () => {
		await call({ action: 'build' });
		const r = parse(await call({ action: 'impact_cone' }));
		expect(r.success).toBe(false);
		expect(r.error).toContain('requires `file`');
	});

	it('rejects path traversal and control characters', async () => {
		await call({ action: 'build' });
		const traversal = parse(
			await call({ action: 'impact_cone', file: '../../../outside.ts' }),
		);
		expect(traversal.success).toBe(false);
		expect(traversal.error).toContain('path traversal');
		const ctrl = parse(
			await call({ action: 'impact_cone', file: 'src/bad\u0007.ts' }),
		);
		expect(ctrl.success).toBe(false);
		expect(ctrl.error).toContain('control characters');
	});

	it('keeps unknown targets answer-shaped with a warning', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'impact_cone', file: 'src/ghost.ts' }),
		);
		expect(r.success).toBe(true);
		expect((r.entries as unknown[]).length).toBe(0);
		expect((r.warnings as string[]).join('\n')).toContain(
			'target file not found in graph',
		);
	});

	it('bounds symbol-level entries by top_n (PRR-007: symbol mode, real entries)', async () => {
		await call({ action: 'build' });
		// main.ts's module scope references `add` — symbol mode produces a real
		// caller entry that top_n=1 then must NOT drop (only one exists).
		const r = parse(
			await call({
				action: 'impact_cone',
				file: 'src/util.ts',
				symbol: 'add',
				top_n: 1,
			}),
		);
		expect(r.success).toBe(true);
		const entries = r.entries as Array<Record<string, unknown>>;
		// Two real callers exist in this fixture (main.ts and util.test.ts
		// both reference `add`); top_n=1 keeps one and drops one.
		expect(entries).toHaveLength(1);
		expect(entries[0]?.direction).toBe('caller');
		expect(r.budget).toEqual({ entriesReturned: 1, dropped: 1 });
		expect(r.truncated).toBe(true);
		expect((r.warnings as string[]).join('\n')).toContain('omitted by top_n=1');
	});
});
