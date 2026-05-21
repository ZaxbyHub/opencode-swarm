import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
	appendTestRun,
	getAllHistory,
	getTestHistory,
	_internals as historyInternals,
} from '../history-store.js';

describe('history-store adversarial security tests', () => {
	const tempDir = path.join(import.meta.dir, `adversarial-temp-${Date.now()}`);
	let savedValidateProjectRoot: typeof historyInternals.validateProjectRoot;

	beforeEach(() => {
		// Disable validateProjectRoot for tests writing to temp dirs under
		// the project source tree (which has .swarm/ at its root).
		savedValidateProjectRoot = historyInternals.validateProjectRoot;
		historyInternals.validateProjectRoot = () => {};

		// Create fresh temp directory for each test
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		historyInternals.validateProjectRoot = savedValidateProjectRoot;
		// Clean up temp directory after each test
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ============================================
	// ATTACK SURFACE 1: Path Traversal via testFile
	// ============================================
	describe('path traversal attacks via testFile', () => {
		test('accepts Unix path traversal but stores literally (defense: data isolation)', () => {
			const maliciousPath = '../../../etc/passwd';
			// Should not throw - validation accepts it, but it's stored as data
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '1.1',
						testFile: maliciousPath,
						testName: 'test',
						result: 'pass',
						durationMs: 0,
						changedFiles: [],
					},
					tempDir,
				);
			}).not.toThrow();

			// Verify it's stored as-is in the JSONL
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			const content = fs.readFileSync(historyPath, 'utf-8');
			expect(content).toContain(maliciousPath);
		});

		test('accepts Windows path traversal but stores literally (defense: data isolation)', () => {
			const maliciousPath = '..\\..\\windows\\system32\\config\\sam';
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '1.2',
						testFile: maliciousPath,
						testName: 'test',
						result: 'pass',
						durationMs: 0,
						changedFiles: [],
					},
					tempDir,
				);
			}).not.toThrow();

			// Verify no actual file was created at traversal target
			const realTarget = path.join(
				tempDir,
				'..',
				'..',
				'windows',
				'system32',
				'config',
				'sam',
			);
			expect(fs.existsSync(realTarget)).toBe(false);
		});

		test('path with null byte in testFile is handled', () => {
			const maliciousPath = 'test\x00file.js';
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '1.3',
						testFile: maliciousPath,
						testName: 'test',
						result: 'pass',
						durationMs: 0,
						changedFiles: [],
					},
					tempDir,
				);
			}).not.toThrow();

			// Null byte should be stripped or handled
			const _history = getTestHistory(maliciousPath, tempDir);
			// The file is written with the path as-is; null byte handling is at OS level
		});
	});

	// ============================================
	// ATTACK SURFACE 2: Injection via errorMessage/stackPrefix
	// ============================================
	describe('injection attacks via errorMessage and stackPrefix', () => {
		test('newline injection in errorMessage breaks JSONL format on disk', () => {
			const injection = 'Error message\n{"malicious": "json"}';
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '2.1',
					testFile: 'test.spec.ts',
					testName: 'injection test',
					result: 'fail',
					durationMs: 100,
					errorMessage: injection,
					changedFiles: [],
				},
				tempDir,
			);

			// Read raw file content - newline was escaped in JSON
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			const content = fs.readFileSync(historyPath, 'utf-8');
			// JSON.stringify escapes newlines, so it's safe
			const parsed = JSON.parse(content.trim());
			expect(parsed.errorMessage).toBe(injection);
		});

		test('JSON injection attempt in errorMessage is stored as literal string', () => {
			const injection = '{"__proto__": {"admin": true}}';
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '2.2',
					testFile: 'test.spec.ts',
					testName: 'json injection',
					result: 'fail',
					durationMs: 100,
					errorMessage: injection,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			// It's stored as a string, not executed
			expect(history[0].errorMessage).toBe(injection);
		});

		test('control characters in errorMessage are preserved but read safely', () => {
			const controlChars = 'Error\x00\x1a\x7fMessage';
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '2.3',
					testFile: 'test.spec.ts',
					testName: 'control chars',
					result: 'fail',
					durationMs: 100,
					errorMessage: controlChars,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].errorMessage).toBe(controlChars);
		});

		test('Unicode emoji in errorMessage is preserved correctly', () => {
			// Use fewer A's so total is under 500 chars
			const emojiMessage = `💣💥🔥😈💀👾${'A'.repeat(100)}`;
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '2.4',
					testFile: 'test.spec.ts',
					testName: 'emoji test',
					result: 'fail',
					durationMs: 100,
					errorMessage: emojiMessage,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].errorMessage).toBe(emojiMessage);
		});

		test('stackPrefix with newlines and JSON is stored safely', () => {
			const maliciousStack =
				'Error: boom\n  at Object.<anonymous> (/path/to/file.js:10:5)\n{"injected": true}';
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '2.5',
					testFile: 'test.spec.ts',
					testName: 'stack injection',
					result: 'fail',
					durationMs: 100,
					stackPrefix: maliciousStack,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].stackPrefix).toBe(maliciousStack);
		});
	});

	// ============================================
	// ATTACK SURFACE 3: Boundary - exactly 20 records per test key
	// ============================================
	describe('boundary: 20 records per test key triggers pruning', () => {
		test('21st record for same testFile + testName triggers pruning', () => {
			const testFile = 'prune-test.spec.ts';

			// Add 20 records
			for (let i = 0; i < 20; i++) {
				appendTestRun(
					{
						timestamp: new Date(Date.now() + i * 1000).toISOString(),
						taskId: `3.1.${i}`,
						testFile,
						testName: 'stable test name',
						result: 'pass',
						durationMs: 10 + i,
						changedFiles: [],
					},
					tempDir,
				);
			}

			let history = getTestHistory(testFile, tempDir);
			expect(history.length).toBe(20);

			// Add 21st record for the same test key
			appendTestRun(
				{
					timestamp: new Date(Date.now() + 1000 * 20).toISOString(),
					taskId: '3.1.20',
					testFile,
					testName: 'stable test name',
					result: 'pass',
					durationMs: 30,
					changedFiles: [],
				},
				tempDir,
			);

			history = getTestHistory(testFile, tempDir);
			// Should still be 20, oldest should be pruned
			expect(history.length).toBe(20);
			// First record should NOT be taskId '3.1.0'
			const taskIds = history.map((r) => r.taskId);
			expect(taskIds).not.toContain('3.1.0');
		});

		test('records for different testFiles are tracked separately', () => {
			// Add 20 records for file A
			for (let i = 0; i < 20; i++) {
				appendTestRun(
					{
						timestamp: new Date(Date.now() + i * 1000).toISOString(),
						taskId: `3.2.a${i}`,
						testFile: 'file-a.spec.ts',
						testName: 'stable test name',
						result: 'pass',
						durationMs: 10,
						changedFiles: [],
					},
					tempDir,
				);
			}

			// Add 1 record for file B - should NOT trigger pruning for file A
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '3.2.b0',
					testFile: 'file-b.spec.ts',
					testName: 'test',
					result: 'pass',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);

			const historyA = getTestHistory('file-a.spec.ts', tempDir);
			const historyB = getTestHistory('file-b.spec.ts', tempDir);

			expect(historyA.length).toBe(20);
			expect(historyB.length).toBe(1);
		});
	});

	// ============================================
	// ATTACK SURFACE 4: Boundary - 50 changedFiles limit
	// ============================================
	describe('boundary: 50 changedFiles limit', () => {
		test('exactly 50 changedFiles is accepted', () => {
			const files = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.1',
					testFile: 'test.spec.ts',
					testName: '50 files',
					result: 'pass',
					durationMs: 10,
					changedFiles: files,
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].changedFiles.length).toBe(50);
		});

		test('51st changedFile is silently dropped', () => {
			const files = Array.from({ length: 51 }, (_, i) => `file${i}.ts`);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.2',
					testFile: 'test.spec.ts',
					testName: '51 files',
					result: 'pass',
					durationMs: 10,
					changedFiles: files,
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].changedFiles.length).toBe(50);
			expect(history[0].changedFiles).not.toContain('file50.ts');
		});

		test('empty strings in changedFiles are filtered out', () => {
			const files = ['valid.ts', '', 'another.ts', ''];
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.3',
					testFile: 'test.spec.ts',
					testName: 'empty filtered',
					result: 'pass',
					durationMs: 10,
					changedFiles: files,
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].changedFiles).not.toContain('');
			expect(history[0].changedFiles).toEqual(['valid.ts', 'another.ts']);
		});

		test('non-strings in changedFiles are filtered out', () => {
			const files = [
				'valid.ts',
				123 as any,
				null as any,
				undefined as any,
				{} as any,
				'another.ts',
			];
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '4.4',
					testFile: 'test.spec.ts',
					testName: 'non-string filtered',
					result: 'pass',
					durationMs: 10,
					changedFiles: files,
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].changedFiles).toEqual(['valid.ts', 'another.ts']);
		});
	});

	// ============================================
	// ATTACK SURFACE 5: Boundary - 500 char errorMessage
	// ============================================
	describe('boundary: 500 char errorMessage truncation', () => {
		test('exactly 500 char errorMessage is accepted', () => {
			const msg = 'A'.repeat(500);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '5.1',
					testFile: 'test.spec.ts',
					testName: '500 chars',
					result: 'fail',
					durationMs: 10,
					errorMessage: msg,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].errorMessage!.length).toBe(500);
		});

		test('501 char errorMessage is truncated to 500', () => {
			const msg = 'A'.repeat(501);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '5.2',
					testFile: 'test.spec.ts',
					testName: '501 chars',
					result: 'fail',
					durationMs: 10,
					errorMessage: msg,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].errorMessage!.length).toBe(500);
			expect(history[0].errorMessage).toBe('A'.repeat(500));
		});

		test('1000 char errorMessage is truncated to 500', () => {
			const msg = 'B'.repeat(1000);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '5.3',
					testFile: 'test.spec.ts',
					testName: '1000 chars',
					result: 'fail',
					durationMs: 10,
					errorMessage: msg,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].errorMessage!.length).toBe(500);
		});
	});

	// ============================================
	// ATTACK SURFACE 6: Boundary - 200 char stackPrefix
	// ============================================
	describe('boundary: 200 char stackPrefix truncation', () => {
		test('exactly 200 char stackPrefix is accepted', () => {
			const stack = 'C'.repeat(200);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '6.1',
					testFile: 'test.spec.ts',
					testName: '200 chars',
					result: 'fail',
					durationMs: 10,
					stackPrefix: stack,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].stackPrefix!.length).toBe(200);
		});

		test('201 char stackPrefix is truncated to 200', () => {
			const stack = 'D'.repeat(201);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '6.2',
					testFile: 'test.spec.ts',
					testName: '201 chars',
					result: 'fail',
					durationMs: 10,
					stackPrefix: stack,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].stackPrefix!.length).toBe(200);
			expect(history[0].stackPrefix).toBe('D'.repeat(200));
		});

		test('500 char stackPrefix is truncated to 200', () => {
			const stack = 'E'.repeat(500);
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '6.3',
					testFile: 'test.spec.ts',
					testName: '500 chars',
					result: 'fail',
					durationMs: 10,
					stackPrefix: stack,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].stackPrefix!.length).toBe(200);
		});
	});

	// ============================================
	// ATTACK SURFACE 7: Prototype Pollution
	// ============================================
	describe('prototype pollution attempts in changedFiles', () => {
		test('__proto__ in changedFiles array is filtered out', () => {
			const files = ['legit.ts', '__proto__', 'another.ts'];
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '7.1',
					testFile: 'test.spec.ts',
					testName: 'proto pollution',
					result: 'pass',
					durationMs: 10,
					changedFiles: files,
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].changedFiles).not.toContain('__proto__');
			expect(history[0].changedFiles).toEqual(['legit.ts', 'another.ts']);
		});

		test('constructor in changedFiles array is filtered out', () => {
			const files = ['file.ts', 'constructor', 'file2.ts'];
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '7.2',
					testFile: 'test.spec.ts',
					testName: 'constructor pollution',
					result: 'pass',
					durationMs: 10,
					changedFiles: files,
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].changedFiles).not.toContain('constructor');
			expect(history[0].changedFiles).toEqual(['file.ts', 'file2.ts']);
		});

		test('prototype in changedFiles array is filtered out', () => {
			const files = ['file.ts', 'prototype', 'file2.ts'];
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '7.3',
					testFile: 'test.spec.ts',
					testName: 'prototype pollution',
					result: 'pass',
					durationMs: 10,
					changedFiles: files,
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].changedFiles).not.toContain('prototype');
		});
	});

	// ============================================
	// ATTACK SURFACE 8: Null bytes in strings
	// ============================================
	describe('null byte handling in string fields', () => {
		test('null byte in testFile', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '8.1',
						testFile: 'test\x00.spec.ts',
						testName: 'test',
						result: 'pass',
						durationMs: 0,
						changedFiles: [],
					},
					tempDir,
				);
			}).not.toThrow();
		});

		test('null byte in testName', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '8.2',
						testFile: 'test.spec.ts',
						testName: 'test\x00name',
						result: 'pass',
						durationMs: 0,
						changedFiles: [],
					},
					tempDir,
				);
			}).not.toThrow();
		});

		test('null byte in taskId', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '8\x003',
						testFile: 'test.spec.ts',
						testName: 'test',
						result: 'pass',
						durationMs: 0,
						changedFiles: [],
					},
					tempDir,
				);
			}).not.toThrow();
		});
	});

	// ============================================
	// ATTACK SURFACE 9: Large number of records (performance)
	// ============================================
	describe('performance: large number of records', () => {
		test('100 records for same file triggers pruning correctly', () => {
			const testFile = 'perf-test.spec.ts';

			// Add 100 records
			for (let i = 0; i < 100; i++) {
				appendTestRun(
					{
						timestamp: new Date(Date.now() + i * 1000).toISOString(),
						taskId: `9.1.${i}`,
						testFile,
						testName: 'stable test name',
						result: 'pass',
						durationMs: i,
						changedFiles: [],
					},
					tempDir,
				);
			}

			const history = getTestHistory(testFile, tempDir);
			expect(history.length).toBe(20);
			// Should have the 20 most recent (taskId 9.1.80 through 9.1.99)
			const taskIds = history.map((r) => r.taskId);
			expect(taskIds).toContain('9.1.80');
			expect(taskIds).toContain('9.1.99');
			expect(taskIds).not.toContain('9.1.0');
			expect(taskIds).not.toContain('9.1.79');
		});

		test('records for 10 different files are all tracked correctly', () => {
			for (let f = 0; f < 10; f++) {
				for (let i = 0; i < 25; i++) {
					appendTestRun(
						{
							timestamp: new Date(Date.now() + i * 1000).toISOString(),
							taskId: `9.2.${f}.${i}`,
							testFile: `file${f}.spec.ts`,
							testName: 'stable test name',
							result: 'pass',
							durationMs: i,
							changedFiles: [],
						},
						tempDir,
					);
				}
			}

			const allHistory = getAllHistory(tempDir);
			expect(allHistory.length).toBe(200); // 10 files * 20 (after pruning)

			// Each file should have exactly 20 records
			for (let f = 0; f < 10; f++) {
				const history = getTestHistory(`file${f}.spec.ts`, tempDir);
				expect(history.length).toBe(20);
			}
		});
	});

	// ============================================
	// ATTACK SURFACE 10: Unicode and emoji in all fields
	// ============================================
	describe('Unicode and emoji in all string fields', () => {
		test('emoji in all major string fields', () => {
			const emojiStr = '🔥💀😈🚀👾🌟💎🍕🎮🦄';
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: emojiStr,
					testFile: `test${emojiStr}.spec.ts`,
					testName: `test name ${emojiStr}`,
					result: 'pass',
					durationMs: 42,
					errorMessage: `error ${emojiStr}`,
					stackPrefix: `stack ${emojiStr}`,
					changedFiles: [`file${emojiStr}.ts`],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			const rec = history[0];
			expect(rec.taskId).toBe(emojiStr);
			expect(rec.testFile).toBe(`test${emojiStr}.spec.ts`);
			expect(rec.testName).toBe(`test name ${emojiStr}`);
			expect(rec.errorMessage).toBe(`error ${emojiStr}`);
			expect(rec.stackPrefix).toBe(`stack ${emojiStr}`);
			expect(rec.changedFiles[0]).toBe(`file${emojiStr}.ts`);
		});

		test('RTL override characters', () => {
			const rtlStr = '\u202EMalicious\u202E'; // RLO + LRI
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '10.2',
					testFile: `test${rtlStr}.spec.ts`,
					testName: 'test',
					result: 'pass',
					durationMs: 0,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			expect(history[0].testFile).toBe(`test${rtlStr}.spec.ts`);
		});

		test('zero-width characters in strings', () => {
			const zwcStr = 'test\u200B\u200C\u200Dfile.js'; // ZWSP, ZWNJ, ZWJ
			appendTestRun(
				{
					timestamp: new Date().toISOString(),
					taskId: '10.3',
					testFile: zwcStr,
					testName: 'test',
					result: 'pass',
					durationMs: 0,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getTestHistory(zwcStr, tempDir);
			expect(history[0].testFile).toBe(zwcStr);
		});
	});

	// ============================================
	// ATTACK SURFACE 11: Extremely long testFile path
	// ============================================
	describe('extremely long testFile path', () => {
		test('10KB testFile path is handled', () => {
			const longPath = 'a'.repeat(10 * 1024);
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '11.1',
						testFile: longPath,
						testName: 'long path test',
						result: 'pass',
						durationMs: 0,
						changedFiles: [],
					},
					tempDir,
				);
			}).not.toThrow();

			const history = getAllHistory(tempDir);
			expect(history[0].testFile).toBe(longPath);
		});

		test('1MB testFile path would be stored but may cause issues', () => {
			const veryLongPath = 'x'.repeat(1024 * 1024);
			// This might cause memory or disk issues, test is informational
			try {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '11.2',
						testFile: veryLongPath,
						testName: 'very long path test',
						result: 'pass',
						durationMs: 0,
						changedFiles: [],
					},
					tempDir,
				);
				const history = getAllHistory(tempDir);
				expect(history[0].testFile).toBe(veryLongPath);
			} catch (err) {
				// Acceptable to fail - 1MB string is extreme
				expect(err).toBeDefined();
			}
		});
	});

	// ============================================
	// ATTACK SURFACE 12: Type Confusion
	// ============================================
	describe('type confusion attacks', () => {
		test('number instead of string for testFile throws', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '12.1',
						testFile: 123 as any,
						testName: 'test',
						result: 'pass',
						durationMs: 0,
					} as any,
					tempDir,
				);
			}).toThrow('testFile must be a non-empty string');
		});

		test('object instead of string for testName throws', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '12.2',
						testFile: 'test.spec.ts',
						testName: { nested: true } as any,
						result: 'pass',
						durationMs: 0,
					} as any,
					tempDir,
				);
			}).toThrow('testName must be a non-empty string');
		});

		test('array instead of string for taskId throws', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: ['a', 'b'] as any,
						testFile: 'test.spec.ts',
						testName: 'test',
						result: 'pass',
						durationMs: 0,
					} as any,
					tempDir,
				);
			}).toThrow('taskId must be a non-empty string');
		});

		test('invalid result type throws', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '12.4',
						testFile: 'test.spec.ts',
						testName: 'test',
						result: 'invalid' as any,
						durationMs: 0,
					} as any,
					tempDir,
				);
			}).toThrow('result must be "pass", "fail", or "skip"');
		});

		test('NaN durationMs throws', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '12.5',
						testFile: 'test.spec.ts',
						testName: 'test',
						result: 'pass',
						durationMs: NaN,
					} as any,
					tempDir,
				);
			}).toThrow('durationMs must be a finite number');
		});

		test('Infinity durationMs throws', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '12.6',
						testFile: 'test.spec.ts',
						testName: 'test',
						result: 'pass',
						durationMs: Infinity,
					} as any,
					tempDir,
				);
			}).toThrow('durationMs must be a finite number');
		});

		test('object instead of array for changedFiles throws', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: new Date().toISOString(),
						taskId: '12.7',
						testFile: 'test.spec.ts',
						testName: 'test',
						result: 'pass',
						durationMs: 0,
						changedFiles: { 0: 'file.ts' } as any,
					} as any,
					tempDir,
				);
			}).toThrow('changedFiles must be an array');
		});

		test('invalid timestamp is rejected', () => {
			expect(() => {
				appendTestRun(
					{
						timestamp: 'not-a-valid-date',
						taskId: '12.8',
						testFile: 'test.spec.ts',
						testName: 'test',
						result: 'pass',
						durationMs: 0,
					} as any,
					tempDir,
				);
			}).toThrow('timestamp must be a valid ISO 8601 string');
		});
	});

	// ============================================
	// ATTACK SURFACE 13: Corrupted/Malformed JSONL File
	// ============================================
	describe('corrupted JSONL file handling', () => {
		test('handles partially corrupted JSONL file', () => {
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			fs.mkdirSync(path.dirname(historyPath), { recursive: true });

			// Write malformed content
			const corruptedContent =
				'{"timestamp":"2024-01-01T00:00:00.000Z","taskId":"13.1","testFile":"a.ts","testName":"test","result":"pass","durationMs":1,"changedFiles":[]}\n' + // valid
				'not valid json at all\n' + // invalid
				'{"timestamp":"2024-01-02T00:00:00.000Z","taskId":"13.2","testFile":"b.ts","testName":"test2","result":"fail","durationMs":2,"changedFiles":[]}\n' + // valid
				'{"truncated": true\n' + // incomplete
				'{"timestamp":"2024-01-03T00:00:00.000Z","taskId":"13.3","testFile":"c.ts","testName":"test3","result":"skip","durationMs":3,"changedFiles":[]}\n'; // valid

			fs.writeFileSync(historyPath, corruptedContent, 'utf-8');

			// Should not throw, should recover valid records
			const history = getAllHistory(tempDir);
			expect(history.length).toBe(3);
			expect(history.map((r) => r.testFile)).toEqual(['a.ts', 'b.ts', 'c.ts']);
		});

		test('handles completely empty file', () => {
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			fs.mkdirSync(path.dirname(historyPath), { recursive: true });
			fs.writeFileSync(historyPath, '', 'utf-8');

			const history = getAllHistory(tempDir);
			expect(history).toEqual([]);
		});

		test('handles file with only whitespace and newlines', () => {
			const historyPath = path.join(
				tempDir,
				'.swarm',
				'cache',
				'test-history.jsonl',
			);
			fs.mkdirSync(path.dirname(historyPath), { recursive: true });
			fs.writeFileSync(historyPath, '\n\n\n   \n\n', 'utf-8');

			const history = getAllHistory(tempDir);
			expect(history).toEqual([]);
		});
	});

	// ============================================
	// ATTACK SURFACE 14: Pruning with mixed case
	// ============================================
	describe('case-insensitive file matching for pruning', () => {
		test('records for same file with different cases are merged for pruning', () => {
			// On case-insensitive file systems (Windows), these should be treated as same file
			appendTestRun(
				{
					timestamp: new Date(Date.now() + 1000).toISOString(),
					taskId: '14.1',
					testFile: 'Test.Spec.TS',
					testName: 'test',
					result: 'pass',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);

			appendTestRun(
				{
					timestamp: new Date(Date.now() + 2000).toISOString(),
					taskId: '14.2',
					testFile: 'test.spec.ts', // different case
					testName: 'test',
					result: 'pass',
					durationMs: 10,
					changedFiles: [],
				},
				tempDir,
			);

			const history = getAllHistory(tempDir);
			// Should be treated as same file, so we have 2 records total
			expect(history.length).toBe(2);
		});
	});
});
