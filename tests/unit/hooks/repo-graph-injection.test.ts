import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildCoderLocalizationBlock,
	buildReviewerBlastRadiusBlock,
	getCachedGraph,
	resetGraphInjectionCache,
} from '../../../src/hooks/repo-graph-injection';
import {
	buildWorkspaceGraphAsync,
	saveGraph,
} from '../../../src/tools/repo-graph';

let tmp: string;

beforeEach(() => {
	resetGraphInjectionCache();
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rgi-'));
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		'export function add(a: number, b: number) { return a + b; }\n',
	);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nconsole.log(add(1, 2));\n",
	);
	fs.writeFileSync(
		path.join(tmp, 'src/other.ts'),
		"import { add } from './util';\nexport const r = add(3, 4);\n",
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function buildAndSaveStartupGraph(): Promise<void> {
	const graph = await buildWorkspaceGraphAsync(tmp);
	await saveGraph(tmp, graph);
}

describe('graph injection — silent fallback when no graph exists', () => {
	it('returns null for coder block', () => {
		expect(buildCoderLocalizationBlock(tmp, 'src/util.ts')).toBeNull();
	});

	it('returns null for reviewer block', () => {
		expect(buildReviewerBlastRadiusBlock(tmp, ['src/util.ts'])).toBeNull();
	});

	it('returns null when getCachedGraph called pre-build', () => {
		expect(getCachedGraph(tmp)).toBeNull();
	});

	it('regression RGI-001: corrupt graph files fail open instead of throwing', () => {
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmp, '.swarm', 'repo-graph.json'), '{ nope');

		// Previous code let loadGraphSync corruption errors escape into prompt
		// construction, violating this hook's documented silent-fallback contract.
		expect(() => getCachedGraph(tmp)).not.toThrow();
		expect(getCachedGraph(tmp)).toBeNull();
		expect(buildCoderLocalizationBlock(tmp, 'src/util.ts')).toBeNull();
		expect(buildReviewerBlastRadiusBlock(tmp, ['src/util.ts'])).toBeNull();
	});
});

describe('graph injection — after build', () => {
	beforeEach(async () => {
		await buildAndSaveStartupGraph();
	});

	it('coder block contains the localization summary', () => {
		const block = buildCoderLocalizationBlock(tmp, 'src/util.ts');
		expect(block).not.toBeNull();
		expect(block).toContain('REPO GRAPH');
		expect(block).toContain('LOCALIZATION');
		expect(block).toContain('src/util.ts');
		// Two importers (main.ts + other.ts) should be reflected.
		expect(block).toContain('Imported by (2)');
	});

	it('coder block returns null for files not in the graph', () => {
		const block = buildCoderLocalizationBlock(tmp, 'src/missing.ts');
		expect(block).toBeNull();
	});

	it('coder block returns null for empty target', () => {
		expect(buildCoderLocalizationBlock(tmp, '')).toBeNull();
	});

	it('coder block normalizes backslashes and ./ prefixes', () => {
		const a = buildCoderLocalizationBlock(tmp, 'src/util.ts');
		const b = buildCoderLocalizationBlock(tmp, './src/util.ts');
		const c = buildCoderLocalizationBlock(tmp, 'src\\util.ts');
		expect(a).not.toBeNull();
		expect(b).toBe(a as string);
		expect(c).toBe(a as string);
	});

	it('reviewer block lists direct dependents and risk', () => {
		const block = buildReviewerBlastRadiusBlock(tmp, ['src/util.ts']);
		expect(block).not.toBeNull();
		expect(block).toContain('BLAST RADIUS');
		expect(block).toContain('src/util.ts');
		expect(block).toContain('Direct dependents');
		expect(block).toContain('main.ts');
		expect(block).toContain('Risk:');
	});

	it('reviewer block returns null when no changed files match the graph', () => {
		const block = buildReviewerBlastRadiusBlock(tmp, ['does/not/exist.ts']);
		expect(block).toBeNull();
	});

	it('reviewer block returns null on empty input', () => {
		expect(buildReviewerBlastRadiusBlock(tmp, [])).toBeNull();
	});
});

describe('cache invalidation', () => {
	it('reloads the graph when the file mtime changes', async () => {
		await buildAndSaveStartupGraph();
		const block1 = buildCoderLocalizationBlock(tmp, 'src/util.ts');
		expect(block1).not.toBeNull();

		// Add a new importer, then rebuild the graph (this updates the file mtime).
		fs.writeFileSync(
			path.join(tmp, 'src/third.ts'),
			"import { add } from './util';\nconsole.log(add(5, 6));\n",
		);
		// Force the on-disk mtime forward by at least 10ms — some filesystems
		// (and bun's stat) use millisecond resolution, so a back-to-back
		// rebuild can land on the same mtimeMs and skip cache invalidation.
		await new Promise((r) => setTimeout(r, 20));
		await buildAndSaveStartupGraph();

		const block2 = buildCoderLocalizationBlock(tmp, 'src/util.ts');
		expect(block2).not.toBeNull();
		expect(block2).toContain('Imported by (3)');
	});
});
