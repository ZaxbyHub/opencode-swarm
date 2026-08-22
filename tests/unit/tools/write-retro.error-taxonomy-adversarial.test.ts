/**
 * Adversarial tests for executeWriteRetro error taxonomy classification.
 * Attack vectors: malformed evidence bundles, type coercion, prototype pollution,
 * oversized payloads, ReDoS, circular references.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Define the args type locally to avoid import issues with await import
interface WriteRetroArgs {
	phase: number;
	verdict?: 'pass' | 'fail';
	summary: string;
	task_count: number;
	task_complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
	total_tool_calls: number;
	coder_revisions: number;
	reviewer_rejections: number;
	loop_detections?: number;
	circuit_breaker_trips?: number;
	test_failures: number;
	security_findings: number;
	integration_issues: number;
	lessons_learned?: string[];
	top_rejection_reasons?: string[];
	task_id?: string;
	metadata?: Record<string, unknown>;
}

// Mock loadEvidence, saveEvidence, and listEvidenceTaskIds from evidence/manager
const mockLoadEvidence =
	vi.fn<
		(
			dir: string,
			taskId: string,
		) => Promise<
			| {
					status: 'found';
					bundle: {
						schema_version: string;
						task_id: string;
						created_at: string;
						updated_at: string;
						entries: Array<Record<string, unknown>>;
					};
			  }
			| { status: 'not_found' }
			| { status: 'invalid_schema'; errors: string[] }
		>
	>();
const mockSaveEvidence =
	vi.fn<(dir: string, taskId: string, entry: unknown) => Promise<void>>();
const mockListEvidenceTaskIds = vi.fn<(dir: string) => Promise<string[]>>();

vi.mock('../../../src/evidence/manager.js', () => ({
	loadEvidence: (...args: unknown[]) =>
		mockLoadEvidence(...(args as [string, string])),
	saveEvidence: (...args: unknown[]) =>
		mockSaveEvidence(...(args as [string, string, unknown])),
	listEvidenceTaskIds: (...args: unknown[]) =>
		mockListEvidenceTaskIds(...(args as [string])),
}));

// Import after mocking
const { executeWriteRetro } = await import('../../../src/tools/write-retro.js');

/**
 * Helper to create valid base args
 */
function makeArgs(overrides: Partial<WriteRetroArgs> = {}): WriteRetroArgs {
	return {
		phase: 3,
		verdict: 'pass',
		summary: 'Test phase completed',
		task_count: 5,
		task_complexity: 'moderate',
		total_tool_calls: 100,
		coder_revisions: 2,
		reviewer_rejections: 1,
		test_failures: 0,
		security_findings: 0,
		integration_issues: 0,
		...overrides,
	};
}

describe('Adversarial: executeWriteRetro error taxonomy classification', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'write-retro-taxonomy-adversarial-'),
			),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		// Default: return task IDs 3.1-3.5 for phase 3 (most tests use phase 3)
		mockListEvidenceTaskIds.mockResolvedValue([
			'3.1',
			'3.2',
			'3.3',
			'3.4',
			'3.5',
		]);
		// Default loadEvidence to not_found (individual tests override as needed)
		mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// --- TEST 1: Oversized summary string (10,000+ chars) ---
	test('1. Oversized summary (10k+ chars) — should not crash or hang', async () => {
		const longSummary = 'A'.repeat(15000);
		const args = makeArgs({ summary: longSummary });

		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(args, tempDir);

		// Should succeed (summary can be arbitrarily long)
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 2: Deeply nested issues array (100+ items) ---
	test('2. Deeply nested issues array (100+ items) — should not hang', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 'fail',
								summary: 'Multiple issues found',
								issues: Array.from({ length: 150 }, (_, i) => ({
									message: `Issue ${i}: Something went wrong`,
									severity: 'error',
								})),
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		// Taxonomy should classify this as logic_error (no interface keywords)
		expect(mockSaveEvidence).toHaveBeenCalled();
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toContain('logic_error');
	});

	// --- TEST 3: Verdict as number instead of string (type coercion) ---
	test('3. Verdict as number instead of string — should skip, not crash', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 0 as unknown as string, // number instead of string
								summary: 'Rejection',
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		// Should not throw — verdict check is === 'fail' which number 0 won't match
		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		// No taxonomy entries since verdict wasn't 'fail' (0 !== 'fail')
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toEqual([]);
	});

	// --- TEST 4: Type set to __proto__ or constructor (prototype pollution) ---
	test('4. Type set to __proto__ — prototype pollution attempt', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: '__proto__',
								verdict: 'fail',
								summary: 'Pollution attempt',
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		// __proto__ type won't match any classification branch
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toEqual([]);
	});

	test('4b. Type set to constructor — prototype pollution attempt', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'constructor',
								verdict: 'fail',
								summary: 'Pollution attempt',
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toEqual([]);
	});

	// --- TEST 5: Issues as string instead of array ---
	test('5. Issues as string instead of array — should not crash', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 'fail',
								summary: 'Rejection',
								issues: 'not an array' as unknown as unknown[],
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		// Array.isArray check should skip the issues string
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toContain('logic_error');
	});

	// --- TEST 6: Summary set to object instead of string ---
	test('6. Summary as object instead of string — should not crash', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 'fail',
								summary: { nested: 'object' } as unknown as string,
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		// typeof check should prevent string concatenation
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toContain('logic_error');
	});

	// --- TEST 7: Phase number 999999 (task IDs 999999.1 through 999999.5) ---
	test('7. Phase 999999 — should be rejected at validation', async () => {
		const args = makeArgs({ phase: 999999 });

		const result = await executeWriteRetro(args, tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('Invalid phase');
		expect(mockLoadEvidence).not.toHaveBeenCalled();
	});

	// --- TEST 8: Phase number -1 (task IDs like "-1.1") ---
	test('8. Phase -1 — should be rejected at validation', async () => {
		const args = makeArgs({ phase: -1 });

		const result = await executeWriteRetro(args, tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('Invalid phase');
		expect(mockLoadEvidence).not.toHaveBeenCalled();
	});

	// --- TEST 9: Phase number 0 (task IDs "0.1" through "0.5") ---
	test('9. Phase 0 — should be rejected at validation (must be positive integer >= 1)', async () => {
		const args = makeArgs({ phase: 0 });

		const result = await executeWriteRetro(args, tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain('Invalid phase');
		expect(mockLoadEvidence).not.toHaveBeenCalled();
	});

	// --- TEST 10: Entries as non-array type ---
	test('10. Entries as non-array (object) — should handle gracefully', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: { not: 'an array' } as unknown as unknown[],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		// Should not crash — for-of on non-array does nothing
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	test('10b. Entries as string instead of array', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: 'not an array' as unknown as unknown[],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	test('10c. Entries as null', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: null as unknown as unknown[],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 11: ReDoS pattern in summary ---
	test('11. ReDoS pattern in summary — should complete quickly (string is short)', async () => {
		// Short string with interface keyword - won't cause ReDoS
		const redoSsummary = 'Interface type mismatch'.repeat(5);

		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 'fail',
								summary: redoSsummary,
								issues: [],
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const start = Date.now();
		const result = await executeWriteRetro(makeArgs(), tempDir);
		const elapsed = Date.now() - start;

		// Should complete quickly
		expect(elapsed).toBeLessThan(1000);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		// Should detect 'interface' in summary
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toContain('interface_mismatch');
	});

	// --- TEST 12: Circular reference in entries ---
	test('12. Circular reference in entries — should be handled gracefully', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				const circularEntry: Record<string, unknown> = {
					task_id: '3.1',
					type: 'review',
					verdict: 'fail',
					summary: 'Circular reference test',
				};
				// Create circular reference
				circularEntry.self = circularEntry;
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [circularEntry],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		// Should not hang or crash — for-of iterates safely
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 13: loadEvidence throws an error ---
	test('13. loadEvidence throws — should be non-fatal, taxonomy stays empty', async () => {
		mockLoadEvidence.mockRejectedValueOnce(new Error('File system error'));
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		// Taxonomy should be empty due to error
		expect(savedEntry.error_taxonomy).toEqual([]);
	});

	// --- TEST 14: Malformed entries with prototype-polluting keys in issues ---
	test('14. Issues item with __proto__.message — should not pollute taxonomy', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 'fail',
								summary: 'Review found problems in logic',
								issues: [
									{ message: 'Normal issue' },
									{ __proto__: { polluted: true } },
								],
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		// Should have logic_error (not polluted)
		expect(savedEntry.error_taxonomy).toContain('logic_error');
		// Verify no pollution in taxonomy array
		expect(savedEntry.error_taxonomy).not.toContain('polluted');
	});

	// --- TEST 15: Extremely large issues array with __proto__ keys ---
	test('15. Large issues array with __proto__ keys — should not pollute', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				// Create 100 issues, some with __proto__ keys
				const issues = Array.from({ length: 100 }, (_, i) => ({
					message: `Issue ${i}`,
					...(i === 50 ? { __proto__: { test: 'polluted' } } : {}),
				}));
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 'fail',
								summary: 'Many issues',
								issues,
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toContain('logic_error');
		// Verify no prototype pollution
		expect(savedEntry.polluted).toBeUndefined();
	});

	// --- TEST 16: Entry with agent as __proto__ (pollution attempt) ---
	test('16. Entry with agent __proto__ — should be skipped safely', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								agent: '__proto__',
								verdict: 'fail',
								type: 'review',
								summary: 'Agent as __proto__',
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 17: NaN verdict (type coercion edge case) ---
	test('17. Verdict as NaN — should not crash', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: NaN as unknown as string,
								summary: 'NaN verdict',
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 18: Infinity verdict (type coercion edge case) ---
	test('18. Verdict as Infinity — should not crash', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: Infinity as unknown as string,
								summary: 'Infinity verdict',
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 19: Multiple entries with mixed types ---
	test('19. Multiple entries with mixed types — should process valid ones', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 'fail',
								summary: 'Signature type error',
								issues: [],
							},
							{ task_id: '3.1', type: 'test', verdict: 'fail', issues: [] },
							{
								task_id: '3.1',
								agent: 'scope_guard',
								verdict: 'fail',
								issues: [],
							},
							{
								task_id: '3.1',
								agent: 'loop_detector',
								verdict: 'fail',
								issues: [],
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		// All four error types should be captured (deduplicated)
		expect(savedEntry.error_taxonomy).toContain('interface_mismatch');
		expect(savedEntry.error_taxonomy).toContain('logic_error');
		const taxonomy = savedEntry.error_taxonomy as string[];
		expect(taxonomy).toContain('scope_creep');
		expect(taxonomy).toContain('gate_evasion');
		// But only 4 unique entries
		expect(taxonomy.length).toBe(4);
	});

	// --- TEST 20: Entry with undefined verdict (type coercion edge case) ---
	test('20. Verdict as undefined — should not crash', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: undefined,
								summary: 'Undefined verdict',
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 21: Empty entries array ---
	test('21. Empty entries array — should handle gracefully', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toEqual([]);
	});

	// --- TEST 22: Issues with Symbol keys (edge case) ---
	test('22. Issues item with Symbol key — should not crash', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: 'review',
								verdict: 'fail',
								summary: 'Symbol key test',
								issues: [
									{ message: 'Issue 1' },
									{ [Symbol('test')]: 'symbol key' },
								],
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 23: Function as type (edge case) ---
	test('23. Type as function instead of string — should not crash', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: '3.1',
								type: (() => 'review') as unknown as string,
								verdict: 'fail',
								summary: 'Function type',
							},
						],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 24: Very deep recursion in entry nesting ---
	test('24. Deeply nested entry object — should not cause stack overflow', async () => {
		function createNestedObject(
			depth: number,
			current: Record<string, unknown>,
		): Record<string, unknown> {
			if (depth === 0) return current;
			return createNestedObject(depth - 1, { nested: current });
		}

		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				const deeplyNested = createNestedObject(50, {
					type: 'review',
					verdict: 'fail',
					summary: 'Deep nesting test',
				});
				return {
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '3.1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [{ task_id: '3.1', ...deeplyNested }],
					},
				};
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		// Should complete without stack overflow
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
	});

	// --- TEST 25: Bundle with getter that throws ---
	test('25. Bundle entries has getter that throws — should be non-fatal', async () => {
		mockLoadEvidence.mockImplementation(async (dir: string, taskId: string) => {
			if (taskId === '3.1') {
				const problematicBundle = {
					schema_version: '1.0.0',
					task_id: '3.1',
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					get entries() {
						throw new Error('Getter failed');
					},
				};
				return { status: 'found', bundle: problematicBundle };
			}
			return { status: 'not_found' };
		});
		mockSaveEvidence.mockResolvedValueOnce(undefined);

		const result = await executeWriteRetro(makeArgs(), tempDir);

		// Should be non-fatal due to try-catch in executeWriteRetro
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(mockSaveEvidence).toHaveBeenCalled();
		const savedEntry = mockSaveEvidence.mock.calls[0][2] as Record<
			string,
			unknown
		>;
		expect(savedEntry.error_taxonomy).toEqual([]);
	});
});
