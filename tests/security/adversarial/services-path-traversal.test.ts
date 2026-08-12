/**
 * ADVERSARIAL SECURITY TESTS for run-memory.ts and context-budget-service.ts
 *
 * Tests path traversal vulnerabilities for directory validation.
 * Verifies that all malicious directory inputs are properly rejected with errors.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	formatBudgetWarning,
	getContextBudgetReport,
	getDefaultConfig,
} from '../../../src/services/context-budget-service';
import {
	getRunMemorySummary,
	getTaskHistory,
	recordOutcome,
} from '../../../src/services/run-memory';

describe('ADVERSARIAL: run-memory.ts path traversal security', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-security-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Write a file to the .swarm directory
	 */
	async function writeSwarmFile(filename: string, content: string | object) {
		const swarmDir = join(tempDir, '.swarm');
		const filePath = join(swarmDir, filename);
		await mkdir(dirname(filePath), { recursive: true });
		const data =
			typeof content === 'string' ? content : JSON.stringify(content, null, 2);
		await writeFile(filePath, data);
		return filePath;
	}

	// =========================================================================
	// PATH TRAVERSAL ATTACKS - ALL MUST BE REJECTED
	// =========================================================================

	describe('Path Traversal Attacks: directory parameter', () => {
		test('rejects "../etc" as directory - path traversal detected', async () => {
			await expect(async () => {
				await recordOutcome('../etc', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../" as directory - path traversal detected', async () => {
			await expect(async () => {
				await recordOutcome('../', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../other" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getTaskHistory('../other', '1.1');
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "foo/../bar" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getRunMemorySummary('foo/../bar');
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "foo/..\\bar" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getRunMemorySummary('foo/..\\bar');
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../../etc" as directory - path traversal detected', async () => {
			await expect(async () => {
				await recordOutcome('../../etc', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(/path traversal|Invalid directory/);
		});
	});

	// A workspace ROOT is absolute by contract (`ctx.directory`, AGENTS.md
	// invariant 4). These functions previously ran it through validateDirectory,
	// a relative-sub-path validator, so every real call threw and the feature was
	// dead. They now use validateWorkspaceRoot. Containment is unchanged and is
	// enforced one layer down by validateSwarmPath, which is what these tests pin:
	// an absolute root is ACCEPTED, but writes stay inside <root>/.swarm/.
	describe('Absolute workspace roots: accepted, but still contained', () => {
		test('accepts an absolute workspace root (regression: feature was dead)', async () => {
			await expect(async () => {
				await recordOutcome(tempDir, {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).not.toThrow();
		});

		test('an absolute root round-trips through the read side', async () => {
			await recordOutcome(tempDir, {
				timestamp: '2026-01-01T00:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'QA gate: reviewer gate required',
			});
			const summary = await getRunMemorySummary(tempDir);
			expect(summary).toContain('RUN MEMORY');
			expect(summary).toContain('reviewer gate required');
			expect(await getTaskHistory(tempDir, '1.1')).toHaveLength(1);
		});

		test('an absolute root writes ONLY under <root>/.swarm/', async () => {
			await recordOutcome(tempDir, {
				timestamp: '2026-01-01T00:00:00.000Z',
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'pass',
				attemptNumber: 1,
			});
			// The contained target exists; nothing was written beside .swarm/.
			const at = (...p: string[]) => existsSync(join(...p));
			expect(at(tempDir, '.swarm', 'run-memory.jsonl')).toBe(true);
			expect(at(tempDir, 'run-memory.jsonl')).toBe(false);
			expect(at(dirname(tempDir), 'run-memory.jsonl')).toBe(false);
		});

		test('an absolute root carrying a traversal segment is still rejected', async () => {
			// Concatenated, not join()ed: join() normalizes the ".." away.
			await expect(async () => {
				await getRunMemorySummary(`${tempDir}/../escaped`);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('an absolute root with control characters is still rejected', async () => {
			await expect(async () => {
				await getTaskHistory(`${tempDir}\u0007evil`, '1.1');
			}).toThrow(/control characters|Invalid directory/);
		});
	});

	describe('Empty Directory Attacks: directory parameter', () => {
		test('rejects empty string as directory', async () => {
			await expect(async () => {
				await recordOutcome('', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).toThrow(/empty|Invalid directory/);
		});

		test('rejects whitespace-only string as directory', async () => {
			await expect(async () => {
				await getRunMemorySummary('   ');
			}).toThrow(/empty|Invalid directory/);
		});

		test('rejects null-like empty string as directory', async () => {
			await expect(async () => {
				await getTaskHistory('\t\n', '1.1');
			}).toThrow(/empty|Invalid directory/);
		});
	});

	describe('Valid directories are accepted', () => {
		test('accepts simple relative directory name', async () => {
			// This should NOT throw validation error - directory might not exist but validation passes
			// The function validates directory format, not existence
			await expect(async () => {
				await recordOutcome('valid-workspace', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).not.toThrow(/Invalid directory/);
		});

		test('accepts nested relative directory path', async () => {
			// This should NOT throw validation error
			await expect(async () => {
				await recordOutcome('valid-workspace/nested', {
					timestamp: '2026-01-01T00:00:00.000Z',
					taskId: '1.1',
					taskFingerprint: 'abc12345',
					agent: 'test',
					outcome: 'pass',
					attemptNumber: 1,
				});
			}).not.toThrow(/Invalid directory/);
		});
	});
});

describe('ADVERSARIAL: context-budget-service.ts path traversal security', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-security-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Write a file to the .swarm directory
	 */
	async function writeSwarmFile(filename: string, content: string | object) {
		const swarmDir = join(tempDir, '.swarm');
		const filePath = join(swarmDir, filename);
		await mkdir(dirname(filePath), { recursive: true });
		const data =
			typeof content === 'string' ? content : JSON.stringify(content, null, 2);
		await writeFile(filePath, data);
		return filePath;
	}

	// =========================================================================
	// PATH TRAVERSAL ATTACKS - ALL MUST BE REJECTED
	// =========================================================================

	describe('Path Traversal Attacks: directory parameter', () => {
		test('rejects "../etc" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'../etc',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport('../', 'test prompt', getDefaultConfig());
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../other" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'../other',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "foo/../bar" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'foo/../bar',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "foo/..\\bar" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'foo/..\\bar',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});

		test('rejects "../../etc" as directory - path traversal detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'../../etc',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/path traversal|Invalid directory/);
		});
	});

	describe('Absolute Path Attacks: directory parameter', () => {
		test('rejects "/etc" as directory - absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport('/etc', 'test prompt', getDefaultConfig());
			}).toThrow(/absolute path|Invalid directory/);
		});

		test('rejects "/usr/bin" as directory - absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'/usr/bin',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/absolute path|Invalid directory/);
		});

		test('rejects "\\Windows" as directory - absolute path detected', async () => {
			await expect(async () => {
				await formatBudgetWarning(
					{
						timestamp: '2026-01-01T00:00:00.000Z',
						systemPromptTokens: 1000,
						planCursorTokens: 100,
						knowledgeTokens: 50,
						runMemoryTokens: 50,
						handoffTokens: 50,
						contextMdTokens: 50,
						swarmTotalTokens: 1300,
						estimatedTurnCount: 5,
						estimatedSessionTokens: 6500,
						budgetPct: 3.25,
						status: 'warning',
						recommendation: 'Test',
					},
					'\\Windows',
					getDefaultConfig(),
				);
			}).toThrow(/absolute path|Invalid directory/);
		});

		test('rejects "\\" as directory - absolute path detected', async () => {
			await expect(async () => {
				await formatBudgetWarning(
					{
						timestamp: '2026-01-01T00:00:00.000Z',
						systemPromptTokens: 1000,
						planCursorTokens: 100,
						knowledgeTokens: 50,
						runMemoryTokens: 50,
						handoffTokens: 50,
						contextMdTokens: 50,
						swarmTotalTokens: 1300,
						estimatedTurnCount: 5,
						estimatedSessionTokens: 6500,
						budgetPct: 3.25,
						status: 'warning',
						recommendation: 'Test',
					},
					'\\',
					getDefaultConfig(),
				);
			}).toThrow(/absolute path|Invalid directory/);
		});
	});

	describe('Windows Absolute Path Attacks: directory parameter', () => {
		test('rejects "C:\\Windows" as directory - Windows absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'C:\\Windows',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/Windows absolute path|Invalid directory/);
		});

		test('rejects "C:/Windows" as directory - Windows absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'C:/Windows',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/Windows absolute path|Invalid directory/);
		});

		test('rejects "D:\\Users" as directory - Windows absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport(
					'D:\\Users',
					'test prompt',
					getDefaultConfig(),
				);
			}).toThrow(/Windows absolute path|Invalid directory/);
		});

		test('rejects "E:\\" as directory - Windows absolute path detected', async () => {
			await expect(async () => {
				await getContextBudgetReport('E:\\', 'test prompt', getDefaultConfig());
			}).toThrow(/Windows absolute path|Invalid directory/);
		});
	});

	describe('Empty Directory Attacks: directory parameter', () => {
		test('rejects empty string as directory', async () => {
			await expect(async () => {
				await getContextBudgetReport('', 'test prompt', getDefaultConfig());
			}).toThrow(/empty|Invalid directory/);
		});

		test('rejects whitespace-only string as directory', async () => {
			await expect(async () => {
				await formatBudgetWarning(
					{
						timestamp: '2026-01-01T00:00:00.000Z',
						systemPromptTokens: 1000,
						planCursorTokens: 100,
						knowledgeTokens: 50,
						runMemoryTokens: 50,
						handoffTokens: 50,
						contextMdTokens: 50,
						swarmTotalTokens: 1300,
						estimatedTurnCount: 5,
						estimatedSessionTokens: 6500,
						budgetPct: 3.25,
						status: 'warning',
						recommendation: 'Test',
					},
					'   ',
					getDefaultConfig(),
				);
			}).toThrow(/empty|Invalid directory/);
		});

		test('rejects null-like empty string as directory', async () => {
			await expect(async () => {
				await getContextBudgetReport('\t\n', 'test prompt', getDefaultConfig());
			}).toThrow(/empty|Invalid directory/);
		});
	});

	describe('Valid directories are accepted', () => {
		test('accepts simple relative directory name', async () => {
			// This should NOT throw validation error
			await expect(async () => {
				await getContextBudgetReport(
					'valid-workspace',
					'test prompt',
					getDefaultConfig(),
				);
			}).not.toThrow(/Invalid directory/);
		});

		test('accepts nested relative directory path', async () => {
			// This should NOT throw validation error
			await expect(async () => {
				await formatBudgetWarning(
					{
						timestamp: '2026-01-01T00:00:00.000Z',
						systemPromptTokens: 1000,
						planCursorTokens: 100,
						knowledgeTokens: 50,
						runMemoryTokens: 50,
						handoffTokens: 50,
						contextMdTokens: 50,
						swarmTotalTokens: 1300,
						estimatedTurnCount: 5,
						estimatedSessionTokens: 6500,
						budgetPct: 3.25,
						status: 'warning',
						recommendation: 'Test',
					},
					'valid-workspace/nested',
					getDefaultConfig(),
				);
			}).not.toThrow(/Invalid directory/);
		});
	});
});
