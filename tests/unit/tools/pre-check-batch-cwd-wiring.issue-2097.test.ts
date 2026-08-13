import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('pre-check workspace wiring hardening (#2097)', () => {
	const originalPlatform = _internals.platform;

	afterEach(() => {
		_internals.platform = originalPlatform;
	});

	it('rejects a Windows case-variant project subdirectory', async () => {
		_internals.platform = () => 'win32';
		const result = await runPreCheckBatch(
			{ files: ['test.ts'], directory: 'c:\\repo\\sub' },
			'C:\\Repo',
		);

		expect(result.batch_status).toBe('invalid');
		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('project root');
	});
});

describe('pre-check lint workspace wiring (#2097)', () => {
	let tempDir: string;
	let differentDir: string;
	let originalCwd: string;
	let originalDetectResolvedLinter: typeof _internals.detectResolvedLinter;
	let originalRunLintOnFiles: typeof _internals.runLintOnFiles;
	let originalGetChangedLineRanges: typeof _internals.getChangedLineRanges;
	let detectedDirectories: string[];
	let lintDirectories: string[];

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = canonicalMkdtemp('pre-check-wiring-');
		differentDir = canonicalMkdtemp('pre-check-host-cwd-');
		process.chdir(differentDir);
		originalDetectResolvedLinter = _internals.detectResolvedLinter;
		originalRunLintOnFiles = _internals.runLintOnFiles;
		originalGetChangedLineRanges = _internals.getChangedLineRanges;
		detectedDirectories = [];
		lintDirectories = [];
		_internals.detectResolvedLinter = async (directory) => {
			detectedDirectories.push(directory ?? '');
			return {
				linter: 'biome',
				executable: process.execPath,
				argsPrefix: [],
				displayPrefix: [process.execPath],
				source: 'legacy-test-probe',
			};
		};
		_internals.runLintOnFiles = async (_resolved, _files, directory) => {
			lintDirectories.push(directory);
			return {
				success: true,
				mode: 'check',
				linter: 'biome',
				command: [process.execPath],
				exitCode: 0,
				output: '',
			};
		};
		_internals.getChangedLineRanges = async () => new Map([['test.ts', [-1]]]);
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');
	});

	afterEach(() => {
		_internals.detectResolvedLinter = originalDetectResolvedLinter;
		_internals.runLintOnFiles = originalRunLintOnFiles;
		_internals.getChangedLineRanges = originalGetChangedLineRanges;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
		fs.rmSync(differentDir, { recursive: true, force: true });
	});

	it('passes the project root to linter resolution', async () => {
		await runPreCheckBatch({ files: ['test.ts'], directory: tempDir }, tempDir);

		expect(detectedDirectories.length).toBeGreaterThan(0);
		for (const cwd of detectedDirectories) {
			expect(cwd).toBe(tempDir);
			expect(cwd).not.toBe(differentDir);
		}
	});

	it('passes the project root to resolved lint execution', async () => {
		await runPreCheckBatch({ files: ['test.ts'], directory: tempDir }, tempDir);

		expect(lintDirectories.length).toBeGreaterThan(0);
		for (const cwd of lintDirectories) {
			expect(cwd).toBe(tempDir);
			expect(cwd).not.toBe(differentDir);
		}
	});
});
