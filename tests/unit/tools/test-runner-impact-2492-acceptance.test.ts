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
const originalSpawn = _internals.bunSpawn;
const originalAvailable = _internals.isCommandAvailable;
const originalLoadImpactMap = _internals.loadImpactMap;
const originalAnalyzeImpact = _internals.analyzeImpact;

function execute(args: Record<string, unknown>): Promise<string> {
	return test_runner.execute(args, {
		directory: tempDir,
	} as never) as Promise<string>;
}

function parse(raw: string): Record<string, unknown> {
	return JSON.parse(raw) as Record<string, unknown>;
}

function expectResolution(
	result: Record<string, unknown>,
	resolvedFiles: string[],
	fallbackReason: string | RegExp | null,
	evaluable: boolean,
): void {
	expect(result.resolution).toMatchObject({
		resolvedFiles,
		cap: MAX_SAFE_TEST_FILES,
		evaluable,
	});
	const resolution = result.resolution as Record<string, unknown>;
	if (fallbackReason instanceof RegExp) {
		expect(resolution.fallbackReason).toMatch(fallbackReason);
	} else {
		expect(resolution.fallbackReason).toBe(fallbackReason);
	}
}

function stream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.length > 0) controller.enqueue(bytes);
			controller.close();
		},
	});
}

function installSuccessfulRunner(calls: string[][]): void {
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

function createProject(): void {
	fs.writeFileSync(
		path.join(tempDir, 'package.json'),
		JSON.stringify({ name: 'impact-2492', scripts: { test: 'bun test' } }),
	);
	fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('runner-impact-2492-');
	createProject();
	process.env.SWARM_LANG_BACKEND = 'legacy';
});

afterEach(() => {
	_internals.bunSpawn = originalSpawn;
	_internals.isCommandAvailable = originalAvailable;
	_internals.loadImpactMap = originalLoadImpactMap;
	_internals.analyzeImpact = originalAnalyzeImpact;
	delete process.env.SWARM_LANG_BACKEND;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('issue #2492: multi-source graph and impact scope', () => {
	for (const sourceCount of [2, 5, 6]) {
		test(`graph accepts ${sourceCount} sources and dedupes a shared test`, async () => {
			const sourceFiles: string[] = [];
			for (let index = 0; index < sourceCount; index++) {
				const name = `source-${index}`;
				sourceFiles.push(`src/${name}.ts`);
				fs.writeFileSync(
					path.join(tempDir, 'src', `${name}.ts`),
					`export const value${index} = ${index};\n`,
				);
			}
			fs.writeFileSync(
				path.join(tempDir, 'src', 'source-0.test.ts'),
				sourceFiles
					.map((file) => `import './${path.basename(file, '.ts')}';`)
					.join('\n'),
			);
			const calls: string[][] = [];
			installSuccessfulRunner(calls);

			const result = parse(
				await execute({ scope: 'graph', files: sourceFiles }),
			);
			expect(result.success).toBe(true);
			expect(calls).toHaveLength(1);
			expect(calls[0].filter((arg) => arg.endsWith('.test.ts'))).toEqual([
				'src/source-0.test.ts',
			]);
			expectResolution(result, ['src/source-0.test.ts'], null, true);
		});

		test(`impact accepts ${sourceCount} sources and dedupes resolved tests`, async () => {
			const sourceFiles: string[] = [];
			const impactMap: Record<string, string[]> = {};
			const sharedTest = 'src/shared.test.ts';
			for (let index = 0; index < sourceCount; index++) {
				const name = `source-${index}`;
				const source = path.join(tempDir, 'src', `${name}.ts`);
				sourceFiles.push(`src/${name}.ts`);
				fs.writeFileSync(source, `export const value${index} = ${index};\n`);
				impactMap[source.replace(/\\/g, '/')] = [
					sharedTest,
					`src/unique-${index}.test.ts`,
				];
			}
			const calls: string[][] = [];
			installSuccessfulRunner(calls);
			_internals.loadImpactMap = async () => impactMap;

			const result = parse(
				await execute({ scope: 'impact', files: sourceFiles }),
			);
			expect(result.success).toBe(true);
			expect(calls).toHaveLength(1);
			const testArgs = calls[0].filter((arg) => arg.endsWith('.test.ts'));
			expect(new Set(testArgs).size).toBe(sourceCount + 1);
			expect(testArgs.filter((arg) => arg === sharedTest)).toHaveLength(1);
			expectResolution(
				result,
				[
					sharedTest,
					...Array.from(
						{ length: sourceCount },
						(_, index) => `src/unique-${index}.test.ts`,
					),
				],
				null,
				true,
			);
		});
	}

	for (const cacheState of ['missing', 'corrupt'] as const) {
		test(`impact reports ${cacheState} cache status and resolved selection`, async () => {
			const source = 'src/source.ts';
			fs.writeFileSync(path.join(tempDir, source), 'export const value = 1;\n');
			fs.writeFileSync(
				path.join(tempDir, 'src', 'source.test.ts'),
				"import './source';\n",
			);
			if (cacheState === 'corrupt') {
				fs.mkdirSync(path.join(tempDir, '.swarm', 'cache'), {
					recursive: true,
				});
				fs.writeFileSync(
					path.join(tempDir, '.swarm', 'cache', 'impact-map.json'),
					'{not-json',
				);
			}
			const calls: string[][] = [];
			installSuccessfulRunner(calls);

			const result = parse(await execute({ scope: 'impact', files: [source] }));
			expect(result.success).toBe(true);
			expect(result.outcome).toBe('pass');
			expect(result.scope).toBe('impact');
			expect(calls[0].filter((arg) => arg.endsWith('.test.ts'))).toEqual([
				'src/source.test.ts',
			]);
			expectResolution(result, ['src/source.test.ts'], /rebuild/i, true);
			expect(result.resolution).toMatchObject({
				cacheStatus: `rebuilt_${cacheState}`,
			});
		});
	}

	test('more than MAX_SAFE_TEST_FILES source inputs is a typed pre-traversal scope skip', async () => {
		const sourceFiles = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 1 },
			(_, index) => {
				const relative = `src/source-${index}.ts`;
				fs.writeFileSync(
					path.join(tempDir, relative),
					'export const value = 1;\n',
				);
				return relative;
			},
		);
		const calls: string[][] = [];
		installSuccessfulRunner(calls);

		for (const scope of ['graph', 'impact'] as const) {
			const result = parse(await execute({ scope, files: sourceFiles }));
			expect(result.success).toBe(false);
			expect(result.outcome).toBe('scope_exceeded');
			expect(`${result.error} ${result.message ?? ''}`).toContain(
				String(MAX_SAFE_TEST_FILES),
			);
		}
		expect(calls).toHaveLength(0);
	});

	test('more than fifty resolved tests is a typed scope_exceeded skip', async () => {
		const source = 'src/source.ts';
		const sourcePath = path.join(tempDir, source);
		fs.writeFileSync(sourcePath, 'export const value = 1;\n');
		const impactMap = {
			[sourcePath.replace(/\\/g, '/')]: Array.from(
				{ length: MAX_SAFE_TEST_FILES + 1 },
				(_, index) => `tests/test-${index}.test.ts`,
			),
		};
		const calls: string[][] = [];
		installSuccessfulRunner(calls);
		_internals.loadImpactMap = async () => impactMap;

		const result = parse(await execute({ scope: 'impact', files: [source] }));
		expect(result.success).toBe(false);
		expect(result.outcome).toBe('scope_exceeded');
		expect(`${result.error} ${result.message ?? ''}`).toContain(
			String(MAX_SAFE_TEST_FILES),
		);
		expect(calls).toHaveLength(0);
	});
});
