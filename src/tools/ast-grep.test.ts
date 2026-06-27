import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { _internals, ast_grep } from './ast-grep';
import type { ToolResult } from './create-tool';

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

async function executeAstGrep(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = await ast_grep.execute(args, {
		directory,
	} as unknown as ToolContext);
	return resultToString(result);
}

let tmpDir: string;
const realResolveAstGrepBinary = _internals.resolveAstGrepBinary;
const realRunExternalTool = _internals.runExternalTool;

beforeEach(() => {
	tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ast-grep-test-')));
	mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
});

afterEach(() => {
	_internals.resolveAstGrepBinary = realResolveAstGrepBinary;
	_internals.runExternalTool = realRunExternalTool;
	rmSync(tmpDir, { recursive: true, force: true });
});

function createTestFile(relativePath: string, content: string): void {
	const fullPath = path.join(tmpDir, relativePath);
	mkdirSync(path.dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

describe('ast_grep', () => {
	test('returns structured missing-binary guidance', async () => {
		_internals.resolveAstGrepBinary = () => null;

		const result = await executeAstGrep({ pattern: 'console.log($A)' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('ast-grep-not-found');
		expect(parsed.message).toContain('Install ast-grep');
	});

	test('uses bounded runner options and safe ast-grep argv', async () => {
		createTestFile('src/app.ts', 'console.log(value)\n');
		const executable = path.join(
			tmpDir,
			process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep',
		);
		let captured: Parameters<typeof realRunExternalTool>[0] | undefined;

		_internals.resolveAstGrepBinary = () => executable;
		_internals.runExternalTool = mock(async (options) => {
			captured = options;
			return {
				status: 'completed',
				exitCode: 0,
				stdout: `${JSON.stringify({
					file: path.join(tmpDir, 'src', 'app.ts'),
					range: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 18 },
					},
					text: 'console.log(value)',
					lines: 'console.log(value)\n',
					language: 'TypeScript',
					metaVariables: { single: { A: { text: 'value' } } },
				})}\n`,
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunExternalTool;

		const result = await executeAstGrep(
			{
				pattern: 'console.log($A)',
				language: 'ts',
				include: 'src/**/*.ts',
				exclude: '**/*.test.ts',
				max_results: 5,
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(captured).toBeDefined();
		expect(captured?.executable).toBe(executable);
		expect(captured?.cwd).toBe(tmpDir);
		expect(captured?.timeoutMs).toBe(10000);
		expect(captured?.args).toEqual([
			'run',
			'--pattern',
			'console.log($A)',
			'--json=stream',
			'--color',
			'never',
			'--lang',
			'ts',
			'--globs',
			'src/**/*.ts',
			'--globs',
			'!**/*.test.ts',
			'.',
		]);
		expect(parsed.matches).toEqual([
			{
				file: 'src/app.ts',
				lineNumber: 1,
				column: 1,
				endLineNumber: 1,
				endColumn: 19,
				text: 'console.log(value)',
				lines: 'console.log(value)',
				language: 'TypeScript',
				metaVariables: { single: { A: { text: 'value' } } },
			},
		]);
		expect(parsed.truncated).toBe(false);
		expect(parsed.total).toBe(1);
	});

	test('rejects invalid patterns and path traversal globs', async () => {
		let result = await executeAstGrep({ pattern: '' }, tmpDir);
		expect(JSON.parse(result).type).toBe('invalid-pattern');

		result = await executeAstGrep(
			{ pattern: '$A', include: '../outside/**' },
			tmpDir,
		);
		expect(JSON.parse(result).type).toBe('path-escape');

		result = await executeAstGrep({ pattern: '$A', language: '../ts' }, tmpDir);
		expect(JSON.parse(result).type).toBe('invalid-pattern');
	});

	test('normalizes malformed and outside-workspace JSON stream entries', async () => {
		createTestFile('src/inside.ts', 'const value = 1\n');
		let outsideDir: string | undefined;
		try {
			outsideDir = realpathSync(
				mkdtempSync(path.join(os.tmpdir(), 'ast-grep-outside-')),
			);
			writeFileSync(path.join(outsideDir, 'outside.ts'), 'const value = 2\n');
			_internals.resolveAstGrepBinary = () => 'ast-grep';
			_internals.runExternalTool = mock(async () => ({
				status: 'completed',
				exitCode: 0,
				stdout: [
					'not json',
					JSON.stringify({
						file: path.join(outsideDir, 'outside.ts'),
						range: {
							start: { line: 0, column: 0 },
							end: { line: 0, column: 1 },
						},
						text: 'const value = 2',
						lines: 'const value = 2\n',
					}),
					JSON.stringify({
						file: path.join(tmpDir, 'src', 'inside.ts'),
						range: {
							start: { line: 0, column: 0 },
							end: { line: 0, column: 5 },
						},
						text: 'const',
						lines: 'const value = 1\n',
					}),
				].join('\n'),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			})) as typeof realRunExternalTool;

			const result = await executeAstGrep({ pattern: 'const $A = $B' }, tmpDir);
			const parsed = JSON.parse(result);

			expect(parsed.matches.map((m: { file: string }) => m.file)).toEqual([
				'src/inside.ts',
			]);
			expect(parsed.total).toBe(1);
		} finally {
			if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
		}
	});
});
