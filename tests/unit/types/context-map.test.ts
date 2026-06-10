/**
 * Type safety tests for src/types/context-map.ts
 * Tests type shape, required/optional fields, and compile-time safety
 */

import { describe, expect, test } from 'bun:test';
import type {
	ContentHash,
	ContextMap,
	ContextMapStaleEntry,
	DecisionEntry,
	FileContextEntry,
	TaskContextSummary,
} from '../../../src/types/context-map';

describe('src/types/context-map.ts - TYPE SAFETY TESTS', () => {
	describe('ContentHash type', () => {
		test('ContentHash is a string type alias', () => {
			// ContentHash is a branded string type - verify it's assignable to string
			const hash: ContentHash = 'a'.repeat(64);
			const str: string = hash;
			expect(str).toBe('a'.repeat(64));
		});

		test('ContentHash accepts 64-character hex string', () => {
			// Valid SHA-256 hash format
			const hash: ContentHash =
				'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
			expect(hash).toHaveLength(64);
		});
	});

	describe('FileContextEntry interface', () => {
		test('accepts valid FileContextEntry with all required fields', () => {
			const entry: FileContextEntry = {
				path: 'src/utils/helper.ts',
				content_hash: 'abcd1234'.repeat(8),
				mtime_ms: 1700000000000,
				purpose: 'Provides utility functions',
				summary:
					'A helper module with various utility functions for string manipulation, date formatting, and common algorithms.',
			};

			expect(entry.path).toBe('src/utils/helper.ts');
			expect(entry.content_hash).toHaveLength(64);
			expect(entry.mtime_ms).toBe(1700000000000);
			expect(entry.purpose).toBe('Provides utility functions');
			expect(entry.summary).toContain('helper module');
		});

		test('accepts FileContextEntry with all optional fields', () => {
			const entry: FileContextEntry = {
				path: 'src/components/Button.tsx',
				content_hash: 'b'.repeat(64),
				mtime_ms: 1700000000000,
				language: 'typescript',
				purpose: 'Reusable button component',
				exports: ['Button', 'ButtonProps'],
				imports: ['react', './styles'],
				key_symbols: ['Button', 'ButtonProps'],
				invariants: ['Must be used with onClick handler'],
				risks: ['None identified'],
				tests: ['src/components/__tests__/Button.test.tsx'],
				last_seen_task_ids: ['1.2', '2.1'],
				summary:
					'A React button component with customizable variants and sizes.',
			};

			expect(entry.language).toBe('typescript');
			expect(entry.exports).toEqual(['Button', 'ButtonProps']);
			expect(entry.imports).toEqual(['react', './styles']);
			expect(entry.key_symbols).toEqual(['Button', 'ButtonProps']);
			expect(entry.invariants).toEqual(['Must be used with onClick handler']);
			expect(entry.risks).toEqual(['None identified']);
			expect(entry.tests).toEqual(['src/components/__tests__/Button.test.tsx']);
			expect(entry.last_seen_task_ids).toEqual(['1.2', '2.1']);
		});

		test('rejects FileContextEntry missing required fields', () => {
			// @ts-expect-error - path is required
			const missingPath: FileContextEntry = {
				content_hash: 'c'.repeat(64),
				mtime_ms: 1700000000000,
				purpose: 'Test',
				summary: 'Test summary',
			};

			// @ts-expect-error - content_hash is required
			const missingHash: FileContextEntry = {
				path: 'test.ts',
				mtime_ms: 1700000000000,
				purpose: 'Test',
				summary: 'Test summary',
			};

			// @ts-expect-error - mtime_ms is required
			const missingMtime: FileContextEntry = {
				path: 'test.ts',
				content_hash: 'c'.repeat(64),
				purpose: 'Test',
				summary: 'Test summary',
			};

			// @ts-expect-error - purpose is required
			const missingPurpose: FileContextEntry = {
				path: 'test.ts',
				content_hash: 'c'.repeat(64),
				mtime_ms: 1700000000000,
				summary: 'Test summary',
			};

			// @ts-expect-error - summary is required
			const missingSummary: FileContextEntry = {
				path: 'test.ts',
				content_hash: 'c'.repeat(64),
				mtime_ms: 1700000000000,
				purpose: 'Test',
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'malicious' should be rejected
			const polluted: FileContextEntry = {
				path: 'test.ts',
				content_hash: 'd'.repeat(64),
				mtime_ms: 1700000000000,
				purpose: 'Test',
				summary: 'Test summary',
				malicious: 'should not be allowed',
			};
		});
	});

	describe('TaskContextSummary interface', () => {
		test('accepts valid TaskContextSummary with required fields', () => {
			const summary: TaskContextSummary = {
				task_id: '1.1',
				goal: 'Implement user authentication',
				files_touched: ['src/auth/login.ts', 'src/auth/logout.ts'],
				final_status: 'approved',
			};

			expect(summary.task_id).toBe('1.1');
			expect(summary.goal).toBe('Implement user authentication');
			expect(summary.files_touched).toEqual([
				'src/auth/login.ts',
				'src/auth/logout.ts',
			]);
			expect(summary.final_status).toBe('approved');
		});

		test('accepts TaskContextSummary with all optional fields', () => {
			const summary: TaskContextSummary = {
				task_id: '2.3',
				goal: 'Refactor database layer',
				files_touched: ['src/db/connection.ts'],
				implementation_summary:
					'Migrated from callbacks to async/await pattern',
				reviewer_findings: [
					'Code is well-structured',
					'Tests are comprehensive',
				],
				critic_findings: ['Consider adding index on email column'],
				test_findings: ['All 47 tests pass'],
				final_status: 'approved',
			};

			expect(summary.implementation_summary).toBe(
				'Migrated from callbacks to async/await pattern',
			);
			expect(summary.reviewer_findings).toEqual([
				'Code is well-structured',
				'Tests are comprehensive',
			]);
			expect(summary.critic_findings).toEqual([
				'Consider adding index on email column',
			]);
			expect(summary.test_findings).toEqual(['All 47 tests pass']);
		});

		test('final_status accepts all four valid values', () => {
			const statuses: TaskContextSummary['final_status'][] = [
				'pending',
				'approved',
				'rejected',
				'blocked',
			];

			expect(statuses).toHaveLength(4);

			const pendingTask: TaskContextSummary = {
				task_id: '1.1',
				goal: 'Test pending',
				files_touched: [],
				final_status: 'pending',
			};
			expect(pendingTask.final_status).toBe('pending');

			const approvedTask: TaskContextSummary = {
				task_id: '1.2',
				goal: 'Test approved',
				files_touched: [],
				final_status: 'approved',
			};
			expect(approvedTask.final_status).toBe('approved');

			const rejectedTask: TaskContextSummary = {
				task_id: '1.3',
				goal: 'Test rejected',
				files_touched: [],
				final_status: 'rejected',
			};
			expect(rejectedTask.final_status).toBe('rejected');

			const blockedTask: TaskContextSummary = {
				task_id: '1.4',
				goal: 'Test blocked',
				files_touched: [],
				final_status: 'blocked',
			};
			expect(blockedTask.final_status).toBe('blocked');
		});

		test('rejects invalid final_status values', () => {
			// @ts-expect-error - 'invalid' is not a valid final_status
			const invalidTask: TaskContextSummary = {
				task_id: '1.1',
				goal: 'Test',
				files_touched: [],
				final_status: 'invalid',
			};

			// @ts-expect-error - 'completed' is not a valid final_status
			const completedTask: TaskContextSummary = {
				task_id: '1.2',
				goal: 'Test',
				files_touched: [],
				final_status: 'completed',
			};
		});

		test('rejects TaskContextSummary missing required fields', () => {
			// @ts-expect-error - task_id is required
			const missingTaskId: TaskContextSummary = {
				goal: 'Test',
				files_touched: [],
				final_status: 'pending',
			};

			// @ts-expect-error - goal is required
			const missingGoal: TaskContextSummary = {
				task_id: '1.1',
				files_touched: [],
				final_status: 'pending',
			};

			// @ts-expect-error - files_touched is required
			const missingFiles: TaskContextSummary = {
				task_id: '1.1',
				goal: 'Test',
				final_status: 'pending',
			};

			// @ts-expect-error - final_status is required
			const missingStatus: TaskContextSummary = {
				task_id: '1.1',
				goal: 'Test',
				files_touched: [],
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'extraField' should be rejected
			const polluted: TaskContextSummary = {
				task_id: '1.1',
				goal: 'Test',
				files_touched: [],
				final_status: 'pending',
				extraField: 'should not be allowed',
			};
		});
	});

	describe('DecisionEntry interface', () => {
		test('accepts valid DecisionEntry with required fields', () => {
			const decision: DecisionEntry = {
				id: 'D1',
				decision: 'Use SQLite for local development',
				rationale: 'Simpler setup, zero configuration, file-based',
				timestamp: '2024-01-15T10:30:00Z',
			};

			expect(decision.id).toBe('D1');
			expect(decision.decision).toBe('Use SQLite for local development');
			expect(decision.rationale).toBe(
				'Simpler setup, zero configuration, file-based',
			);
			expect(decision.timestamp).toBe('2024-01-15T10:30:00Z');
		});

		test('accepts DecisionEntry with optional fields', () => {
			const decision: DecisionEntry = {
				id: 'D2',
				decision: 'Use Redis for session caching',
				rationale: 'High performance, native session support',
				timestamp: '2024-01-16T14:00:00Z',
				task_id: '2.1',
				phase: 2,
			};

			expect(decision.task_id).toBe('2.1');
			expect(decision.phase).toBe(2);
		});

		test('rejects DecisionEntry missing required fields', () => {
			// @ts-expect-error - id is required
			const missingId: DecisionEntry = {
				decision: 'Test',
				rationale: 'Test rationale',
				timestamp: '2024-01-01T00:00:00Z',
			};

			// @ts-expect-error - decision is required
			const missingDecision: DecisionEntry = {
				id: 'D1',
				rationale: 'Test rationale',
				timestamp: '2024-01-01T00:00:00Z',
			};

			// @ts-expect-error - rationale is required
			const missingRationale: DecisionEntry = {
				id: 'D1',
				decision: 'Test decision',
				timestamp: '2024-01-01T00:00:00Z',
			};

			// @ts-expect-error - timestamp is required
			const missingTimestamp: DecisionEntry = {
				id: 'D1',
				decision: 'Test decision',
				rationale: 'Test rationale',
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'extraField' should be rejected
			const polluted: DecisionEntry = {
				id: 'D1',
				decision: 'Test',
				rationale: 'Test rationale',
				timestamp: '2024-01-01T00:00:00Z',
				extraField: 'should not be allowed',
			};
		});
	});

	describe('ContextMap interface', () => {
		test('accepts valid ContextMap with required fields', () => {
			const contextMap: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				task_history: {},
				decisions: [],
			};

			expect(contextMap.schema_version).toBe(1);
			expect(contextMap.generated_at).toBe('2024-01-20T12:00:00Z');
			expect(contextMap.files).toEqual({});
			expect(contextMap.task_history).toEqual({});
			expect(contextMap.decisions).toEqual([]);
		});

		test('accepts ContextMap with populated entries', () => {
			const contextMap: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				repo_fingerprint: 'abc123def456',
				files: {
					'src/index.ts': {
						path: 'src/index.ts',
						content_hash: 'e'.repeat(64),
						mtime_ms: 1700000000000,
						purpose: 'Main entry point',
						summary: 'The main entry point for the application.',
					},
				},
				task_history: {
					'1.1': {
						task_id: '1.1',
						goal: 'Initial setup',
						files_touched: ['src/index.ts'],
						final_status: 'approved',
					},
				},
				decisions: [
					{
						id: 'D1',
						decision: 'Use TypeScript',
						rationale: 'Type safety',
						timestamp: '2024-01-01T00:00:00Z',
					},
				],
			};

			expect(Object.keys(contextMap.files)).toHaveLength(1);
			expect(Object.keys(contextMap.task_history)).toHaveLength(1);
			expect(contextMap.decisions).toHaveLength(1);
			expect(contextMap.repo_fingerprint).toBe('abc123def456');
		});

		test('schema_version is constrained to literal 1', () => {
			// @ts-expect-error - schema_version must be exactly 1, not number variable
			const wrongVersion: ContextMap = {
				schema_version: 2, // Must be literal 1
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				task_history: {},
				decisions: [],
			};

			// @ts-expect-error - schema_version must be exactly 1
			const stringVersion: ContextMap = {
				schema_version: '1', // Must be number, not string
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				task_history: {},
				decisions: [],
			};
		});

		test('rejects ContextMap missing required fields', () => {
			// @ts-expect-error - schema_version is required
			const missingVersion: ContextMap = {
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				task_history: {},
				decisions: [],
			};

			// @ts-expect-error - generated_at is required
			const missingGeneratedAt: ContextMap = {
				schema_version: 1,
				files: {},
				task_history: {},
				decisions: [],
			};

			// @ts-expect-error - files is required
			const missingFiles: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				task_history: {},
				decisions: [],
			};

			// @ts-expect-error - task_history is required
			const missingTaskHistory: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				decisions: [],
			};

			// @ts-expect-error - decisions is required
			const missingDecisions: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				task_history: {},
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'extraField' should be rejected
			const polluted: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				task_history: {},
				decisions: [],
				extraField: 'should not be allowed',
			};
		});
	});

	describe('ContextMapStaleEntry interface', () => {
		test('accepts valid ContextMapStaleEntry with required fields', () => {
			const staleEntry: ContextMapStaleEntry = {
				path: 'src/config/settings.ts',
				old_hash: 'f'.repeat(64),
				detected_at: '2024-01-25T08:00:00Z',
			};

			expect(staleEntry.path).toBe('src/config/settings.ts');
			expect(staleEntry.old_hash).toHaveLength(64);
			expect(staleEntry.detected_at).toBe('2024-01-25T08:00:00Z');
		});

		test('rejects ContextMapStaleEntry missing required fields', () => {
			// @ts-expect-error - path is required
			const missingPath: ContextMapStaleEntry = {
				old_hash: 'g'.repeat(64),
				detected_at: '2024-01-25T08:00:00Z',
			};

			// @ts-expect-error - old_hash is required
			const missingHash: ContextMapStaleEntry = {
				path: 'test.ts',
				detected_at: '2024-01-25T08:00:00Z',
			};

			// @ts-expect-error - detected_at is required
			const missingDetectedAt: ContextMapStaleEntry = {
				path: 'test.ts',
				old_hash: 'g'.repeat(64),
			};
		});

		test('rejects extra fields not in interface', () => {
			// @ts-expect-error - Extra field 'extraField' should be rejected
			const polluted: ContextMapStaleEntry = {
				path: 'test.ts',
				old_hash: 'h'.repeat(64),
				detected_at: '2024-01-25T08:00:00Z',
				extraField: 'should not be allowed',
			};
		});
	});

	describe('Type narrowing and compile-time safety', () => {
		test('ContentHash can be used in Record keys', () => {
			const hashMap: Record<ContentHash, string> = {};
			const hash: ContentHash = 'i'.repeat(64);
			hashMap[hash] = 'file.ts';
			expect(hashMap[hash]).toBe('file.ts');
		});

		test('ContextMap files field accepts FileContextEntry', () => {
			const fileEntry: FileContextEntry = {
				path: 'src/test.ts',
				content_hash: 'j'.repeat(64),
				mtime_ms: 1700000000000,
				purpose: 'Test file',
				summary: 'A test file for unit testing.',
			};

			const contextMap: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				files: {
					'src/test.ts': fileEntry,
				},
				task_history: {},
				decisions: [],
			};

			expect(contextMap.files['src/test.ts'].purpose).toBe('Test file');
		});

		test('ContextMap task_history field accepts TaskContextSummary', () => {
			const taskSummary: TaskContextSummary = {
				task_id: '3.1',
				goal: 'Integration testing',
				files_touched: ['tests/integration/api.test.ts'],
				final_status: 'pending',
			};

			const contextMap: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				task_history: {
					'3.1': taskSummary,
				},
				decisions: [],
			};

			expect(contextMap.task_history['3.1'].final_status).toBe('pending');
		});

		test('ContextMap decisions field accepts DecisionEntry', () => {
			const decision: DecisionEntry = {
				id: 'D5',
				decision: 'Adopt hexagonal architecture',
				rationale: 'Better separation of concerns',
				timestamp: '2024-02-01T09:00:00Z',
				phase: 3,
			};

			const contextMap: ContextMap = {
				schema_version: 1,
				generated_at: '2024-01-20T12:00:00Z',
				files: {},
				task_history: {},
				decisions: [decision],
			};

			expect(contextMap.decisions[0].id).toBe('D5');
		});

		test('all six exported types are importable', () => {
			// Verify all types can be referenced
			const types = [
				{} as ContentHash,
				{} as FileContextEntry,
				{} as TaskContextSummary,
				{} as DecisionEntry,
				{} as ContextMap,
				{} as ContextMapStaleEntry,
			];
			expect(types).toHaveLength(6);
		});
	});
});
