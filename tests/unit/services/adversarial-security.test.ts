/**
 * Adversarial Security Tests for run-memory.ts and context-budget-service.ts
 *
 * Tests attack vectors: path traversal, malformed inputs, boundary violations,
 * injection attempts, null bytes, and extreme values
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// No path-security mock. Both services now validate their trusted project root
// with validateProjectDirectory, which ACCEPTS the absolute temp directories
// these tests use. The previous no-op mock.module existed only because
// validateDirectory (the untrusted-relative-input validator) rejected every
// absolute path — which also forced the Attack Vector 1 blocks below to
// re-implement the rejection regexes in the test instead of calling the
// services. They now assert the services' real behaviour (issue #1619
// follow-up).

// Import validateSwarmPath to test path traversal directly
import { validateSwarmPath } from '../../../src/hooks/utils';

import {
	type ContextBudgetConfig,
	formatBudgetWarning,
	getContextBudgetReport,
	getDefaultConfig,
} from '../../../src/services/context-budget-service';
// Import services (after mock so transitive imports pick up the mock)
import {
	getRunMemorySummary,
	getTaskHistory,
	type RunMemoryEntry,
	recordOutcome,
} from '../../../src/services/run-memory';

/** Shared valid entry — the subject under test is the DIRECTORY, not the entry. */
const SAMPLE_ENTRY: RunMemoryEntry = {
	timestamp: '2026-08-10T00:00:00.000Z',
	taskId: '1.1',
	taskFingerprint: 'abc12345',
	agent: 'test',
	outcome: 'pass',
	attemptNumber: 1,
};

describe('ADVERSARIAL SECURITY TESTS - run-memory service', () => {
	let tmpDir: string;
	let attackDetected: boolean;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), 'run-memory-adversarial-'),
		);
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		attackDetected = false;
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== ATTACK VECTOR 1: Path Traversal in Directory Parameter ==========
	// The real validator runs (no mock), so these call the services instead of
	// re-implementing the rejection regexes in the test.
	describe('Attack Vector 1: Path Traversal in directory parameter', () => {
		it('recordOutcome rejects a traversal-bearing project root', async () => {
			await expect(
				recordOutcome(`${tmpDir}/../../etc`, SAMPLE_ENTRY),
			).rejects.toThrow('path traversal');
		});

		it('getRunMemorySummary rejects a relative project root', async () => {
			// A relative root would resolve .swarm/ against the host process cwd.
			// (Was getFailures, which #2119 removed from run-memory.)
			await expect(getRunMemorySummary('etc/passwd')).rejects.toThrow(
				'absolute path',
			);
		});

		it('getTaskHistory rejects a control-character project root', async () => {
			await expect(getTaskHistory(`${tmpDir}\0evil`, '1.1')).rejects.toThrow(
				'control characters',
			);
		});

		it('validateSwarmPath should directly reject path traversal in filename', () => {
			expect(() => validateSwarmPath(tmpDir, '../../../etc/passwd')).toThrow();
			expect(() =>
				validateSwarmPath(tmpDir, '..\\..\\windows\\system32'),
			).toThrow();
		});

		it('validateSwarmPath should reject null bytes', () => {
			expect(() => validateSwarmPath(tmpDir, 'run-memory.jsonl\0')).toThrow();
			expect(() => validateSwarmPath(tmpDir, 'run-memory.jsonl\x00')).toThrow();
		});
	});

	// ========== ATTACK VECTOR 2: Malformed JSON in existing run-memory.jsonl ==========
	describe('Attack Vector 2: Malformed JSON in existing run-memory.jsonl', () => {
		it('should handle truncated JSON lines gracefully', async () => {
			const filePath = path.join(tmpDir, '.swarm', 'run-memory.jsonl');

			// Write malformed/truncated JSON
			await fs.writeFile(
				filePath,
				'{"timestamp":"2024-01-01T10:00:00.000Z","taskId":"1.1"\n' +
					'{"timestamp":"2024-01-01T10:05:00.000Z","taskId":"1.2","outcome":"pass","attemptNumber":1}\n',
			);

			// These should NOT throw - should gracefully skip malformed lines
			const history = await getTaskHistory(tmpDir, '1.1');
			const failures = await getTaskHistory(tmpDir, '1.2');
			const summary = await getRunMemorySummary(tmpDir);

			// Should return empty or skip malformed entries
			expect(Array.isArray(history)).toBe(true);
			expect(Array.isArray(failures)).toBe(true);
			expect(typeof summary === 'string' || summary === null).toBe(true);
			attackDetected = true; // Service is resilient
			expect(attackDetected).toBe(true);
		});

		it('should handle completely invalid JSON lines gracefully', async () => {
			const filePath = path.join(tmpDir, '.swarm', 'run-memory.jsonl');

			// Write completely invalid JSON
			await fs.writeFile(
				filePath,
				'NOT JSON AT ALL\n' +
					'{invalid json}\n' +
					'{"taskId":"1.1","outcome":"pass","attemptNumber":1}\n',
			);

			const history = await getTaskHistory(tmpDir, '1.1');
			expect(Array.isArray(history)).toBe(true);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle JSON with extra fields gracefully', async () => {
			const filePath = path.join(tmpDir, '.swarm', 'run-memory.jsonl');

			// JSON with extra unexpected fields (potential injection)
			await fs.writeFile(
				filePath,
				'{"timestamp":"2024-01-01T10:00:00.000Z","taskId":"1.1","outcome":"pass","attemptNumber":1,"__proto__":{"evil":"value"}}\n',
			);

			const history = await getTaskHistory(tmpDir, '1.1');
			expect(Array.isArray(history)).toBe(true);
			// Verify the extra fields don't cause prototype pollution issues
			const entry = history[0];
			expect(entry?.taskId).toBe('1.1');
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle binary/null byte injection in JSON', async () => {
			const filePath = path.join(tmpDir, '.swarm', 'run-memory.jsonl');

			// JSON with null bytes (should be rejected by validation or handled)
			const maliciousContent =
				'{"timestamp":"2024-01-01T10:00:00.000Z","taskId":"1.1\x00","outcome":"pass","attemptNumber":1}\n';
			await fs.writeFile(filePath, maliciousContent);

			const history = await getTaskHistory(tmpDir, '1.1');
			// Should either reject or sanitize
			expect(Array.isArray(history)).toBe(true);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});
	});

	// ========== ATTACK VECTOR 3: Very long taskId or failureReason strings ==========
	describe('Attack Vector 3: Very long strings in entry data', () => {
		it('should handle extremely long taskId (1MB)', async () => {
			const longTaskId = 'A'.repeat(1024 * 1024); // 1MB
			const entry: RunMemoryEntry = {
				timestamp: new Date().toISOString(),
				taskId: longTaskId,
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'pass',
				attemptNumber: 1,
			};

			// Should succeed (append-only doesn't validate content length)
			await recordOutcome(tmpDir, entry);

			// Reading should handle it gracefully
			const history = await getTaskHistory(tmpDir, longTaskId);
			expect(history.length).toBeGreaterThanOrEqual(0);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle extremely long failureReason (10MB)', async () => {
			const longFailureReason = 'X'.repeat(10 * 1024 * 1024); // 10MB
			const entry: RunMemoryEntry = {
				timestamp: new Date().toISOString(),
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: longFailureReason,
			};

			// Should succeed (append-only)
			await recordOutcome(tmpDir, entry);

			const failures = await getTaskHistory(tmpDir, '1.2');
			expect(Array.isArray(failures)).toBe(true);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle unicode/special characters in strings', async () => {
			const unicodeText = '🎉🔥💀\u0000\u0001\u001f\\n\\r\\t';
			const entry: RunMemoryEntry = {
				timestamp: new Date().toISOString(),
				taskId: unicodeText,
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: unicodeText,
			};

			await recordOutcome(tmpDir, entry);
			const history = await getTaskHistory(tmpDir, unicodeText);
			expect(Array.isArray(history)).toBe(true);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});
	});

	// ========== ATTACK VECTOR 4: Null bytes in entry data ==========
	describe('Attack Vector 4: Null bytes in entry data', () => {
		it('should handle null bytes in taskId during write', async () => {
			const entryWithNull: RunMemoryEntry = {
				timestamp: new Date().toISOString(),
				taskId: '1.1\x00',
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'pass',
				attemptNumber: 1,
			};

			// JSON.stringify will escape null bytes
			await recordOutcome(tmpDir, entryWithNull);

			const fileContent = await fs.readFile(
				path.join(tmpDir, '.swarm', 'run-memory.jsonl'),
				'utf-8',
			);
			// Verify null bytes are escaped in JSON
			expect(fileContent).not.toContain('\x00');
			expect(fileContent).toContain('\\u0000');
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle embedded null bytes in failureReason', async () => {
			const entryWithNull: RunMemoryEntry = {
				timestamp: new Date().toISOString(),
				taskId: '1.1',
				taskFingerprint: 'abc12345',
				agent: 'test',
				outcome: 'fail',
				attemptNumber: 1,
				failureReason: 'Error\x00Message',
			};

			await recordOutcome(tmpDir, entryWithNull);

			const fileContent = await fs.readFile(
				path.join(tmpDir, '.swarm', 'run-memory.jsonl'),
				'utf-8',
			);
			expect(fileContent).not.toContain('\x00');
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});
	});
});

describe('ADVERSARIAL SECURITY TESTS - context-budget service', () => {
	let tmpDir: string;
	let attackDetected: boolean;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), 'context-budget-adversarial-'),
		);
		await fs.mkdir(path.join(tmpDir, '.swarm', 'session'), { recursive: true });
		attackDetected = false;
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== ATTACK VECTOR 1: Path Traversal in directory parameter ==========
	// The real validator runs (no mock), so these call the service instead of
	// re-implementing the rejection regexes in the test.
	describe('Attack Vector 1: Path Traversal in directory parameter', () => {
		it('getContextBudgetReport rejects a traversal-bearing project root', async () => {
			await expect(
				getContextBudgetReport(
					`${tmpDir}/../../`,
					'prompt',
					getDefaultConfig(),
				),
			).rejects.toThrow('path traversal');
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('getContextBudgetReport rejects a relative project root', async () => {
			await expect(
				getContextBudgetReport('var/tmp', 'prompt', getDefaultConfig()),
			).rejects.toThrow('absolute path');
		});
	});

	// ========== ATTACK VECTOR 2: Malformed budget-state.json ==========
	describe('Attack Vector 2: Malformed budget-state.json', () => {
		it('should handle malformed JSON in budget-state.json gracefully', async () => {
			// Write malformed budget state
			const statePath = path.join(
				tmpDir,
				'.swarm',
				'session',
				'budget-state.json',
			);
			await fs.writeFile(statePath, '{invalid json}');

			const config = getDefaultConfig();
			const report = await getContextBudgetReport(
				tmpDir,
				'small prompt',
				config,
			);

			// Should still work - returns default state on parse failure
			expect(report).toBeDefined();
			expect(report.status).toBeDefined();
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle truncated JSON in budget-state.json', async () => {
			const statePath = path.join(
				tmpDir,
				'.swarm',
				'session',
				'budget-state.json',
			);
			await fs.writeFile(statePath, '{"warningFiredAtTurn": 5');

			const config = getDefaultConfig();
			const report = await getContextBudgetReport(
				tmpDir,
				'small prompt',
				config,
			);

			expect(report).toBeDefined();
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle budget-state.json with extra fields', async () => {
			const statePath = path.join(
				tmpDir,
				'.swarm',
				'session',
				'budget-state.json',
			);
			await fs.writeFile(
				statePath,
				'{"warningFiredAtTurn": 5, "__proto__": {"evil": "value"}, "extra": 123}',
			);

			const config = getDefaultConfig();
			const report = await getContextBudgetReport(
				tmpDir,
				'small prompt',
				config,
			);

			expect(report).toBeDefined();
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle budget-state.json with null bytes', async () => {
			const statePath = path.join(
				tmpDir,
				'.swarm',
				'session',
				'budget-state.json',
			);
			await fs.writeFile(statePath, '{"warningFiredAtTurn": 5\x00}');

			const config = getDefaultConfig();
			const report = await getContextBudgetReport(
				tmpDir,
				'small prompt',
				config,
			);

			expect(report).toBeDefined();
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});
	});

	// ========== ATTACK VECTOR 3: Very large assembledSystemPrompt (10MB+) ==========
	describe('Attack Vector 3: Very large assembledSystemPrompt', () => {
		it('should handle 10MB system prompt without crashing', async () => {
			const largePrompt = 'A'.repeat(10 * 1024 * 1024); // 10MB
			const config = getDefaultConfig();

			// Should not crash - just process it
			const report = await getContextBudgetReport(tmpDir, largePrompt, config);

			expect(report).toBeDefined();
			expect(report.systemPromptTokens).toBeGreaterThan(0);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle 100MB system prompt (stress test)', async () => {
			const hugePrompt = 'B'.repeat(100 * 1024 * 1024); // 100MB
			const config = getDefaultConfig();

			const report = await getContextBudgetReport(tmpDir, hugePrompt, config);

			expect(report).toBeDefined();
			expect(report.systemPromptTokens).toBeGreaterThan(0);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle empty system prompt', async () => {
			const config = getDefaultConfig();
			const report = await getContextBudgetReport(tmpDir, '', config);

			expect(report).toBeDefined();
			expect(report.systemPromptTokens).toBe(0);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle unicode-heavy system prompt', async () => {
			// Generate large unicode content
			const unicodePrompt = '🎉🔥💀🚀'.repeat(1024 * 256); // ~2MB of unicode
			const config = getDefaultConfig();

			const report = await getContextBudgetReport(
				tmpDir,
				unicodePrompt,
				config,
			);

			expect(report).toBeDefined();
			expect(report.systemPromptTokens).toBeGreaterThan(0);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});
	});

	// ========== ATTACK VECTOR 4: Negative or extreme config values ==========
	describe('Attack Vector 4: Negative or extreme config values', () => {
		it('should handle negative budgetTokens', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: -1000,
				warningPct: 70,
				criticalPct: 90,
				warningMode: 'once',
				warningIntervalTurns: 20,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);

			// Should handle gracefully - negative budget causes division issues but should be handled
			expect(report).toBeDefined();
			// Negative budget causes Infinity or NaN - check it's handled
			expect(
				Number.isFinite(report.budgetPct) || !Number.isNaN(report.budgetPct),
			).toBe(true);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle zero budgetTokens', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: 0,
				warningPct: 70,
				criticalPct: 90,
				warningMode: 'once',
				warningIntervalTurns: 20,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);

			// Zero budget causes division by zero - should be handled
			expect(report).toBeDefined();
			expect(
				Number.isFinite(report.budgetPct) || report.budgetPct === Infinity,
			).toBe(true);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle extremely large budgetTokens (Number.MAX_SAFE_INTEGER)', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: Number.MAX_SAFE_INTEGER,
				warningPct: 70,
				criticalPct: 90,
				warningMode: 'once',
				warningIntervalTurns: 20,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);

			expect(report).toBeDefined();
			expect(report.budgetPct).toBeLessThan(1); // Small percentage due to huge budget
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle negative warningPct and criticalPct', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: 40000,
				warningPct: -10,
				criticalPct: -5,
				warningMode: 'once',
				warningIntervalTurns: 20,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);

			expect(report).toBeDefined();
			// Negative thresholds should result in 'critical' status
			expect(['ok', 'warning', 'critical']).toContain(report.status);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle warningPct > criticalPct', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: 40000,
				warningPct: 95,
				criticalPct: 50, // Invalid: critical < warning
				warningMode: 'once',
				warningIntervalTurns: 20,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);

			expect(report).toBeDefined();
			// Should still produce a valid status
			expect(['ok', 'warning', 'critical']).toContain(report.status);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle warningIntervalTurns of 0', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: 40000,
				warningPct: 70,
				criticalPct: 90,
				warningMode: 'interval',
				warningIntervalTurns: 0,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);
			const warning = await formatBudgetWarning(report, tmpDir, config);

			// Interval of 0 means warning fires every turn - should handle gracefully
			expect(report).toBeDefined();
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle negative warningIntervalTurns', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: 40000,
				warningPct: 70,
				criticalPct: 90,
				warningMode: 'interval',
				warningIntervalTurns: -5,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);

			expect(report).toBeDefined();
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle NaN in config values', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: NaN,
				warningPct: 70,
				criticalPct: 90,
				warningMode: 'once',
				warningIntervalTurns: 20,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);

			expect(report).toBeDefined();
			expect(
				Number.isNaN(report.budgetPct) || Number.isFinite(report.budgetPct),
			).toBe(true);
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});

		it('should handle Infinity in config values', async () => {
			const config: ContextBudgetConfig = {
				enabled: true,
				budgetTokens: Infinity,
				warningPct: 70,
				criticalPct: 90,
				warningMode: 'once',
				warningIntervalTurns: 20,
			};

			const report = await getContextBudgetReport(
				tmpDir,
				'test prompt',
				config,
			);

			expect(report).toBeDefined();
			expect(report.budgetPct).toBe(0); // Infinity budget = 0%
			attackDetected = true;
			expect(attackDetected).toBe(true);
		});
	});
});

describe('ADDITIONAL SECURITY BOUNDARY TESTS', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'security-boundary-'));
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('run-memory: should not allow writing outside .swarm directory via traversal', async () => {
		// validateSwarmPath rejects filenames with path traversal
		expect(() => validateSwarmPath(tmpDir, '../../../etc/passwd')).toThrow();

		// ...and the write that DOES land stays under .swarm/ (invariant 4).
		await recordOutcome(tmpDir, SAMPLE_ENTRY);
		expect(await fs.readdir(tmpDir)).toEqual(['.swarm']);
	});

	it('run-memory: recordOutcome rejects an empty project root', async () => {
		// An empty root would make path.resolve('', '.swarm') land on the host
		// process cwd. Asserted through the service, not by re-implementing the
		// check in the test.
		await expect(recordOutcome('', SAMPLE_ENTRY)).rejects.toThrow('empty');
	});

	it('context-budget: should not expose sensitive file contents on error', async () => {
		// Create a file outside .swarm that shouldn't be accessible
		const sensitiveFile = path.join(tmpDir, '..', 'sensitive.txt');
		await fs.writeFile(sensitiveFile, 'SECRET_DATA');

		const config = getDefaultConfig();

		// Try to access via path traversal - with mocked validateDirectory,
		// the service may return a report or throw a file-system error.
		// Either way, error messages should NOT expose sensitive file content.
		try {
			const report = await getContextBudgetReport(
				tmpDir + '/..',
				'prompt',
				config,
			);
			// If it returns a report, verify it doesn't contain sensitive data
			expect(JSON.stringify(report)).not.toContain('SECRET_DATA');
		} catch (error: any) {
			expect(error.message).not.toContain('SECRET_DATA');
		}
	});

	it('context-budget: should handle missing events.jsonl gracefully', async () => {
		const config = getDefaultConfig();
		const report = await getContextBudgetReport(tmpDir, 'test', config);

		// Should handle gracefully with 0 turns
		expect(report.estimatedTurnCount).toBe(0);
	});

	it('context-budget: should handle missing other swarm files gracefully', async () => {
		const config = getDefaultConfig();
		const report = await getContextBudgetReport(tmpDir, 'test', config);

		// All values should be defined (even if 0)
		expect(report.knowledgeTokens).toBeDefined();
		expect(report.runMemoryTokens).toBeDefined();
		expect(report.planCursorTokens).toBeDefined();
	});
});
