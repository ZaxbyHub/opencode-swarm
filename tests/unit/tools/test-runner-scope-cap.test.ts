import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	MAX_SAFE_TEST_FILES,
	test_runner,
} from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;
const originalLoadImpactMap = _internals.loadImpactMap;
const originalAvailable = _internals.isCommandAvailable;
const originalSpawn = _internals.bunSpawn;

function stream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(controller) {
			if (bytes.length > 0) controller.enqueue(bytes);
			controller.close();
		},
	});
}

function installRunner(calls: string[][]): void {
	_internals.isCommandAvailable = (() =>
		true) as typeof _internals.isCommandAvailable;
	_internals.bunSpawn = ((command: string[]) => {
		calls.push(command);
		return {
			stdout: stream('1 pass'),
			stderr: stream(''),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => {},
			killTree: async () => {},
		};
	}) as typeof _internals.bunSpawn;
}

function execute(
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return test_runner
		.execute(args, { directory: tempDir } as never)
		.then((raw) => JSON.parse(raw as string) as Record<string, unknown>);
}

type ResolutionExpectation = {
	requestedScope: string;
	effectiveScope: string;
	sourceFiles: string[];
	resolvedFiles: string[];
	decision: string;
	evaluable: boolean;
	estimateCount?: number;
	estimateStatus?: string;
	fallbackReason?: string | null;
	cacheStatus?: string;
};

function expectResolutionEnvelope(
	result: Record<string, unknown>,
	expected: ResolutionExpectation,
): void {
	const resolution = result.resolution as Record<string, unknown>;
	const estimateCount = expected.estimateCount ?? 0;
	const estimateStatus = expected.estimateStatus ?? 'not_run';
	expect(resolution).toMatchObject({
		requestedScope: expected.requestedScope,
		effectiveScope: expected.effectiveScope,
		sourceFiles: expected.sourceFiles,
		resolvedFiles: expected.resolvedFiles,
		cap: MAX_SAFE_TEST_FILES,
		decision: expected.decision,
		estimate: { count: estimateCount, status: estimateStatus },
		estimateCount,
		estimateStatus,
		fallbackReason: expected.fallbackReason ?? null,
		evaluable: expected.evaluable,
	});
	const estimate = resolution.estimate as {
		count: number;
		status: string;
	};
	expect(estimate.count).toBe(resolution.estimateCount);
	expect(estimate.status).toBe(resolution.estimateStatus);
	if (expected.cacheStatus !== undefined) {
		expect(resolution.cacheStatus).toBe(expected.cacheStatus);
	}
}

function writeProject(): void {
	fs.writeFileSync(
		path.join(tempDir, 'package.json'),
		JSON.stringify({ name: 'scope-cap-2492', scripts: { test: 'bun test' } }),
	);
	fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('scope-cap-2492-');
	writeProject();
	process.env.SWARM_LANG_BACKEND = 'legacy';
});

afterEach(() => {
	_internals.loadImpactMap = originalLoadImpactMap;
	_internals.isCommandAvailable = originalAvailable;
	_internals.bunSpawn = originalSpawn;
	delete process.env.SWARM_LANG_BACKEND;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('test-runner safe resolution cap', () => {
	test('exactly MAX_SAFE_TEST_FILES normalized source inputs remain eligible', async () => {
		const sources = Array.from({ length: MAX_SAFE_TEST_FILES }, (_, index) => {
			const file = `src/source-${index}.ts`;
			fs.writeFileSync(
				path.join(tempDir, file),
				`export const value${index} = ${index};\n`,
			);
			return file;
		});
		fs.writeFileSync(
			path.join(tempDir, 'src/source-0.test.ts'),
			sources
				.map((file) => `import './${path.basename(file, '.ts')}';`)
				.join('\n'),
		);
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope: 'graph', files: sources });

		expect(result.success).toBe(true);
		expect(calls).toHaveLength(1);
		expectResolutionEnvelope(result, {
			requestedScope: 'graph',
			effectiveScope: 'graph',
			sourceFiles: sources,
			resolvedFiles: ['src/source-0.test.ts'],
			decision: 'execute',
			evaluable: true,
			estimateStatus: 'advisory',
			cacheStatus: 'missing_unverified',
		});
	});

	test('more than MAX_SAFE_TEST_FILES inputs fail before discovery or spawn', async () => {
		const sources = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 1 },
			(_, index) => `src/source-${index}.ts`,
		);
		for (const source of sources) {
			fs.writeFileSync(path.join(tempDir, source), 'export const value = 1;\n');
		}
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope: 'impact', files: sources });

		expect(result.success).toBe(false);
		expect(result.outcome).toBe('scope_exceeded');
		expectResolutionEnvelope(result, {
			requestedScope: 'impact',
			effectiveScope: 'impact',
			sourceFiles: sources,
			resolvedFiles: [],
			decision: 'scope_exceeded',
			evaluable: false,
		});
		expect(calls).toHaveLength(0);
	});

	test.each([
		'graph',
		'impact',
	] as const)('%s source overflow keeps a bounded 51-entry diagnostic envelope', async (scope) => {
		const sources = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 10 },
			(_, index) => `src/overflow-${index}.ts`,
		);
		for (const source of sources) {
			fs.writeFileSync(path.join(tempDir, source), 'export const value = 1;\n');
		}
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope, files: sources });

		expect(result.success).toBe(false);
		expect(result.outcome).toBe('scope_exceeded');
		expectResolutionEnvelope(result, {
			requestedScope: scope,
			effectiveScope: scope,
			sourceFiles: sources.slice(0, MAX_SAFE_TEST_FILES + 1),
			resolvedFiles: [],
			decision: 'scope_exceeded',
			evaluable: false,
		});
		expect(
			(result.resolution as { sourceFiles: string[] }).sourceFiles,
		).toHaveLength(MAX_SAFE_TEST_FILES + 1);
		expect(calls).toHaveLength(0);
	});

	test('convention source overflow includes bounded resolution evidence', async () => {
		const sources = ['src/source-a.ts', 'src/source-b.ts'];
		for (const source of sources) {
			fs.writeFileSync(path.join(tempDir, source), 'export const value = 1;\n');
		}
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope: 'convention', files: sources });

		expect(result.success).toBe(false);
		expect(result.scope).toBe('convention');
		expect(result.outcome).toBe('scope_exceeded');
		expectResolutionEnvelope(result, {
			requestedScope: 'convention',
			effectiveScope: 'convention',
			sourceFiles: sources,
			resolvedFiles: [],
			decision: 'scope_exceeded',
			evaluable: false,
		});
		expect(calls).toHaveLength(0);
	});

	test('convention direct-file overflow is capped before spawn', async () => {
		const directFiles = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 1 },
			(_, index) => `tests/direct-${index}.test.ts`,
		);
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({
			scope: 'convention',
			files: directFiles,
		});

		expect(result.success).toBe(false);
		expect(result.outcome).toBe('scope_exceeded');
		expectResolutionEnvelope(result, {
			requestedScope: 'convention',
			effectiveScope: 'convention',
			sourceFiles: directFiles,
			resolvedFiles: directFiles,
			decision: 'scope_exceeded',
			evaluable: false,
		});
		expect(calls).toHaveLength(0);
	});

	test('convention execution attaches the full resolution envelope', async () => {
		const source = 'src/source.ts';
		const testFile = 'src/source.test.ts';
		fs.writeFileSync(path.join(tempDir, source), 'export const value = 1;\n');
		fs.writeFileSync(path.join(tempDir, testFile), "import './source';\n");
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope: 'convention', files: [source] });

		expect(result.success).toBe(true);
		expectResolutionEnvelope(result, {
			requestedScope: 'convention',
			effectiveScope: 'convention',
			sourceFiles: [source],
			resolvedFiles: [testFile],
			decision: 'execute',
			evaluable: true,
		});
		expect(calls).toHaveLength(1);
	});

	test('graph resolved overflow preserves cap+1 sentinel evidence', async () => {
		const sources = Array.from({ length: MAX_SAFE_TEST_FILES }, (_, index) => {
			const source = `src/source-${index}.ts`;
			fs.writeFileSync(
				path.join(tempDir, source),
				`export const value${index} = ${index};\n`,
			);
			for (const suffix of ['spec', 'test']) {
				fs.writeFileSync(
					path.join(tempDir, `src/source-${index}.${suffix}.ts`),
					`import './source-${index}';\n`,
				);
			}
			return source;
		});
		const expectedFiles = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 1 },
			(_, index) =>
				`src/source-${Math.floor(index / 2)}.${index % 2 === 0 ? 'spec' : 'test'}.ts`,
		);
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope: 'graph', files: sources });

		expect(result.success).toBe(false);
		expect(result.outcome).toBe('scope_exceeded');
		expectResolutionEnvelope(result, {
			requestedScope: 'graph',
			effectiveScope: 'graph',
			sourceFiles: sources,
			resolvedFiles: expectedFiles,
			decision: 'scope_exceeded',
			evaluable: false,
			estimateStatus: 'advisory',
			cacheStatus: 'missing_unverified',
		});
		expect(calls).toHaveLength(0);
	});

	test('a stale-high advisory estimate does not reject a safe graph resolution', async () => {
		const source = 'src/source.ts';
		fs.writeFileSync(path.join(tempDir, source), 'export const value = 1;\n');
		fs.writeFileSync(
			path.join(tempDir, 'src/source.test.ts'),
			"import './source';\n",
		);
		const highEstimate = {
			[path.join(tempDir, source).replace(/\\/g, '/')]: Array.from(
				{ length: MAX_SAFE_TEST_FILES + 10 },
				(_, index) => `tests/test-${index}.test.ts`,
			),
		};
		_internals.loadImpactMap = async () => highEstimate;
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope: 'graph', files: [source] });

		expect(result.success).toBe(true);
		expectResolutionEnvelope(result, {
			requestedScope: 'graph',
			effectiveScope: 'graph',
			sourceFiles: [source],
			resolvedFiles: ['src/source.test.ts'],
			decision: 'execute',
			evaluable: true,
			estimateCount: MAX_SAFE_TEST_FILES + 10,
			estimateStatus: 'advisory',
		});
		expect(calls).toHaveLength(1);
	});

	test('resolved overflow is typed with a bounded cap+1 sentinel', async () => {
		const source = 'src/source.ts';
		const sourcePath = path.join(tempDir, source).replace(/\\/g, '/');
		fs.writeFileSync(path.join(tempDir, source), 'export const value = 1;\n');
		const impactMap = {
			[sourcePath]: Array.from(
				{ length: MAX_SAFE_TEST_FILES + 1 },
				(_, index) => `tests/test-${index}.test.ts`,
			),
		};
		_internals.loadImpactMap = async () => impactMap;
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope: 'impact', files: [source] });

		expect(result.outcome).toBe('scope_exceeded');
		expectResolutionEnvelope(result, {
			requestedScope: 'impact',
			effectiveScope: 'impact',
			sourceFiles: [source],
			resolvedFiles: Array.from(
				{ length: MAX_SAFE_TEST_FILES + 1 },
				(_, index) => `tests/test-${index}.test.ts`,
			),
			decision: 'scope_exceeded',
			evaluable: false,
			estimateCount: MAX_SAFE_TEST_FILES + 1,
			estimateStatus: 'advisory',
			cacheStatus: 'missing',
		});
		expect(
			(result.resolution as { resolvedFiles: string[] }).resolvedFiles[
				MAX_SAFE_TEST_FILES
			],
		).toBe(`tests/test-${MAX_SAFE_TEST_FILES}.test.ts`);
		expect(calls).toHaveLength(0);
	});

	test('stale v2 cache is rebuilt and surfaced in impact resolution evidence', async () => {
		const source = 'src/source.ts';
		fs.writeFileSync(path.join(tempDir, source), 'export const value = 1;\n');
		const testFile = path.join(tempDir, 'src/source.test.ts');
		fs.writeFileSync(testFile, "import './source';\n");
		await originalLoadImpactMap(tempDir);
		fs.writeFileSync(testFile, "import './source';\n// changed\n");
		const calls: string[][] = [];
		installRunner(calls);

		const result = await execute({ scope: 'impact', files: [source] });

		expect(result.success).toBe(true);
		expectResolutionEnvelope(result, {
			requestedScope: 'impact',
			effectiveScope: 'impact',
			sourceFiles: [source],
			resolvedFiles: ['src/source.test.ts'],
			decision: 'execute',
			evaluable: true,
			estimateCount: 1,
			estimateStatus: 'advisory',
			cacheStatus: 'rebuilt_stale',
			fallbackReason:
				'impact cache rebuild completed (rebuilt_stale) before resolution',
		});
		expect(calls).toHaveLength(1);
	});
});
