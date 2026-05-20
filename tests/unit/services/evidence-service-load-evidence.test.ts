import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	Evidence,
	EvidenceBundle,
} from '../../../src/config/evidence-schema';
import type { LoadEvidenceResult } from '../../../src/evidence/manager';
import {
	_internals,
	getEvidenceListData,
	getTaskEvidenceData,
} from '../../../src/services/evidence-service';

let mockLoadEvidence: ReturnType<typeof mock>;
let mockListEvidenceTaskIds: ReturnType<typeof mock>;
let originalLoadEvidence: typeof _internals.loadEvidence;
let originalListEvidenceTaskIds: typeof _internals.listEvidenceTaskIds;

let testDir: string;

function createMockEvidenceBundle(
	overrides: Partial<EvidenceBundle> = {},
): EvidenceBundle {
	return {
		schema_version: '1.0.0',
		task_id: 'test-task',
		entries: [],
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		...overrides,
	};
}

function createMockEvidence(overrides: Partial<Evidence> = {}): Evidence {
	return {
		task_id: 'test-task',
		type: 'review',
		timestamp: '2024-01-01T00:00:00.000Z',
		agent: 'test-agent',
		verdict: 'pass',
		summary: 'Test evidence',
		...overrides,
	} as Evidence;
}

beforeEach(() => {
	originalLoadEvidence = _internals.loadEvidence;
	originalListEvidenceTaskIds = _internals.listEvidenceTaskIds;
	mockLoadEvidence = mock();
	mockListEvidenceTaskIds = mock();
	_internals.loadEvidence = mockLoadEvidence;
	_internals.listEvidenceTaskIds = mockListEvidenceTaskIds;

	testDir = join(
		tmpdir(),
		`evidence-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	_internals.loadEvidence = originalLoadEvidence;
	_internals.listEvidenceTaskIds = originalListEvidenceTaskIds;
	rmSync(testDir, { recursive: true, force: true });
});

describe('getTaskEvidenceData with discriminated union loadEvidence', () => {
	describe('when loadEvidence returns "found" status', () => {
		test('should return hasEvidence: true with bundle data', async () => {
			const mockBundle = createMockEvidenceBundle({
				task_id: '1.1',
				entries: [
					createMockEvidence({
						task_id: '1.1',
						type: 'review',
						verdict: 'pass',
						summary: 'Code review passed',
					}),
				],
				created_at: '2024-01-15T10:30:00.000Z',
				updated_at: '2024-01-15T11:45:00.000Z',
			});

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: mockBundle,
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, '1.1');

			expect(result.hasEvidence).toBe(true);
			expect(result.taskId).toBe('1.1');
			expect(result.createdAt).toBe('2024-01-15T10:30:00.000Z');
			expect(result.updatedAt).toBe('2024-01-15T11:45:00.000Z');
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].type).toBe('review');
			expect(result.entries[0].verdict).toBe('pass');
			expect(result.entries[0].summary).toBe('Code review passed');
		});

		test('should format multiple evidence entries correctly', async () => {
			const mockBundle = createMockEvidenceBundle({
				entries: [
					createMockEvidence({
						type: 'review',
						verdict: 'pass',
						summary: 'Review entry',
						agent: 'reviewer',
					}),
					createMockEvidence({
						type: 'test',
						verdict: 'fail',
						summary: 'Test entry',
						agent: 'tester',
					}),
					createMockEvidence({
						type: 'diff',
						verdict: 'info',
						summary: 'Diff entry',
						agent: 'coder',
					}),
				],
			});

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: mockBundle,
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'test-task');

			expect(result.hasEvidence).toBe(true);
			expect(result.entries).toHaveLength(3);
			expect(result.entries[0].index).toBe(1);
			expect(result.entries[0].type).toBe('review');
			expect(result.entries[1].index).toBe(2);
			expect(result.entries[1].type).toBe('test');
			expect(result.entries[2].index).toBe(3);
			expect(result.entries[2].type).toBe('diff');
		});

		test('should handle empty entries array', async () => {
			const mockBundle = createMockEvidenceBundle({
				entries: [],
			});

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: mockBundle,
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'empty-task');

			expect(result.hasEvidence).toBe(true);
			expect(result.entries).toHaveLength(0);
			expect(result.taskId).toBe('empty-task');
		});
	});

	describe('when loadEvidence returns "not_found" status', () => {
		test('should return hasEvidence: false with empty entries', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'nonexistent');

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe('nonexistent');
			expect(result.createdAt).toBe('');
			expect(result.updatedAt).toBe('');
			expect(result.entries).toHaveLength(0);
		});
	});

	describe('when loadEvidence returns "invalid_schema" status', () => {
		test('should return hasEvidence: false with empty entries', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'invalid_schema',
				errors: ['schema_version: Invalid enum value', 'task_id: Required'],
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'invalid-task');

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe('invalid-task');
			expect(result.createdAt).toBe('');
			expect(result.updatedAt).toBe('');
			expect(result.entries).toHaveLength(0);
		});

		test('should ignore error details and just return default structure', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'invalid_schema',
				errors: ['Multiple validation errors'],
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'invalid-task');

			// Should not throw, just return safe default
			expect(result.hasEvidence).toBe(false);
			expect(result.entries).toHaveLength(0);
		});
	});

	describe('type-specific evidence formatting', () => {
		test('should format review evidence with details', async () => {
			const reviewEvidence = createMockEvidence({
				type: 'review',
				verdict: 'fail',
				risk: 'high',
				issues: [
					{
						severity: 'error',
						message: 'Security vulnerability',
						file: 'src/auth.ts',
						line: 42,
					},
				],
			});

			const mockBundle = createMockEvidenceBundle({
				entries: [reviewEvidence],
			});

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: mockBundle,
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'review-task');

			expect(result.entries[0].type).toBe('review');
			expect(result.entries[0].details.risk).toBe('high');
			expect(result.entries[0].details.issues).toBe(1);
		});

		test('should format test evidence with details', async () => {
			const testEvidence = createMockEvidence({
				type: 'test',
				verdict: 'fail',
				tests_passed: 10,
				tests_failed: 3,
				failures: [{ name: 'testAuth', message: 'Expected 200 got 401' }],
			});

			const mockBundle = createMockEvidenceBundle({
				entries: [testEvidence],
			});

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: mockBundle,
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'test-task');

			expect(result.entries[0].type).toBe('test');
			expect(result.entries[0].details.tests_passed).toBe(10);
			expect(result.entries[0].details.tests_failed).toBe(3);
		});

		test('should handle evidence without type-specific details', async () => {
			const noteEvidence = createMockEvidence({
				type: 'note',
				verdict: 'info',
			});

			const mockBundle = createMockEvidenceBundle({
				entries: [noteEvidence],
			});

			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: mockBundle,
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'note-task');

			expect(result.entries[0].type).toBe('note');
			// details object should exist but be mostly empty for non-review/test types
			expect(result.entries[0].details).toBeDefined();
		});
	});
});

describe('getEvidenceListData with discriminated union loadEvidence', () => {
	describe('when no task IDs exist', () => {
		test('should return hasEvidence: false with empty tasks array', async () => {
			mockListEvidenceTaskIds.mockResolvedValue([]);

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(false);
			expect(result.tasks).toHaveLength(0);
			expect(mockLoadEvidence).not.toHaveBeenCalled();
		});
	});

	describe('when loadEvidence returns "found" status for tasks', () => {
		test('should populate tasks with entryCount and lastUpdated from bundle', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['1.1', '1.2', '2.1']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'found',
					bundle: createMockEvidenceBundle({
						task_id: '1.1',
						entries: [createMockEvidence(), createMockEvidence()],
						updated_at: '2024-01-15T10:00:00.000Z',
					}),
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'found',
					bundle: createMockEvidenceBundle({
						task_id: '1.2',
						entries: [createMockEvidence()],
						updated_at: '2024-01-16T12:30:00.000Z',
					}),
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'found',
					bundle: createMockEvidenceBundle({
						task_id: '2.1',
						entries: [],
						updated_at: '2024-01-17T08:45:00.000Z',
					}),
				} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(3);
			expect(result.tasks[0]).toEqual({
				taskId: '1.1',
				entryCount: 2,
				lastUpdated: '2024-01-15T10:00:00.000Z',
			});
			expect(result.tasks[1]).toEqual({
				taskId: '1.2',
				entryCount: 1,
				lastUpdated: '2024-01-16T12:30:00.000Z',
			});
			expect(result.tasks[2]).toEqual({
				taskId: '2.1',
				entryCount: 0,
				lastUpdated: '2024-01-17T08:45:00.000Z',
			});
		});
	});

	describe('when loadEvidence returns "not_found" status', () => {
		test('should fallback to entryCount: 0 and lastUpdated: "unknown"', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['1.1', 'missing-task']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'found',
					bundle: createMockEvidenceBundle({
						task_id: '1.1',
						entries: [createMockEvidence()],
						updated_at: '2024-01-15T10:00:00.000Z',
					}),
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(2);
			expect(result.tasks[0]).toEqual({
				taskId: '1.1',
				entryCount: 1,
				lastUpdated: '2024-01-15T10:00:00.000Z',
			});
			expect(result.tasks[1]).toEqual({
				taskId: 'missing-task',
				entryCount: 0,
				lastUpdated: 'unknown',
			});
		});
	});

	describe('when loadEvidence returns "invalid_schema" status', () => {
		test('should fallback to entryCount: 0 and lastUpdated: "unknown"', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['valid-task', 'invalid-task']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'found',
					bundle: createMockEvidenceBundle({
						task_id: 'valid-task',
						entries: [createMockEvidence()],
						updated_at: '2024-01-15T10:00:00.000Z',
					}),
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'invalid_schema',
					errors: ['schema_version: Invalid'],
				} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(2);
			expect(result.tasks[0]).toEqual({
				taskId: 'valid-task',
				entryCount: 1,
				lastUpdated: '2024-01-15T10:00:00.000Z',
			});
			expect(result.tasks[1]).toEqual({
				taskId: 'invalid-task',
				entryCount: 0,
				lastUpdated: 'unknown',
			});
		});
	});

	describe('mixed status scenarios', () => {
		test('should handle mix of found, not_found, and invalid_schema', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['task-1', 'task-2', 'task-3']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'found',
					bundle: createMockEvidenceBundle({
						task_id: 'task-1',
						entries: [createMockEvidence()],
						updated_at: '2024-01-15T10:00:00.000Z',
					}),
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'invalid_schema',
					errors: ['Invalid schema'],
				} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(3);
			expect(result.tasks[0]).toEqual({
				taskId: 'task-1',
				entryCount: 1,
				lastUpdated: '2024-01-15T10:00:00.000Z',
			});
			expect(result.tasks[1]).toEqual({
				taskId: 'task-2',
				entryCount: 0,
				lastUpdated: 'unknown',
			});
			expect(result.tasks[2]).toEqual({
				taskId: 'task-3',
				entryCount: 0,
				lastUpdated: 'unknown',
			});
		});

		test('should set hasEvidence to true even if all tasks have errors', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['task-1', 'task-2']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'invalid_schema',
					errors: ['Invalid schema'],
				} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			// hasEvidence is true because taskIds list was not empty
			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(2);
			expect(result.tasks[0].entryCount).toBe(0);
			expect(result.tasks[1].entryCount).toBe(0);
		});
	});

	describe('call verification', () => {
		test('should call listEvidenceTaskIds once', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['1.1']);
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle(),
			} as LoadEvidenceResult);

			await getEvidenceListData(testDir);

			expect(mockListEvidenceTaskIds).toHaveBeenCalledTimes(1);
			expect(mockListEvidenceTaskIds).toHaveBeenCalledWith(testDir);
		});

		test('should call loadEvidence once per task ID', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['1.1', '1.2', '2.1']);
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle(),
			} as LoadEvidenceResult);

			await getEvidenceListData(testDir);

			expect(mockLoadEvidence).toHaveBeenCalledTimes(3);
			expect(mockLoadEvidence).toHaveBeenNthCalledWith(1, testDir, '1.1');
			expect(mockLoadEvidence).toHaveBeenNthCalledWith(2, testDir, '1.2');
			expect(mockLoadEvidence).toHaveBeenNthCalledWith(3, testDir, '2.1');
		});
	});
});
