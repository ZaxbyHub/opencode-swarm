import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	canonicalMkdtemp,
	canonicalTmpDir,
} from '../../tests/helpers/tmpdir.js';
import type { ExternalToolRunResult } from '../utils/external-tool-runner';
import {
	_internals,
	checkSemgrepAvailable,
	getRulesDirectory,
	hasBundledRules,
	isSemgrepAvailable,
	resetSemgrepCache,
	runSemgrep,
} from './semgrep';

const realResolveExecutableFromPath = _internals.resolveExecutableFromPath;
const realRunExternalTool = _internals.runExternalTool;

function completedRun(
	overrides: Partial<ExternalToolRunResult> = {},
): ExternalToolRunResult {
	return {
		status: 'completed',
		exitCode: 0,
		stdout: '',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
		...overrides,
	};
}

describe('Semgrep Integration', () => {
	beforeEach(() => {
		resetSemgrepCache();
		_internals.resolveExecutableFromPath = realResolveExecutableFromPath;
		_internals.runExternalTool = realRunExternalTool;
	});

	afterEach(() => {
		resetSemgrepCache();
		_internals.resolveExecutableFromPath = realResolveExecutableFromPath;
		_internals.runExternalTool = realRunExternalTool;
	});

	describe('availability detection', () => {
		it('uses path resolution as the sync compatibility heuristic before async probing', () => {
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';

			expect(isSemgrepAvailable()).toBe(true);
		});

		it('caches the bounded async availability probe result', async () => {
			let calls = 0;
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async () => {
				calls++;
				return completedRun({ stdout: '1.0.0' });
			};

			const first = await checkSemgrepAvailable();
			const second = await checkSemgrepAvailable();

			expect(first).toBe(true);
			expect(second).toBe(true);
			expect(calls).toBe(1);
		});

		it('does not cache a cancelled version probe', async () => {
			let calls = 0;
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async () => {
				calls++;
				return calls === 1
					? {
							status: 'cancelled',
							exitCode: null,
							stdout: '',
							stderr: '',
							stdoutTruncated: false,
							stderrTruncated: false,
						}
					: completedRun({ stdout: '1.0.0' });
			};

			expect(await checkSemgrepAvailable()).toBe(false);
			expect(await checkSemgrepAvailable()).toBe(true);
			expect(calls).toBe(2);
		});
	});

	describe('runSemgrep()', () => {
		it('returns empty findings when no files are provided', async () => {
			const result = await runSemgrep({ files: [] });
			expect(result.findings).toEqual([]);
			expect(result.engine).toBe('tier_a');
		});

		it('returns unavailable when the async Semgrep probe fails', async () => {
			_internals.resolveExecutableFromPath = () => null;

			const result = await runSemgrep({
				files: ['test.ts'],
			});

			expect(result.available).toBe(false);
			expect(result.engine).toBe('tier_a');
			expect(result.error).toContain('not installed');
		});

		it('runs semgrep through the shared external runner with explicit cwd', async () => {
			const cwd = canonicalTmpDir();
			const calls: Array<Parameters<typeof _internals.runExternalTool>[0]> = [];
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async (options) => {
				calls.push(options);
				if (options.args[0] === '--version') {
					return completedRun({ stdout: '1.0.0' });
				}
				return completedRun({
					stdout: JSON.stringify([
						{
							check_id: 'semgrep/rule',
							path: 'src/test.ts',
							start: { line: 3, col: 1 },
							extra: { severity: 'ERROR', message: 'boom' },
						},
					]),
				});
			};

			const result = await runSemgrep({
				files: ['./src/test.ts'],
				cwd,
				useAutoConfig: true,
				lang: 'ts',
			});

			expect(result.available).toBe(true);
			expect(result.engine).toBe('tier_a+tier_b');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]?.rule_id).toBe('semgrep/rule');
			expect(calls).toHaveLength(2);
			expect(calls[0]?.cwd).toBe(cwd);
			expect(calls[1]).toMatchObject({
				executable: '/fake/semgrep',
				cwd,
				timeoutMs: 30000,
				maxStdoutBytes: 10 * 1024 * 1024,
				maxStderrBytes: 10 * 1024 * 1024,
			});
			expect(calls[1]?.args).toEqual([
				'--config=auto',
				'--json',
				'--quiet',
				'--lang=ts',
				'./src/test.ts',
			]);
		});

		it('treats exit code 1 with stdout as findings, not an execution error', async () => {
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async (options) => {
				if (options.args[0] === '--version') {
					return completedRun({ stdout: '1.0.0' });
				}
				return completedRun({
					exitCode: 1,
					stdout: JSON.stringify({
						results: [
							{
								check_id: 'semgrep/finding',
								path: 'src/f.ts',
								start: { line: 9, col: 2 },
								extra: { severity: 'WARNING', message: 'warn' },
							},
						],
					}),
				});
			};

			const result = await runSemgrep({ files: ['src/f.ts'] });

			expect(result.engine).toBe('tier_a+tier_b');
			expect(result.error).toBeUndefined();
			expect(result.findings[0]?.severity).toBe('high');
		});

		it('fails closed when shared-runner output is truncated', async () => {
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async (options) => {
				if (options.args[0] === '--version') {
					return completedRun({ stdout: '1.0.0' });
				}
				return completedRun({
					stdout: '{"results":[',
					stdoutTruncated: true,
				});
			};

			const result = await runSemgrep({ files: ['src/f.ts'] });

			expect(result.engine).toBe('tier_a');
			expect(result.findings).toEqual([]);
			expect(result.error).toContain('truncated');
		});

		it('does not reinterpret spawn-error stdout as a valid findings result', async () => {
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async (options) => {
				if (options.args[0] === '--version') {
					return completedRun({ stdout: '1.0.0' });
				}
				return {
					status: 'spawn-error',
					exitCode: 1,
					stdout: JSON.stringify({ results: [] }),
					stderr: '',
					stdoutTruncated: false,
					stderrTruncated: false,
					message: 'termination could not be confirmed',
				};
			};

			const result = await runSemgrep({ files: ['src/f.ts'] });

			expect(result.engine).toBe('tier_a');
			expect(result.findings).toEqual([]);
			expect(result.error).toContain('termination could not be confirmed');
		});

		it('fails closed when a completed Semgrep process emits malformed JSON', async () => {
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async (options) =>
				options.args[0] === '--version'
					? completedRun({ stdout: '1.0.0' })
					: completedRun({ stdout: '{"results":' });

			const result = await runSemgrep({ files: ['src/f.ts'] });

			expect(result.engine).toBe('tier_a');
			expect(result.findings).toEqual([]);
			expect(result.error).toContain('invalid JSON');
		});

		it('fails closed when completed JSON reports structured scan errors', async () => {
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async (options) =>
				options.args[0] === '--version'
					? completedRun({ stdout: '1.0.0' })
					: completedRun({
							stdout: JSON.stringify({
								results: [],
								errors: [{ type: 'ParseError', message: 'scan incomplete' }],
							}),
						});

			const result = await runSemgrep({ files: ['src/f.ts'] });

			expect(result.engine).toBe('tier_a');
			expect(result.findings).toEqual([]);
			expect(result.error).toBe('Semgrep reported 1 scan error');
		});

		it.each([
			['all malformed', [null, 'corrupt']],
			[
				'NUL-containing path',
				[
					{
						check_id: 'semgrep/nul-path',
						path: 'src/f.ts\0',
						start: { line: 2, col: 1 },
						extra: { severity: 'ERROR', message: 'invalid path' },
					},
				],
			],
			[
				'mixed valid and malformed',
				[
					{
						check_id: 'semgrep/valid',
						path: 'src/f.ts',
						start: { line: 2, col: 1 },
						extra: { severity: 'ERROR', message: 'valid' },
					},
					{ check_id: 'semgrep/corrupt', path: 'src/f.ts' },
				],
			],
		] as const)('fails closed for %s result entries', async (_label, results) => {
			_internals.resolveExecutableFromPath = () => '/fake/semgrep';
			_internals.runExternalTool = async (options) =>
				options.args[0] === '--version'
					? completedRun({ stdout: '1.0.0' })
					: completedRun({ stdout: JSON.stringify({ results }) });

			const result = await runSemgrep({ files: ['src/f.ts'] });

			expect(result.engine).toBe('tier_a');
			expect(result.findings).toEqual([]);
			expect(result.error).toContain('invalid JSON');
		});
	});

	describe('getRulesDirectory()', () => {
		it('returns default rules directory when no project root provided', () => {
			expect(getRulesDirectory()).toBe('.swarm/semgrep-rules');
		});

		it('returns absolute path when project root provided', () => {
			expect(getRulesDirectory('/test/project')).toBe(
				path.resolve('/test/project', '.swarm/semgrep-rules'),
			);
		});
	});

	describe('hasBundledRules()', () => {
		it('returns false for non-existent directory', () => {
			expect(hasBundledRules('/nonexistent/path/that/does/not/exist')).toBe(
				false,
			);
		});

		it('checks bundled rules in project root', () => {
			const tempRoot = canonicalMkdtemp('semgrep-rules-');
			try {
				const rulesDir = path.join(tempRoot, '.swarm', 'semgrep-rules');
				fs.mkdirSync(rulesDir, { recursive: true });
				expect(hasBundledRules(tempRoot)).toBe(true);
			} finally {
				fs.rmSync(tempRoot, { recursive: true, force: true });
			}
		});
	});
});
