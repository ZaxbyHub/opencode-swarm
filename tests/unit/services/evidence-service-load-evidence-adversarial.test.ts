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
		`evidence-adversarial-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	_internals.loadEvidence = originalLoadEvidence;
	_internals.listEvidenceTaskIds = originalListEvidenceTaskIds;
	rmSync(testDir, { recursive: true, force: true });
});

describe('getTaskEvidenceData - loadEvidence throwing exceptions', () => {
	describe('synchronous exceptions', () => {
		test('should propagate synchronous error from loadEvidence', async () => {
			const syncError = new Error('Synchronous error in loadEvidence');
			mockLoadEvidence.mockImplementation(() => {
				throw syncError;
			});

			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow(
				'Synchronous error in loadEvidence',
			);
		});

		test('should propagate synchronous non-Error exception', async () => {
			mockLoadEvidence.mockImplementation(() => {
				throw 'String error thrown';
			});

			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow();
		});

		test('should propagate synchronous null throw', async () => {
			mockLoadEvidence.mockImplementation(() => {
				throw null;
			});

			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow();
		});
	});

	describe('asynchronous exceptions', () => {
		test('should propagate async rejection from loadEvidence', async () => {
			const asyncError = new Error('Async rejection in loadEvidence');
			mockLoadEvidence.mockRejectedValue(asyncError);

			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow(
				'Async rejection in loadEvidence',
			);
		});

		test('should propagate async non-Error rejection', async () => {
			mockLoadEvidence.mockRejectedValue('String rejection');

			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow();
		});

		test('should propagate async null rejection', async () => {
			mockLoadEvidence.mockRejectedValue(null);

			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow();
		});

		test('should propagate async undefined rejection', async () => {
			mockLoadEvidence.mockRejectedValue(undefined);

			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow();
		});
	});
});

describe('getTaskEvidenceData - unexpected status in discriminated union', () => {
	test('should handle unknown status "unknown" gracefully', async () => {
		mockLoadEvidence.mockResolvedValue({
			status: 'unknown',
		} as any as LoadEvidenceResult);

		const result = await getTaskEvidenceData(testDir, 'task-1');

		// Should fall back to hasEvidence: false when status is not 'found'
		expect(result.hasEvidence).toBe(false);
		expect(result.taskId).toBe('task-1');
		expect(result.entries).toHaveLength(0);
	});

	test('should handle unknown status "corrupted" gracefully', async () => {
		mockLoadEvidence.mockResolvedValue({
			status: 'corrupted',
		} as any as LoadEvidenceResult);

		const result = await getTaskEvidenceData(testDir, 'task-2');

		expect(result.hasEvidence).toBe(false);
		expect(result.taskId).toBe('task-2');
		expect(result.entries).toHaveLength(0);
	});

	test('should handle empty string status', async () => {
		mockLoadEvidence.mockResolvedValue({
			status: '',
		} as any as LoadEvidenceResult);

		const result = await getTaskEvidenceData(testDir, 'task-3');

		expect(result.hasEvidence).toBe(false);
		expect(result.taskId).toBe('task-3');
		expect(result.entries).toHaveLength(0);
	});

	test('should handle numeric status cast to string', async () => {
		mockLoadEvidence.mockResolvedValue({
			status: 404,
		} as any as LoadEvidenceResult);

		const result = await getTaskEvidenceData(testDir, 'task-4');

		expect(result.hasEvidence).toBe(false);
		expect(result.taskId).toBe('task-4');
		expect(result.entries).toHaveLength(0);
	});

	test('should handle null status', async () => {
		mockLoadEvidence.mockResolvedValue({
			status: null,
		} as any as LoadEvidenceResult);

		const result = await getTaskEvidenceData(testDir, 'task-5');

		expect(result.hasEvidence).toBe(false);
		expect(result.taskId).toBe('task-5');
		expect(result.entries).toHaveLength(0);
	});

	test('should handle missing status property', async () => {
		mockLoadEvidence.mockResolvedValue({} as any as LoadEvidenceResult);

		const result = await getTaskEvidenceData(testDir, 'task-6');

		expect(result.hasEvidence).toBe(false);
		expect(result.taskId).toBe('task-6');
		expect(result.entries).toHaveLength(0);
	});
});

describe('getTaskEvidenceData - bundle.entries edge cases', () => {
	describe('bundle.entries being null or undefined', () => {
		test('should handle bundle.entries being null', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					entries: null as any,
				}),
			} as LoadEvidenceResult);

			// Should throw TypeError when trying to access .length
			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow();
		});

		test('should handle bundle.entries being undefined', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					entries: undefined as any,
				}),
			} as LoadEvidenceResult);

			// Should throw TypeError when trying to access .length
			await expect(getTaskEvidenceData(testDir, 'task-1')).rejects.toThrow();
		});
	});

	describe('bundle.entries being non-array types', () => {
		test('should iterate over string as characters (vulnerability)', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					entries: 'abc' as any,
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			// String has .length and can be indexed - security issue
			// Iterates over string characters, treating them as evidence entries
			expect(result.hasEvidence).toBe(true);
			expect(result.entries).toHaveLength(3);
		});

		test('should handle bundle.entries being a number (vulnerability - silent failure)', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					entries: 123 as any,
				}),
			} as LoadEvidenceResult);

			// Number.length is undefined, loop doesn't run
			// Function returns successfully with empty entries - silent failure
			const result = await getTaskEvidenceData(testDir, 'task-1');
			expect(result.hasEvidence).toBe(true);
			expect(result.entries).toHaveLength(0);
		});

		test('should handle bundle.entries being an object (vulnerability - silent failure)', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					entries: { not: 'an array' } as any,
				}),
			} as LoadEvidenceResult);

			// Plain object.length is undefined, loop doesn't run
			// Function returns successfully with empty entries - silent failure
			const result = await getTaskEvidenceData(testDir, 'task-1');
			expect(result.hasEvidence).toBe(true);
			expect(result.entries).toHaveLength(0);
		});

		test('should handle bundle.entries being a boolean (vulnerability - silent failure)', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					entries: true as any,
				}),
			} as LoadEvidenceResult);

			// Boolean.length is undefined, loop doesn't run
			// Function returns successfully with empty entries - silent failure
			const result = await getTaskEvidenceData(testDir, 'task-1');
			expect(result.hasEvidence).toBe(true);
			expect(result.entries).toHaveLength(0);
		});
	});

	describe('bundle.entries array-like but not array', () => {
		test('should handle bundle.entries being an array-like object with length', async () => {
			const arrayLike = {
				length: 3,
				0: { type: 'review', summary: 'first' },
				1: { type: 'test', summary: 'second' },
				2: { type: 'note', summary: 'third' },
			};
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					entries: arrayLike as any,
				}),
			} as LoadEvidenceResult);

			// Array-like objects can be indexed and have .length
			const result = await getTaskEvidenceData(testDir, 'task-1');
			expect(result.hasEvidence).toBe(true);
			expect(result.entries).toHaveLength(3);
		});
	});
});

describe('getTaskEvidenceData - timestamp field edge cases', () => {
	describe('bundle.created_at edge cases', () => {
		test('should handle bundle.created_at being null', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					created_at: null as any,
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.createdAt).toBeNull();
		});

		test('should handle bundle.created_at being undefined', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					created_at: undefined as any,
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.createdAt).toBeUndefined();
		});

		test('should handle bundle.created_at being empty string', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					created_at: '',
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.createdAt).toBe('');
		});

		test('should handle bundle.created_at being invalid datetime string', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					created_at: 'not-a-valid-datetime',
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			// Service doesn't validate datetime format, just passes through
			expect(result.hasEvidence).toBe(true);
			expect(result.createdAt).toBe('not-a-valid-datetime');
		});

		test('should handle bundle.created_at being ISO string with only date', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					created_at: '2024-01-15',
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.createdAt).toBe('2024-01-15');
		});

		test('should handle bundle.created_at being number', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					created_at: 1705276800000 as any,
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.createdAt).toBe(1705276800000 as any);
		});
	});

	describe('bundle.updated_at edge cases', () => {
		test('should handle bundle.updated_at being null', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					updated_at: null as any,
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.updatedAt).toBeNull();
		});

		test('should handle bundle.updated_at being undefined', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					updated_at: undefined as any,
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.updatedAt).toBeUndefined();
		});

		test('should handle bundle.updated_at being empty string', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					updated_at: '',
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.updatedAt).toBe('');
		});

		test('should handle bundle.updated_at being invalid datetime string', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					updated_at: 'not-a-valid-datetime',
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.updatedAt).toBe('not-a-valid-datetime');
		});

		test('should handle bundle.updated_at being number', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'found',
				bundle: createMockEvidenceBundle({
					updated_at: 1705276800000 as any,
				}),
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, 'task-1');

			expect(result.hasEvidence).toBe(true);
			expect(result.updatedAt).toBe(1705276800000 as any);
		});
	});
});

describe('getTaskEvidenceData - taskId edge cases', () => {
	describe('very long taskId strings', () => {
		test('should handle 1000 character taskId', async () => {
			const longTaskId = 'a'.repeat(1000);
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, longTaskId);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(longTaskId);
		});

		test('should handle 10000 character taskId', async () => {
			const longTaskId = 'a'.repeat(10000);
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, longTaskId);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(longTaskId);
		});

		test('should handle 100000 character taskId (DoS test)', async () => {
			const longTaskId = 'a'.repeat(100000);
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, longTaskId);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(longTaskId);
		});
	});

	describe('special characters in taskId', () => {
		test('should handle taskId with null bytes', async () => {
			const taskIdWithNull = 'task\0\x00with\x00nulls';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdWithNull);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdWithNull);
		});

		test('should handle taskId with path traversal attempts', async () => {
			const taskIdTraversal = '../../../etc/passwd';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdTraversal);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdTraversal);
		});

		test('should handle taskId with backslash traversal', async () => {
			const taskIdBackslash = '..\\..\\..\\windows\\system32';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdBackslash);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdBackslash);
		});

		test('should handle taskId with unicode characters', async () => {
			const taskIdUnicode = '任务-🚀-日本語-العربية';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdUnicode);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdUnicode);
		});

		test('should handle taskId with emojis', async () => {
			const taskIdEmojis = '😀😁😂🤣😃😄😅😆😉😊';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdEmojis);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdEmojis);
		});

		test('should handle taskId with control characters', async () => {
			const taskIdWithControls = 'task\u0001\u0002\u001fcontrol';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdWithControls);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdWithControls);
		});

		test('should handle taskId with newlines and tabs', async () => {
			const taskIdWithWhitespace = 'task\nwith\tnewlines\r\nand\ttabs';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdWithWhitespace);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdWithWhitespace);
		});

		test('should handle taskId with SQL injection patterns', async () => {
			const taskIdSQL = "1' OR '1'='1'; DROP TABLE users;--";
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdSQL);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdSQL);
		});

		test('should handle taskId with XSS patterns', async () => {
			const taskIdXSS = '<script>alert("XSS")</script>';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdXSS);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdXSS);
		});
	});

	describe('malformed taskId values', () => {
		test('should handle empty taskId', async () => {
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, '');

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe('');
		});

		test('should handle taskId with only whitespace', async () => {
			const taskIdWhitespace = '   \t\r\n   ';
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getTaskEvidenceData(testDir, taskIdWhitespace);

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe(taskIdWhitespace);
		});
	});
});

describe('getEvidenceListData - large task ID lists', () => {
	describe('performance edge cases', () => {
		test('should handle 100 task IDs', async () => {
			const taskIds = Array.from({ length: 100 }, (_, i) => `task-${i}`);
			mockListEvidenceTaskIds.mockResolvedValue(taskIds);
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(100);
			expect(mockLoadEvidence).toHaveBeenCalledTimes(100);
		});

		test('should handle 1000 task IDs', async () => {
			const taskIds = Array.from({ length: 1000 }, (_, i) => `task-${i}`);
			mockListEvidenceTaskIds.mockResolvedValue(taskIds);
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(1000);
			expect(mockLoadEvidence).toHaveBeenCalledTimes(1000);
		});

		test('should handle 10000 task IDs (DoS test)', async () => {
			const taskIds = Array.from({ length: 10000 }, (_, i) => `task-${i}`);
			mockListEvidenceTaskIds.mockResolvedValue(taskIds);
			mockLoadEvidence.mockResolvedValue({
				status: 'not_found',
			} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(10000);
			expect(mockLoadEvidence).toHaveBeenCalledTimes(10000);
		});

		test('should handle 10000 task IDs with some "found" status', async () => {
			const taskIds = Array.from({ length: 10000 }, (_, i) => `task-${i}`);
			mockListEvidenceTaskIds.mockResolvedValue(taskIds);

			// Make every 100th task "found", others "not_found"
			for (let i = 0; i < 10000; i++) {
				if (i % 100 === 0) {
					mockLoadEvidence.mockResolvedValueOnce({
						status: 'found',
						bundle: createMockEvidenceBundle({
							task_id: `task-${i}`,
							entries: [createMockEvidence()],
							updated_at: '2024-01-15T10:00:00.000Z',
						}),
					} as LoadEvidenceResult);
				} else {
					mockLoadEvidence.mockResolvedValueOnce({
						status: 'not_found',
					} as LoadEvidenceResult);
				}
			}

			const result = await getEvidenceListData(testDir);

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(10000);

			// Check that found tasks have correct entryCount
			let foundCount = 0;
			for (const task of result.tasks) {
				if (task.entryCount > 0) {
					foundCount++;
					expect(task.entryCount).toBe(1);
				} else {
					expect(task.lastUpdated).toBe('unknown');
				}
			}
			expect(foundCount).toBe(100);
		});
	});

	describe('getEvidenceListData with loadEvidence throwing during iteration', () => {
		test('should propagate error when loadEvidence throws mid-iteration', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['task-1', 'task-2', 'task-3']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult)
				.mockRejectedValueOnce(new Error('Load failed on task-2'))
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult);

			await expect(getEvidenceListData(testDir)).rejects.toThrow(
				'Load failed on task-2',
			);
		});

		test('should propagate sync error when loadEvidence throws mid-iteration', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['task-1', 'task-2', 'task-3']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult)
				.mockImplementationOnce(() => {
					throw new Error('Sync error on task-2');
				})
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult);

			await expect(getEvidenceListData(testDir)).rejects.toThrow(
				'Sync error on task-2',
			);
		});
	});

	describe('getEvidenceListData with unexpected bundle properties', () => {
		test('should handle bundle.entries being null during iteration', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['task-1', 'task-2']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: 'task-2',
						entries: null as any,
						created_at: '2024-01-01T00:00:00.000Z',
						updated_at: '2024-01-15T10:00:00.000Z',
					},
				} as LoadEvidenceResult);

			// Should throw TypeError when trying to access .length on null
			await expect(getEvidenceListData(testDir)).rejects.toThrow(TypeError);
		});

		test('should handle bundle.updated_at being null during iteration', async () => {
			mockListEvidenceTaskIds.mockResolvedValue(['task-1', 'task-2']);

			mockLoadEvidence
				.mockResolvedValueOnce({
					status: 'not_found',
				} as LoadEvidenceResult)
				.mockResolvedValueOnce({
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: 'task-2',
						entries: [],
						created_at: '2024-01-01T00:00:00.000Z',
						updated_at: null as any,
					},
				} as LoadEvidenceResult);

			const result = await getEvidenceListData(testDir);

			expect(result.tasks).toHaveLength(2);
			expect(result.tasks[1].lastUpdated).toBeNull();
		});
	});
});
