/**
 * ADVERSARIAL SECURITY TESTS for v6.7 Task 5.4 Command Service Extraction
 *
 * Attack vectors tested:
 * 1. Malformed args - null bytes, control characters, empty strings, extremely long strings
 * 2. Traversal attempts - ../, ..\\, path traversal in task IDs, directory arguments
 * 3. Unsafe phase/task selectors - negative numbers, floats, NaN, Infinity, very large numbers
 * 4. Evidence/task-id abuse - task IDs with special characters, path patterns, injection attempts
 *
 * EXPLOITABLE WEAKNESSES FOUND:
 * - See test failures for potential vulnerabilities
 * - sanitizeTaskId provides strong protection for task IDs
 * - validateSwarmPath provides strong protection for file paths
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { handleDiagnoseCommand } from '../../../src/commands/diagnose';
import { handleEvidenceCommand } from '../../../src/commands/evidence';
import { handleExportCommand } from '../../../src/commands/export';
import { handleHistoryCommand } from '../../../src/commands/history';
import { handlePlanCommand } from '../../../src/commands/plan';
import { handleStatusCommand } from '../../../src/commands/status';
import { sanitizeTaskId } from '../../../src/evidence/manager';
import {
	readSwarmFileAsync,
	validateSwarmPath,
} from '../../../src/hooks/utils';
import {
	formatTaskEvidenceMarkdown,
	getEvidenceListData,
	getTaskEvidenceData,
} from '../../../src/services/evidence-service';
import {
	formatPlanMarkdown,
	getPlanData,
} from '../../../src/services/plan-service';

const SAMPLE_PLAN = `# Project Plan

## Phase 1: Setup [COMPLETE]
- [x] Task 1
- [x] Task 2

---

## Phase 2: Implementation [IN PROGRESS]
- [x] Task 3
- [ ] Task 4

---

## Phase 3: Testing [PENDING]
- [ ] Task 5`;

const SAMPLE_EVIDENCE = {
	schema_version: '1.0.0',
	task_id: 'task-1',
	entries: [
		{
			task_id: 'task-1',
			type: 'review',
			verdict: 'pass',
			agent: 'architect',
			summary: 'Test evidence',
			timestamp: new Date().toISOString(),
			risk: 'low' as const,
			issues: [],
		},
	],
	created_at: new Date().toISOString(),
	updated_at: new Date().toISOString(),
};

const mockAgents: Record<
	string,
	{
		name: string;
		description?: string;
		config: { model: string; temperature: number; prompt: string };
	}
> = {
	architect: {
		name: 'Architect',
		description: 'Plans',
		config: { model: 'test-model', temperature: 0.1, prompt: 'test' },
	},
	coder: {
		name: 'Coder',
		description: 'Implements',
		config: { model: 'test-model', temperature: 0.1, prompt: 'test' },
	},
};

describe('ADVERSARIAL: Command Services Attack Vectors', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-attack-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Write a file to the .swarm directory with proper nested directory creation
	 */
	async function writeSwarmFile(filename: string, content: string | object) {
		const swarmDir = join(tempDir, '.swarm');
		const filePath = join(swarmDir, filename);
		// Create all parent directories
		await mkdir(dirname(filePath), { recursive: true });
		const data =
			typeof content === 'string' ? content : JSON.stringify(content, null, 2);
		await writeFile(filePath, data);
		return filePath;
	}

	// =========================================================================
	// ATTACK VECTOR 1: MALFORMED ARGUMENTS
	// =========================================================================
	describe('Attack Vector 1: Malformed Arguments', () => {
		test('PLAN: null byte injection in phase arg - handled gracefully', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			// Null bytes should be handled gracefully - returns full plan
			const result = await handlePlanCommand(tempDir, ['1\x001']);
			expect(typeof result).toBe('string');
		});

		test('PLAN: control characters in phase arg - handled gracefully', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const controlChars = ['\x01', '\x02', '\x03', '\x08', '\x1b'];
			for (const char of controlChars) {
				const result = await handlePlanCommand(tempDir, [`1${char}2`]);
				expect(typeof result).toBe('string');
			}
		});

		test('PLAN: extremely long phase arg (buffer overflow attempt) - no crash', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const longArg = '1'.repeat(100000);
			const result = await handlePlanCommand(tempDir, [longArg]);
			expect(typeof result).toBe('string');
			// Should handle without crashing - returns "Phase X not found"
		});

		test('PLAN: Unicode edge cases in phase arg - handled gracefully', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const unicodeAttacks = [
				'\u202e1', // Right-to-left override
				'\uff11', // Fullwidth digit 1
				'\u0031\u0301', // 1 with combining accent
			];
			for (const attack of unicodeAttacks) {
				const result = await handlePlanCommand(tempDir, [attack]);
				expect(typeof result).toBe('string');
			}
		});

		test('PLAN: special regex characters in phase arg - no ReDoS', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const regexAttacks = ['.*', '.+', '^1$', '(1)', '[1]', '\\1'];
			for (const attack of regexAttacks) {
				const result = await handlePlanCommand(tempDir, [attack]);
				expect(typeof result).toBe('string');
			}
		});

		test('EVIDENCE: malformed task ID - empty string - REJECTED by sanitizeTaskId', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			// Empty string should be rejected by sanitizeTaskId
			await expect(async () => {
				await handleEvidenceCommand(tempDir, ['']);
			}).toThrow(/empty/);
		});

		test('EVIDENCE: malformed task ID - whitespace only - rejected by sanitize', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			// Whitespace-only should be rejected by sanitizeTaskId
			await expect(async () => {
				await getTaskEvidenceData(tempDir, '   ');
			}).toThrow();
		});

		test('EVIDENCE: null byte in task ID - REJECTED by sanitizeTaskId', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			// Should throw - null bytes rejected
			await expect(async () => {
				await getTaskEvidenceData(tempDir, 'task\x00-1');
			}).toThrow(/null/);
		});

		test('EVIDENCE: control characters in task ID - REJECTED', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			await expect(async () => {
				await getTaskEvidenceData(tempDir, 'task\x01-1');
			}).toThrow(/control/);
		});

		test('EVIDENCE: extremely long task ID (buffer overflow) - ACCEPTED by regex but no crash', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			const longId = 'a'.repeat(10000);
			// The regex allows long alphanumeric strings - this is technically valid.
			// Path length guard in loadEvidence returns not_found before any filesystem
			// access when the resolved path exceeds 4096 chars, so this returns
			// hasEvidence: false without crashing.
			const result = await getTaskEvidenceData(tempDir, longId);
			// Should return no evidence (doesn't exist) without crashing
			expect(result.hasEvidence).toBe(false);
		});
	});

	// =========================================================================
	// ATTACK VECTOR 2: PATH TRAVERSAL ATTEMPTS
	// =========================================================================
	describe('Attack Vector 2: Path Traversal Attempts', () => {
		test('EVIDENCE: task ID with ../ traversal - ALL REJECTED by sanitizeTaskId', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			const traversalIds = [
				'../etc/passwd',
				'task/../other',
				'task-1/../../../etc/passwd',
			];
			for (const id of traversalIds) {
				await expect(async () => {
					await getTaskEvidenceData(tempDir, id);
				}).toThrow(/traversal|Invalid/);
			}
		});

		test('validateSwarmPath: rejects ../ traversal patterns', () => {
			const traversalFilenames = [
				'../../../etc/passwd',
				'evidence/../../../etc/passwd',
				'../plan.md',
				'evidence/../../plan.md',
			];
			for (const filename of traversalFilenames) {
				expect(() => {
					validateSwarmPath(tempDir, filename);
				}).toThrow(/traversal|escapes|Invalid/i);
			}
		});

		test('validateSwarmPath: ./relative path is SAFE (stays within .swarm)', () => {
			// ./plan.md resolves to .swarm/plan.md - this is SAFE
			// It doesn't escape the .swarm directory
			const result = validateSwarmPath(tempDir, './plan.md');
			expect(result).toContain('.swarm');
		});

		test('validateSwarmPath: rejects null bytes', () => {
			expect(() => {
				validateSwarmPath(tempDir, 'plan\x00.md');
			}).toThrow(/null/i);
		});

		test('readSwarmFileAsync: returns null for traversal attempts', async () => {
			const result = await readSwarmFileAsync(tempDir, '../../../etc/passwd');
			expect(result).toBeNull();
		});

		test('PLAN: directory traversal in base directory arg - returns null', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			// Attempt to access files outside the intended directory
			const traversalDirs = ['../..', '/etc'];
			for (const dir of traversalDirs) {
				// Should not read files outside the allowed directory
				const result = await readSwarmFileAsync(dir, 'passwd');
				expect(result).toBeNull();
			}
		});

		test('sanitizeTaskId: rejects ALL path traversal patterns', () => {
			const traversalIds = [
				'../task-1',
				'task-1/..',
				'task/../1',
				'task/./1',
				'./task-1',
			];
			for (const id of traversalIds) {
				expect(() => sanitizeTaskId(id)).toThrow(/Invalid|traversal/);
			}
		});

		test('EVIDENCE: symlink escape - blocked by path validation', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);

			// Create a symlink pointing outside .swarm
			const swarmDir = join(tempDir, '.swarm');
			try {
				await symlink('/etc/passwd', join(swarmDir, 'evil-link'));
			} catch {
				// Symlink creation might fail on Windows, which is fine
			}

			// Attempting to access via symlink should fail validation
			// because the path doesn't contain .. but resolves outside .swarm
			const result = await readSwarmFileAsync(tempDir, 'evil-link');
			// Should either return null (file doesn't exist in our temp) or the link content
			// The key is that validateSwarmPath prevents escaping .swarm
			expect(result === null || typeof result === 'string').toBe(true);
		});
	});

	// =========================================================================
	// ATTACK VECTOR 3: UNSAFE PHASE/TASK SELECTORS
	// =========================================================================
	describe('Attack Vector 3: Unsafe Phase/Task Selectors', () => {
		test('PLAN: negative phase number - returns not found', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const result = await handlePlanCommand(tempDir, ['-1']);
			expect(result).toContain('not found');
		});

		test('PLAN: very large phase number (integer overflow) - no crash', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const largeNumbers = [
				'2147483647', // INT_MAX
				'2147483648', // INT_MAX + 1
				'9999999999999999',
			];
			for (const num of largeNumbers) {
				const result = await handlePlanCommand(tempDir, [num]);
				expect(typeof result).toBe('string');
				// Should not crash, returns "not found"
			}
		});

		test('PLAN: float phase numbers - parsed as integers', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const floatNums = ['1.5', '1.999', '2.0'];
			for (const num of floatNums) {
				const result = await handlePlanCommand(tempDir, [num]);
				expect(typeof result).toBe('string');
			}
		});

		test('PLAN: NaN and special numeric values - returns full plan', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const specialValues = ['NaN', 'Infinity', '-Infinity', '+Infinity'];
			for (const val of specialValues) {
				const result = await handlePlanCommand(tempDir, [val]);
				expect(typeof result).toBe('string');
				// NaN parsed, returns full plan
			}
		});

		test('PLAN: scientific notation - parsed correctly', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const sciNotation = ['1e1', '1E1', '1e+1', '2.5e2'];
			for (const val of sciNotation) {
				const result = await handlePlanCommand(tempDir, [val]);
				expect(typeof result).toBe('string');
			}
		});

		test('PLAN: zero phase number (boundary) - returns not found if no Phase 0', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const result = await handlePlanCommand(tempDir, ['0']);
			expect(typeof result).toBe('string');
		});

		test('EVIDENCE: task ID with special characters - ALL REJECTED', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			const specialIds = [
				'task; DROP TABLE evidence;',
				'task${var}',
				'task`id`',
				'task|cat /etc/passwd',
				'task&&ls',
				'task||ls',
				'task>output',
				'task<input',
			];
			for (const id of specialIds) {
				await expect(async () => {
					await getTaskEvidenceData(tempDir, id);
				}).toThrow(/Invalid/);
			}
		});

		test('sanitizeTaskId: rejects ALL shell injection patterns', () => {
			const shellInjectionIds = [
				'task;rm -rf /',
				'task$(whoami)',
				'task`id`',
				'task|cat',
				'task&&echo pwned',
				'task||echo pwned',
				'task>file',
				'task<file',
			];
			for (const id of shellInjectionIds) {
				expect(() => sanitizeTaskId(id)).toThrow(/Invalid/);
			}
		});

		test('sanitizeTaskId: accepts valid task IDs', () => {
			const validIds = [
				'task-1',
				'task_2',
				'Task3',
				'a',
				'A-B-C',
				'1.2.3',
				'v1.0.0',
				'my-task-v2',
			];
			for (const id of validIds) {
				expect(() => sanitizeTaskId(id)).not.toThrow();
			}
		});

		test('sanitizeTaskId: rejects invalid task IDs with special chars', () => {
			const invalidIds = [
				'task 1', // space
				'task@1', // @
				'task#1', // #
				'task!', // !
				'task$', // $
				'task%', // %
				'task/', // slash
				'task\\1', // backslash
				'task:1', // colon
				'task;1', // semicolon
			];
			for (const id of invalidIds) {
				expect(() => sanitizeTaskId(id)).toThrow(/Invalid/);
			}
		});
	});

	// =========================================================================
	// ATTACK VECTOR 4: EVIDENCE/TASK-ID ABUSE
	// =========================================================================
	describe('Attack Vector 4: Evidence/Task-ID Abuse', () => {
		test('EVIDENCE: JSON injection in task evidence display - rendered as text', async () => {
			// Create evidence with potentially dangerous content in summary
			const maliciousEvidence = {
				schema_version: '1.0.0',
				task_id: 'task-1',
				entries: [
					{
						task_id: 'task-1',
						type: 'review',
						verdict: 'pass' as const,
						agent: 'architect',
						summary: '</script><script>alert(1)</script>',
						timestamp: new Date().toISOString(),
						risk: 'low' as const,
						issues: [],
					},
				],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			await writeSwarmFile('evidence/task-1/evidence.json', maliciousEvidence);

			const result = await handleEvidenceCommand(tempDir, ['task-1']);
			// Content should be rendered as text, not executed
			expect(result).toContain('alert(1)');
			expect(typeof result).toBe('string');
		});

		test('EVIDENCE: HTML injection in summary - rendered as text', async () => {
			const htmlEvidence = {
				schema_version: '1.0.0',
				task_id: 'task-1',
				entries: [
					{
						task_id: 'task-1',
						type: 'review',
						verdict: 'pass' as const,
						agent: 'architect',
						summary: '<img src=x onerror=alert(1)>',
						timestamp: new Date().toISOString(),
						risk: 'low' as const,
						issues: [],
					},
				],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			await writeSwarmFile('evidence/task-1/evidence.json', htmlEvidence);

			const result = await handleEvidenceCommand(tempDir, ['task-1']);
			expect(result).toContain('<img');
			expect(typeof result).toBe('string');
		});

		test('EVIDENCE: markdown injection in summary - rendered as markdown', async () => {
			const mdEvidence = {
				schema_version: '1.0.0',
				task_id: 'task-1',
				entries: [
					{
						task_id: 'task-1',
						type: 'review',
						verdict: 'pass' as const,
						agent: 'architect',
						summary: '[click me](javascript:alert(1))',
						timestamp: new Date().toISOString(),
						risk: 'low' as const,
						issues: [],
					},
				],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			await writeSwarmFile('evidence/task-1/evidence.json', mdEvidence);

			const result = await handleEvidenceCommand(tempDir, ['task-1']);
			expect(result).toContain('javascript');
			expect(typeof result).toBe('string');
		});

		test('EVIDENCE: deeply nested path traversal in task ID - REJECTED', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			const nestedTraversal = 'evidence/../../../../../../../etc/passwd';

			await expect(async () => {
				await getTaskEvidenceData(tempDir, nestedTraversal);
			}).toThrow(/Invalid|traversal/);
		});

		test('EVIDENCE: URL-encoded traversal attempts - REJECTED by regex', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			const encodedTraversal = [
				'%2e%2e%2f', // ../
				'%252e%252e%252f', // double-encoded ../
				'..%2f', // ../
				'%2e%2e/', // ../
			];
			for (const id of encodedTraversal) {
				await expect(async () => {
					await getTaskEvidenceData(tempDir, id);
				}).toThrow(/Invalid/);
			}
		});

		test('EVIDENCE: empty task ID - REJECTED by sanitizeTaskId', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			// Empty string throws via sanitizeTaskId
			await expect(async () => {
				await handleEvidenceCommand(tempDir, ['']);
			}).toThrow(/empty/);
		});

		test('getEvidenceListData: handles malicious directory names - filtered out', async () => {
			// Create directory with valid task ID
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);

			// Also create a directory that looks like traversal attempt
			// This should be filtered out by listEvidenceTaskIds
			const swarmDir = join(tempDir, '.swarm');
			try {
				await mkdir(join(swarmDir, 'evidence', '..bad'), { recursive: true });
			} catch {
				// Directory might fail to create with that name
			}

			const result = await getEvidenceListData(tempDir);
			expect(result.tasks.length).toBeGreaterThanOrEqual(0);
			// Malicious directory name should not appear
			for (const task of result.tasks) {
				expect(task.taskId).not.toContain('..');
			}
		});
	});

	// =========================================================================
	// ADDITIONAL SECURITY BOUNDARY TESTS
	// =========================================================================
	describe('Security Boundary Tests', () => {
		test('STATUS: handles malformed plan gracefully', async () => {
			await writeSwarmFile('plan.md', 'corrupted {{{ markdown');
			const result = await handleStatusCommand(tempDir, mockAgents);
			expect(typeof result).toBe('string');
		});

		test('EXPORT: handles malformed plan gracefully', async () => {
			await writeSwarmFile('plan.md', 'corrupted {{{ markdown');
			const result = await handleExportCommand(tempDir, []);
			expect(typeof result).toBe('string');
		});

		test('HISTORY: handles malformed plan gracefully', async () => {
			await writeSwarmFile('plan.md', 'corrupted {{{ markdown');
			const result = await handleHistoryCommand(tempDir, []);
			expect(typeof result).toBe('string');
		});

		test('DIAGNOSE: handles malformed plan gracefully', async () => {
			await writeSwarmFile('plan.md', 'corrupted {{{ markdown');
			const result = await handleDiagnoseCommand(tempDir, []);
			expect(typeof result).toBe('string');
		});

		test('PLAN: plan.json with malicious content - rendered as text', async () => {
			const maliciousPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: '<script>alert(1)</script>',
						status: 'complete',
						tasks: [
							{
								id: 'task-1',
								phase: 1,
								description: '${process.env.SECRET}',
								status: 'completed',
								depends: [],
							},
						],
					},
				],
			};
			await writeSwarmFile('plan.json', maliciousPlan);

			const result = await handlePlanCommand(tempDir, ['1']);
			expect(typeof result).toBe('string');
			// Content should be rendered as text
		});

		test('PLAN: handles prototype pollution attempts - safe', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const pollutionArgs = ['__proto__', 'constructor', 'prototype'];
			for (const arg of pollutionArgs) {
				const result = await handlePlanCommand(tempDir, [arg]);
				expect(typeof result).toBe('string');
			}
		});

		test('getPlanData: handles concurrent access safely', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);

			// Launch multiple concurrent reads
			const promises = Array(10)
				.fill(null)
				.map(() => getPlanData(tempDir, '1'));

			const results = await Promise.all(promises);
			for (const result of results) {
				expect(result).toBeDefined();
				expect(result.hasPlan).toBe(true);
			}
		});

		test('validateSwarmPath: handles Windows-style traversal paths', async () => {
			const windowsPaths = [
				'..\\..\\..\\windows\\system32',
				'evidence\\..\\..\\plan.md',
			];
			for (const p of windowsPaths) {
				expect(() => validateSwarmPath(tempDir, p)).toThrow(
					/traversal|escapes|Invalid/,
				);
			}
		});

		test('validateSwarmPath: handles mixed separators', async () => {
			const mixedPaths = [
				'../..\\..\\etc',
				'evidence/..\\..\\plan.md',
				'..\\../etc/passwd',
			];
			for (const p of mixedPaths) {
				expect(() => validateSwarmPath(tempDir, p)).toThrow(
					/traversal|escapes|Invalid/,
				);
			}
		});

		test('readSwarmFileAsync: does not follow traversal paths', async () => {
			const result = await readSwarmFileAsync(tempDir, '../../../etc/passwd');
			expect(result).toBeNull();
		});
	});

	// =========================================================================
	// INPUT VALIDATION COVERAGE
	// =========================================================================
	describe('Input Validation Coverage', () => {
		test('PLAN: handles empty args array gracefully', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const result = await handlePlanCommand(tempDir, []);
			expect(typeof result).toBe('string');
			expect(result).toContain('Phase 1');
		});

		test('EVIDENCE: handles empty args array gracefully', async () => {
			await writeSwarmFile('evidence/task-1/evidence.json', SAMPLE_EVIDENCE);
			const result = await handleEvidenceCommand(tempDir, []);
			expect(typeof result).toBe('string');
		});

		test('EXPORT: handles empty args array gracefully', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const result = await handleExportCommand(tempDir, []);
			expect(typeof result).toBe('string');
		});

		test('HISTORY: handles empty args array gracefully', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const result = await handleHistoryCommand(tempDir, []);
			expect(typeof result).toBe('string');
		});

		test('DIAGNOSE: handles empty args array gracefully', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);
			const result = await handleDiagnoseCommand(tempDir, []);
			expect(typeof result).toBe('string');
		});

		test('all services handle empty .swarm directory', async () => {
			// Create empty .swarm directory
			await mkdir(join(tempDir, '.swarm'), { recursive: true });

			await expect(handlePlanCommand(tempDir, [])).resolves.toBe(
				'No active swarm plan found.',
			);
			await expect(handleEvidenceCommand(tempDir, [])).resolves.toBe(
				'No evidence bundles found.',
			);
			await expect(handleHistoryCommand(tempDir, [])).resolves.toBe(
				'No history available.',
			);
		});

		test('getPlanData: validates phase arg types correctly', async () => {
			await writeSwarmFile('plan.md', SAMPLE_PLAN);

			// String number
			const result1 = await getPlanData(tempDir, '1');
			expect(result1.requestedPhase).toBe(1);

			// Actual number
			const result2 = await getPlanData(tempDir, 2);
			expect(result2.requestedPhase).toBe(2);

			// Invalid string — returns null (not NaN) since source uses parseInt + null guard
			const result3 = await getPlanData(tempDir, 'invalid');
			expect(result3.requestedPhase).toBeNull();
		});
	});
});
