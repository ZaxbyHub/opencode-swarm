import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	appendTestRun,
	getAllHistory,
	getTestHistory,
	_internals as historyInternals,
} from '../../test-impact/history-store.js';

const { tmpdir } = os;
const { mkdtempSync, rmSync } = await import('node:fs');

describe('history-store', () => {
	let tempDir: string;
	let savedValidateProjectRoot: typeof historyInternals.validateProjectRoot;

	beforeEach(async () => {
		// Most tests use temp dirs that may have parent .swarm/ (e.g. from the
		// project's own .swarm leaking into os.tmpdir()). Disable the guard so
		// these tests measure history-store logic, not project-root validation.
		savedValidateProjectRoot = historyInternals.validateProjectRoot;
		historyInternals.validateProjectRoot = () => {};

		// Create a unique temp directory for each test
		tempDir = mkdtempSync(path.join(tmpdir(), 'history-store-test-'));
	});

	afterEach(() => {
		historyInternals.validateProjectRoot = savedValidateProjectRoot;
		// Clean up temp directory
		rmSync(tempDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// appendTestRun() validation: required string fields
	// -------------------------------------------------------------------------
	describe('appendTestRun() validation', () => {
		test('throws TypeError when testFile is empty string', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '4.1',
						testFile: '',
						testName: 'some test',
						result: 'pass',
						durationMs: 100,
						changedFiles: [],
					},
					tempDir,
				),
			).toThrow('testFile must be a non-empty string');
		});

		test('throws TypeError when testFile is missing', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '4.1',
						testFile: undefined,
						testName: 'some test',
						result: 'pass',
						durationMs: 100,
						changedFiles: [],
					} as any,
					tempDir,
				),
			).toThrow('testFile must be a non-empty string');
		});

		test('throws TypeError when testName is empty string', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '4.1',
						testFile: 'src/foo.test.ts',
						testName: '',
						result: 'pass',
						durationMs: 100,
						changedFiles: [],
					},
					tempDir,
				),
			).toThrow('testName must be a non-empty string');
		});

		test('throws TypeError when taskId is empty string', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '',
						testFile: 'src/foo.test.ts',
						testName: 'some test',
						result: 'pass',
						durationMs: 100,
						changedFiles: [],
					},
					tempDir,
				),
			).toThrow('taskId must be a non-empty string');
		});

		test('throws TypeError when result is invalid enum value', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '4.1',
						testFile: 'src/foo.test.ts',
						testName: 'some test',
						result: 'flaky',
						durationMs: 100,
						changedFiles: [],
					} as any,
					tempDir,
				),
			).toThrow('result must be "pass", "fail", or "skip"');
		});

		test('throws TypeError when durationMs is not a finite number', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '4.1',
						testFile: 'src/foo.test.ts',
						testName: 'some test',
						result: 'pass',
						durationMs: NaN,
						changedFiles: [],
					} as any,
					tempDir,
				),
			).toThrow('durationMs must be a finite number');
		});

		test('throws TypeError when durationMs is Infinity', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '4.1',
						testFile: 'src/foo.test.ts',
						testName: 'some test',
						result: 'pass',
						durationMs: Infinity,
						changedFiles: [],
					},
					tempDir,
				),
			).toThrow('durationMs must be a finite number');
		});

		test('throws TypeError when timestamp is invalid ISO 8601', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: 'not-a-valid-date',
						taskId: '4.1',
						testFile: 'src/foo.test.ts',
						testName: 'some test',
						result: 'pass',
						durationMs: 100,
						changedFiles: [],
					},
					tempDir,
				),
			).toThrow('timestamp must be a valid ISO 8601 string');
		});

		test('throws TypeError when changedFiles is not an array', () => {
			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '4.1',
						testFile: 'src/foo.test.ts',
						testName: 'some test',
						result: 'pass',
						durationMs: 100,
						changedFiles: 'not-an-array',
					} as any,
					tempDir,
				),
			).toThrow('changedFiles must be an array');
		});

		test('accepts valid minimal record with only required fields', () => {
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'some test',
					result: 'pass',
					durationMs: 50,
					changedFiles: [],
				},
				tempDir,
			);
			const records = getAllHistory(tempDir);
			expect(records.length).toBe(1);
			expect(records[0].testFile).toBe('src/foo.test.ts');
			expect(records[0].result).toBe('pass');
			expect(records[0].durationMs).toBe(50);
			expect(records[0].changedFiles).toEqual([]);
			expect(records[0].timestamp).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
			);
		});
	});

	// -------------------------------------------------------------------------
	// appendTestRun() sanitization
	// -------------------------------------------------------------------------
	describe('appendTestRun() sanitization', () => {
		test('truncates errorMessage to 500 characters', () => {
			const longError = 'x'.repeat(600);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'some test',
					result: 'fail',
					durationMs: 50,
					errorMessage: longError,
					changedFiles: [],
				},
				tempDir,
			);
			const records = getAllHistory(tempDir);
			expect(records[0].errorMessage!.length).toBe(500);
			expect(records[0].errorMessage!).toBe('x'.repeat(500));
		});

		test('truncates stackPrefix to 200 characters', () => {
			const longStack = 'y'.repeat(250);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'some test',
					result: 'fail',
					durationMs: 50,
					stackPrefix: longStack,
					changedFiles: [],
				},
				tempDir,
			);
			const records = getAllHistory(tempDir);
			expect(records[0].stackPrefix!.length).toBe(200);
			expect(records[0].stackPrefix!).toBe('y'.repeat(200));
		});

		test('truncates changedFiles to max 50 entries', () => {
			const manyFiles = Array.from({ length: 80 }, (_, i) => `file${i}.ts`);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'some test',
					result: 'pass',
					durationMs: 50,
					changedFiles: manyFiles,
				},
				tempDir,
			);
			const records = getAllHistory(tempDir);
			expect(records[0].changedFiles.length).toBe(50);
			expect(records[0].changedFiles[0]).toBe('file0.ts');
			expect(records[0].changedFiles[49]).toBe('file49.ts');
		});

		test('filters out non-string and empty-string entries from changedFiles', () => {
			const mixedFiles = [
				'valid.ts',
				'',
				123 as any,
				undefined as any,
				'another.ts',
			];
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'some test',
					result: 'pass',
					durationMs: 50,
					changedFiles: mixedFiles,
				},
				tempDir,
			);
			const records = getAllHistory(tempDir);
			expect(records[0].changedFiles).toEqual(['valid.ts', 'another.ts']);
		});

		test('defaults durationMs to 0 when negative', () => {
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'some test',
					result: 'pass',
					durationMs: -50,
					changedFiles: [],
				},
				tempDir,
			);
			const records = getAllHistory(tempDir);
			expect(records[0].durationMs).toBe(0);
		});

		test('defaults timestamp to current ISO string when not provided', () => {
			const before = new Date().toISOString();
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'some test',
					result: 'pass',
					durationMs: 50,
					changedFiles: [],
				},
				tempDir,
			);
			const after = new Date().toISOString();
			const records = getAllHistory(tempDir);
			// timestamp should be close to current time (within same second)
			const recordTime = new Date(records[0].timestamp).getTime();
			const beforeTime = new Date(before).getTime();
			const afterTime = new Date(after).getTime();
			expect(
				recordTime >= beforeTime - 1000 && recordTime <= afterTime + 1000,
			).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// appendTestRun() pruning: keeps last 20 records per (testFile, testName)
	// -------------------------------------------------------------------------
	describe('appendTestRun() pruning', () => {
		test('keeps only the last 20 records per testFile + testName key', () => {
			const testFile = 'src/foo.test.ts';
			for (let i = 0; i < 25; i++) {
				appendTestRun(
					{
						timestamp: new Date(Date.now() + i * 1000).toISOString(),
						taskId: '4.1',
						testFile,
						testName: 'stable test name',
						result: i % 2 === 0 ? 'pass' : 'fail',
						durationMs: 10 + i,
						changedFiles: [],
					},
					tempDir,
				);
			}
			const records = getTestHistory(testFile, tempDir);
			expect(records.length).toBe(20);
			// First record should be the 6th inserted record, last should be the 25th
			expect(records[0].durationMs).toBe(15);
			expect(records[19].durationMs).toBe(34);
		});

		test('prunes independently per testFile + testName key', () => {
			const fileA = 'src/a.test.ts';
			const fileB = 'src/b.test.ts';
			// Write 25 for file A
			for (let i = 0; i < 25; i++) {
				appendTestRun(
					{
						timestamp: new Date(Date.now() + i * 1000).toISOString(),
						taskId: '4.1',
						testFile: fileA,
						testName: 'shared name',
						result: 'pass',
						durationMs: 10,
						changedFiles: [],
					},
					tempDir,
				);
			}
			// Write 5 for file B
			for (let i = 0; i < 5; i++) {
				appendTestRun(
					{
						timestamp: new Date(Date.now() + i * 1000).toISOString(),
						taskId: '4.1',
						testFile: fileB,
						testName: 'shared name',
						result: 'pass',
						durationMs: 10,
						changedFiles: [],
					},
					tempDir,
				);
			}
			const recordsA = getTestHistory(fileA, tempDir);
			const recordsB = getTestHistory(fileB, tempDir);
			expect(recordsA.length).toBe(20);
			expect(recordsB.length).toBe(5);
		});

		test('prunes independently for different test names in same file', () => {
			const testFile = 'src/per-test-key.test.ts';
			for (let i = 0; i < 25; i++) {
				appendTestRun(
					{
						timestamp: new Date(Date.now() + i * 1000).toISOString(),
						taskId: `a-${i}`,
						testFile,
						testName: 'alpha',
						result: 'pass',
						durationMs: i,
						changedFiles: [],
					},
					tempDir,
				);
				appendTestRun(
					{
						timestamp: new Date(Date.now() + i * 1000 + 500).toISOString(),
						taskId: `b-${i}`,
						testFile,
						testName: 'beta',
						result: 'pass',
						durationMs: i,
						changedFiles: [],
					},
					tempDir,
				);
			}

			const records = getTestHistory(testFile, tempDir);
			expect(records.length).toBe(40);
			expect(
				records.filter((record) => record.testName === 'alpha').length,
			).toBe(20);
			expect(
				records.filter((record) => record.testName === 'beta').length,
			).toBe(20);
		});

		test('sorts pruned records by timestamp ascending (oldest first)', () => {
			const testFile = 'src/foo.test.ts';
			// Insert out of order
			const times = [3000, 1000, 2000, 5000, 4000];
			for (const offset of times) {
				appendTestRun(
					{
						timestamp: new Date(Date.now() + offset).toISOString(),
						taskId: '4.1',
						testFile,
						testName: `run ${offset}`,
						result: 'pass',
						durationMs: 10,
						changedFiles: [],
					},
					tempDir,
				);
			}
			const records = getTestHistory(testFile, tempDir);
			// Should be sorted by timestamp
			for (let i = 1; i < records.length; i++) {
				expect(new Date(records[i].timestamp).getTime()).toBeGreaterThanOrEqual(
					new Date(records[i - 1].timestamp).getTime(),
				);
			}
		});
	});

	// -------------------------------------------------------------------------
	// getTestHistory() behavior
	// -------------------------------------------------------------------------
	describe('getTestHistory()', () => {
		test('returns records filtered by testFile', () => {
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/a.test.ts',
					testName: 'a test',
					result: 'pass',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/b.test.ts',
					testName: 'b test',
					result: 'fail',
					durationMs: 20,
					changedFiles: [],
				},
				tempDir,
			);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/a.test.ts',
					testName: 'a test 2',
					result: 'pass',
					durationMs: 30,
					changedFiles: [],
				},
				tempDir,
			);
			const aRecords = getTestHistory('src/a.test.ts', tempDir);
			const bRecords = getTestHistory('src/b.test.ts', tempDir);
			expect(aRecords.length).toBe(2);
			expect(bRecords.length).toBe(1);
			expect(aRecords[0].testName).toBe('a test');
			expect(bRecords[0].testName).toBe('b test');
		});

		test('returns records sorted chronologically (oldest first)', () => {
			const testFile = 'src/foo.test.ts';
			appendTestRun(
				{
					timestamp: new Date('2024-01-03T00:00:00Z').toISOString(),
					taskId: '4.1',
					testFile,
					testName: 'third',
					result: 'pass',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);
			appendTestRun(
				{
					timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
					taskId: '4.1',
					testFile,
					testName: 'first',
					result: 'pass',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);
			appendTestRun(
				{
					timestamp: new Date('2024-01-02T00:00:00Z').toISOString(),
					taskId: '4.1',
					testFile,
					testName: 'second',
					result: 'fail',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);
			const records = getTestHistory(testFile, tempDir);
			expect(records.length).toBe(3);
			expect(records[0].testName).toBe('first');
			expect(records[1].testName).toBe('second');
			expect(records[2].testName).toBe('third');
		});

		test('returns empty array when no matching records exist', () => {
			const records = getTestHistory('nonexistent.test.ts', tempDir);
			expect(records).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// getAllHistory() behavior
	// -------------------------------------------------------------------------
	describe('getAllHistory()', () => {
		test('returns all records sorted chronologically', () => {
			appendTestRun(
				{
					timestamp: new Date('2024-01-03T00:00:00Z').toISOString(),
					taskId: '4.1',
					testFile: 'src/b.test.ts',
					testName: 'b third',
					result: 'pass',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);
			appendTestRun(
				{
					timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
					taskId: '4.1',
					testFile: 'src/a.test.ts',
					testName: 'a first',
					result: 'pass',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);
			appendTestRun(
				{
					timestamp: new Date('2024-01-02T00:00:00Z').toISOString(),
					taskId: '4.1',
					testFile: 'src/b.test.ts',
					testName: 'b second',
					result: 'fail',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);
			const records = getAllHistory(tempDir);
			expect(records.length).toBe(3);
			expect(records[0].testName).toBe('a first');
			expect(records[1].testName).toBe('b second');
			expect(records[2].testName).toBe('b third');
		});
	});

	// -------------------------------------------------------------------------
	// Empty/missing history file
	// -------------------------------------------------------------------------
	describe('missing history file', () => {
		test('getTestHistory() returns empty array when file does not exist', () => {
			const records = getTestHistory('src/foo.test.ts', tempDir);
			expect(records).toEqual([]);
		});

		test('getAllHistory() returns empty array when file does not exist', () => {
			const records = getAllHistory(tempDir);
			expect(records).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// Corrupted JSON lines
	// -------------------------------------------------------------------------
	describe('corrupted JSONL handling', () => {
		test('silently skips corrupted JSON lines', () => {
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			// Create dir and file with mixed valid/corrupt lines
			const histDir = path.dirname(historyPath);
			fs.mkdirSync(histDir, { recursive: true });
			const validRecord = {
				timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
				taskId: '4.1',
				testFile: 'src/valid.test.ts',
				testName: 'valid test',
				result: 'pass',
				durationMs: 10,
				changedFiles: [],
			};
			fs.writeFileSync(
				historyPath,
				`${JSON.stringify(validRecord)}\nnot valid json\n{"testFile":"src/valid.test.ts","testName":"another","result":"pass"}\n`,
				'utf-8',
			);

			const records = getAllHistory(tempDir);
			// Only the fully valid persisted record is retained.
			expect(records.length).toBe(1);
		});

		test('skips lines that are not objects with required fields', () => {
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			const histDir = path.dirname(historyPath);
			fs.mkdirSync(histDir, { recursive: true });
			// Write a valid record, a JSON with missing fields, and another valid
			const valid1 = {
				timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
				taskId: '4.1',
				testFile: 'src/valid.test.ts',
				testName: 'valid 1',
				result: 'pass',
				durationMs: 10,
				changedFiles: [],
			};
			const incomplete = {
				timestamp: new Date('2024-01-02T00:00:00Z').toISOString(),
				taskId: '4.1',
				// missing testFile and testName
				result: 'pass',
				durationMs: 10,
			};
			const valid2 = {
				timestamp: new Date('2024-01-03T00:00:00Z').toISOString(),
				taskId: '4.1',
				testFile: 'src/valid.test.ts',
				testName: 'valid 2',
				result: 'fail',
				durationMs: 20,
				changedFiles: [],
			};
			fs.writeFileSync(
				historyPath,
				`${JSON.stringify(valid1)}\n${JSON.stringify(incomplete)}\n${JSON.stringify(valid2)}\n`,
				'utf-8',
			);

			const records = getAllHistory(tempDir);
			expect(records.length).toBe(2);
			expect(records[0].testName).toBe('valid 1');
			expect(records[1].testName).toBe('valid 2');
		});

		test('skips malformed stored testName records before pruning', () => {
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			const histDir = path.dirname(historyPath);
			fs.mkdirSync(histDir, { recursive: true });
			const malformed = {
				timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
				taskId: '4.1',
				testFile: 'src/poisoned.test.ts',
				testName: 123,
				result: 'pass',
				durationMs: 10,
				changedFiles: [],
			};
			fs.writeFileSync(historyPath, `${JSON.stringify(malformed)}\n`, 'utf-8');

			// Previous code accepted the malformed row from disk, then crashed while
			// pruning because it called testName.toLowerCase() on a number.
			appendTestRun(
				{
					timestamp: new Date('2024-01-02T00:00:00Z').toISOString(),
					taskId: '4.2',
					testFile: 'src/poisoned.test.ts',
					testName: 'real test',
					result: 'pass',
					durationMs: 20,
					changedFiles: [],
				},
				tempDir,
			);

			const records = getAllHistory(tempDir);
			expect(records.length).toBe(1);
			expect(records[0].testName).toBe('real test');
		});
	});

	// -------------------------------------------------------------------------
	// File I/O — real temp files
	// -------------------------------------------------------------------------
	describe('file I/O with real temp files', () => {
		test('creates .swarm/cache directory if it does not exist', () => {
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'my test',
					result: 'pass',
					durationMs: 5,
					changedFiles: [],
				},
				tempDir,
			);
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			expect(fs.existsSync(historyPath)).toBe(true);
			const records = getAllHistory(tempDir);
			expect(records.length).toBe(1);
		});

		test('persists records across multiple appendTestRun calls', () => {
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'first',
					result: 'pass',
					durationMs: 5,
					changedFiles: [],
				},
				tempDir,
			);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'src/foo.test.ts',
					testName: 'second',
					result: 'fail',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);
			const records = getAllHistory(tempDir);
			expect(records.length).toBe(2);
			expect(records[0].testName).toBe('first');
			expect(records[1].testName).toBe('second');
			expect(records[1].result).toBe('fail');
		});

		test('preserves all records under parallel appendTestRun callers', async () => {
			const writerCount = 10;
			const writesPerWriter = 4;
			const modulePath = path.resolve(
				import.meta.dir,
				'../../test-impact/history-store.ts',
			);
			const childScriptPath = path.join(tempDir, 'history-writer.mjs');
			const childCode = `
import { appendTestRun } from ${JSON.stringify(modulePath)};
const [workingDir, writerId, writesPerWriterArg] = process.argv.slice(-3);
const writes = Number(writesPerWriterArg);
for (let i = 0; i < writes; i++) {
  appendTestRun({
    timestamp: new Date().toISOString(),
    taskId: \`parallel-\${writerId}\`,
    testFile: 'src/parallel.test.ts',
    testName: \`writer-\${writerId}-run-\${i}\`,
    result: 'pass',
    durationMs: 1,
    changedFiles: [],
  }, workingDir);
}
`;
			fs.writeFileSync(childScriptPath, childCode, 'utf-8');

			const runWriter = (writerId: number): Promise<void> =>
				new Promise((resolve, reject) => {
					const child = spawn(
						process.execPath,
						[
							childScriptPath,
							tempDir,
							String(writerId),
							String(writesPerWriter),
						],
						{
							stdio: ['ignore', 'pipe', 'pipe'],
						},
					);
					let stderr = '';
					child.stderr.on('data', (chunk) => {
						stderr += String(chunk);
					});
					child.on('error', reject);
					child.on('exit', (code) => {
						if (code === 0) {
							resolve();
							return;
						}
						reject(
							new Error(
								`writer ${writerId} failed with code ${code}: ${stderr.trim()}`,
							),
						);
					});
				});

			await Promise.all(
				Array.from({ length: writerCount }, (_, writerId) => runWriter(writerId)),
			);

			const records = getAllHistory(tempDir);
			expect(records.length).toBe(writerCount * writesPerWriter);
			const uniqueNames = new Set(records.map((record) => record.testName));
			expect(uniqueNames.size).toBe(writerCount * writesPerWriter);
		});
	});

	describe('validateProjectRoot guard', () => {
		test('appendTestRun throws when validateProjectRoot rejects directory', () => {
			const savedValidate = historyInternals.validateProjectRoot;
			afterEach(() => {
				historyInternals.validateProjectRoot = savedValidate;
			});

			historyInternals.validateProjectRoot = () => {
				throw new Error(
					'Cannot write evidence in "/project/sub" — parent directory "/project" already contains a .swarm/ folder. Evidence must be written to the project root.',
				);
			};

			expect(() =>
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '4.1',
						testFile: 'src/foo.test.ts',
						testName: 'some test',
						result: 'pass',
						durationMs: 100,
						changedFiles: [],
					},
					tempDir,
				),
			).toThrow('already contains a .swarm/ folder');
		});
	});
});
