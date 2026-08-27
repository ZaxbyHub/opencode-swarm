import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { z } from 'zod';

import { _internals, repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

type Executable = {
	execute: (
		args: Record<string, unknown>,
		ctx: { directory: string },
	) => Promise<string>;
};

let tmp: string;

async function call(
	args: Record<string, unknown>,
): Promise<Record<string, any>> {
	const raw = await (repo_map as unknown as Executable).execute(args, {
		directory: tmp,
	});
	return JSON.parse(raw) as Record<string, any>;
}

const originalLoadConfig = _internals.loadPluginConfigWithMeta;

const UTIL =
	'export function add(a: number, b: number) {\n  return a + b;\n}\n';
const helper = (name: string) =>
	`import { add } from './util';\n\nexport function ${name}() {\n  return add(1, 2);\n}\n`;

beforeEach(() => {
	tmp = canonicalMkdtemp('repo-map-cp-args-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(path.join(tmp, 'src/util.ts'), UTIL);
	// Three distinct callers of add at BFS depth 1.
	fs.writeFileSync(path.join(tmp, 'src/h1.ts'), helper('h1'));
	fs.writeFileSync(path.join(tmp, 'src/h2.ts'), helper('h2'));
	fs.writeFileSync(path.join(tmp, 'src/h3.ts'), helper('h3'));
});

afterEach(() => {
	_internals.loadPluginConfigWithMeta = originalLoadConfig;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}): void {
	_internals.loadPluginConfigWithMeta = (() => ({
		config: { repo_graph: overrides },
		recovery: 'none',
		removedKeys: [],
		warnings: [],
		loadedFromFile: false,
		configHadErrors: false,
	})) as typeof _internals.loadPluginConfigWithMeta;
}

describe('repo_map context_pack KG-12 args (issue #1533)', () => {
	test('zod schema bounds: max_tokens 1..100000 int, source_mode enum', () => {
		const args = repo_map.args as unknown as Record<string, z.ZodTypeAny>;
		const maxTokens = args.max_tokens!;
		expect(maxTokens.safeParse(1).success).toBe(true);
		expect(maxTokens.safeParse(4000).success).toBe(true);
		expect(maxTokens.safeParse(100000).success).toBe(true);
		expect(maxTokens.safeParse(0).success).toBe(false);
		expect(maxTokens.safeParse(100001).success).toBe(false);
		expect(maxTokens.safeParse(2.5).success).toBe(false);
		expect(maxTokens.safeParse('4000').success).toBe(false);
		expect(maxTokens.safeParse(undefined).success).toBe(true);
		const sourceMode = args.source_mode!;
		expect(sourceMode.safeParse('signature').success).toBe(true);
		expect(sourceMode.safeParse('body').success).toBe(true);
		expect(sourceMode.safeParse('mixed').success).toBe(true);
		expect(sourceMode.safeParse('full').success).toBe(false);
		expect(sourceMode.safeParse(undefined).success).toBe(true);
	});

	test('max_tokens is honored: tiny budget keeps only the target span', async () => {
		await call({ action: 'build' });
		const r = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
			max_tokens: 50,
		});
		expect(r.success).toBe(true);
		expect(r.truncated).toBe(true);
		expect(r.spans).toHaveLength(1);
		expect(r.spans[0].symbol).toBe('add');
		expect(r.coverage.returnedSymbols).toBe(1);
		expect(r.coverage.omittedByBudget).toBe(r.coverage.reachedSymbols - 1);
		expect(
			r.warnings.some((w: string) => w.includes('omitted by token budget')),
		).toBe(true);
	});

	test('include_source + source_mode=signature returns snippets end-to-end', async () => {
		await call({ action: 'build' });
		const r = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
			include_source: true,
			source_mode: 'signature',
		});
		expect(r.success).toBe(true);
		expect(r.sourceIncluded).toBe(true);
		const sn = r.snippets.find(
			(s: Record<string, unknown>) => s.symbol === 'add',
		);
		expect(sn).toBeDefined();
		expect(sn.file).toBe('src/util.ts'); // workspace-relative + normalized
		expect(sn.mode).toBe('signature');
		expect(sn.text).toBe('export function add(a: number, b: number) {');
		expect(sn.confidence).toBe(1.0);
		expect(sn.hash).toBe(createHash('sha256').update(sn.text).digest('hex'));
		expect(typeof sn.startLine).toBe('number');
		expect(typeof sn.endLine).toBe('number');
		expect(r.coverage.reachedSymbols).toBeGreaterThan(0);
		expect(Array.isArray(r.warnings)).toBe(true);
	});

	test('span-only compat: no snippets, no span text, coverage + warnings present', async () => {
		await call({ action: 'build' });
		const r = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
		});
		expect(r.success).toBe(true);
		expect('snippets' in r).toBe(false);
		expect('sourceIncluded' in r).toBe(false);
		for (const span of r.spans) {
			expect(span.text).toBeUndefined();
		}
		expect(r.coverage).toBeDefined();
		expect(Array.isArray(r.warnings)).toBe(true);
	});

	test('top_n slice is reflected in coverage', async () => {
		await call({ action: 'build' });
		const r = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
			top_n: 1,
		});
		expect(r.spans).toHaveLength(1);
		expect(r.spans[0].symbol).toBe('add');
		expect(r.coverage.returnedSymbols).toBe(1);
		expect(r.coverage.omittedByBudget).toBe(r.coverage.reachedSymbols - 1);
		expect(r.budget.dropped).toBe(r.coverage.reachedSymbols - 1);
	});

	test('top_n also bounds snippets: one snippet per returned span', async () => {
		await call({ action: 'build' });
		const r = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
			top_n: 1,
			include_source: true,
			source_mode: 'signature',
		});
		expect(r.spans).toHaveLength(1);
		expect(r.snippets).toHaveLength(1);
		expect(r.snippets[0].symbol).toBe(r.spans[0].symbol);
		expect(r.snippets[0].file).toBe(r.spans[0].file);
		expect(r.coverage.returnedSymbols).toBe(r.spans.length);
	});

	test('source_mode without include_source produces an explicit warning', async () => {
		await call({ action: 'build' });
		const r = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
			source_mode: 'body',
		});
		expect(r.success).toBe(true);
		expect(
			r.warnings.includes('source_mode ignored: include_source is not true'),
		).toBe(true);
		expect('snippets' in r).toBe(false);
	});

	test('stale-graph freshness note is merged into warnings', async () => {
		config({ refresh_cap: 0 });
		await call({ action: 'build' });
		// Drift a source file after the build so the freshness probe reports
		// drift while refresh_cap=0 keeps the stale graph immutable.
		fs.appendFileSync(
			path.join(tmp, 'src/util.ts'),
			'// drifted after build\n',
		);
		const r = await call({
			action: 'context_pack',
			file: 'src/util.ts',
			symbol: 'add',
		});
		expect(r.success).toBe(true);
		expect(r.stale).toBe(true);
		expect(r.warnings.some((w: string) => w.includes('refresh_cap=0'))).toBe(
			true,
		);
	});
});
