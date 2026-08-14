import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';

let tmp: string;

function call(args: Record<string, unknown>): Promise<string> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable).execute(args, { directory: tmp });
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-ask-'));
	const src = path.join(tmp, 'src');
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(
		path.join(src, 'util.ts'),
		[
			'export function add(a: number, b: number) { return a + b; }',
			"import { helper } from './helper';",
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(src, 'helper.ts'),
		'export function helper() { return 1; }',
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map: ask', () => {
	it('requires question', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'ask' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('requires `question`');
	});

	it('rejects control-char question', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'ask', question: 'hello\x00world' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('control characters');
	});

	it('returns hits after build', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'ask', question: 'add util' });
		const r = JSON.parse(out) as {
			success: boolean;
			hits: Array<{ file: string; score: number }>;
			budget: { requested: number; returned: number; dropped: number };
		};
		expect(r.success).toBe(true);
		expect(r.hits.length).toBeGreaterThan(0);
		expect(r.budget.returned).toBeGreaterThan(0);
	});

	it('rejects whitespace-only question', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'ask', question: '   \t  ' });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('question is empty');
	});

	it('rejects question exceeding max length', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'ask', question: 'x'.repeat(501) });
		const r = JSON.parse(out) as { success: boolean; error: string };
		expect(r.success).toBe(false);
		expect(r.error).toContain('exceeds maximum length');
	});

	it('accepts question at exactly the max length boundary', async () => {
		await call({ action: 'build' });
		const out = await call({ action: 'ask', question: 'x'.repeat(500) });
		const r = JSON.parse(out) as { success: boolean };
		expect(r.success).toBe(true);
	});
});
