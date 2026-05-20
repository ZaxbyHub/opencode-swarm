import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	formatEvidenceListMarkdown,
	formatTaskEvidenceMarkdown,
	getEvidenceListData,
	getTaskEvidenceData,
	getVerdictEmoji,
} from '../../../src/services/evidence-service';

describe('evidence-service', () => {
	describe('getVerdictEmoji', () => {
		test('returns ✅ for approved verdict', () => {
			expect(getVerdictEmoji('approved')).toBe('✅');
		});

		test('returns ✅ for pass verdict', () => {
			expect(getVerdictEmoji('pass')).toBe('✅');
		});

		test('returns ❌ for fail verdict', () => {
			expect(getVerdictEmoji('fail')).toBe('❌');
		});

		test('returns ❌ for rejected verdict', () => {
			expect(getVerdictEmoji('rejected')).toBe('❌');
		});

		test('returns ℹ️ for info verdict', () => {
			expect(getVerdictEmoji('info')).toBe('ℹ️');
		});

		test('returns empty string for unknown verdict', () => {
			expect(getVerdictEmoji('concerns')).toBe('');
			expect(getVerdictEmoji('pending')).toBe('');
			expect(getVerdictEmoji('')).toBe('');
			expect(getVerdictEmoji('random_unrecognized')).toBe('');
		});
	});

	describe('formatEvidenceListMarkdown', () => {
		test('returns no evidence message when hasEvidence is false', () => {
			const result = formatEvidenceListMarkdown({
				hasEvidence: false,
				tasks: [],
			});
			expect(result).toBe('No evidence bundles found.');
		});

		test('returns no evidence message when tasks array is empty despite hasEvidence true', () => {
			const result = formatEvidenceListMarkdown({
				hasEvidence: true,
				tasks: [],
			});
			expect(result).toBe('No evidence bundles found.');
		});

		test('formats populated task list as markdown table', () => {
			const list = {
				hasEvidence: true,
				tasks: [
					{
						taskId: 'task-1',
						entryCount: 3,
						lastUpdated: '2026-05-01T10:00:00Z',
					},
					{
						taskId: 'task-2',
						entryCount: 0,
						lastUpdated: '2026-05-02T14:30:00Z',
					},
				],
			};
			const result = formatEvidenceListMarkdown(list);
			expect(result).toContain('## Evidence Bundles');
			expect(result).toContain('| Task | Entries | Last Updated |');
			expect(result).toContain('| task-1 | 3 | 2026-05-01T10:00:00Z |');
			expect(result).toContain('| task-2 | 0 | 2026-05-02T14:30:00Z |');
		});

		test('handles single task in list', () => {
			const list = {
				hasEvidence: true,
				tasks: [
					{
						taskId: 'task-x',
						entryCount: 5,
						lastUpdated: '2026-05-13T08:00:00Z',
					},
				],
			};
			const result = formatEvidenceListMarkdown(list);
			expect(result).toContain('task-x');
			expect(result).toContain('5');
		});
	});

	describe('formatTaskEvidenceMarkdown', () => {
		test('returns no evidence message when hasEvidence is false', () => {
			const result = formatTaskEvidenceMarkdown({
				hasEvidence: false,
				taskId: 'task-1',
				createdAt: '',
				updatedAt: '',
				entries: [],
			});
			expect(result).toBe('No evidence found for task task-1.');
		});

		test('formats task with review entry as markdown', () => {
			const evidence = {
				hasEvidence: true,
				taskId: 'task-review',
				createdAt: '2026-05-01T09:00:00Z',
				updatedAt: '2026-05-01T11:00:00Z',
				entries: [
					{
						index: 1,
						entry: {} as any,
						type: 'review',
						verdict: 'approved',
						verdictIcon: '✅',
						agent: 'reviewer-1',
						summary: 'Code looks good',
						timestamp: '2026-05-01T10:00:00Z',
						details: { risk: 'low', issues: 2 },
					},
				],
			};
			const result = formatTaskEvidenceMarkdown(evidence);
			expect(result).toContain('## Evidence for Task task-review');
			expect(result).toContain('**Created**: 2026-05-01T09:00:00Z');
			expect(result).toContain('**Updated**: 2026-05-01T11:00:00Z');
			expect(result).toContain('**Entries**: 1');
			expect(result).toContain('### Entry 1: review (approved) ✅');
			expect(result).toContain('**Agent**: reviewer-1');
			expect(result).toContain('**Summary**: Code looks good');
			expect(result).toContain('**Time**: 2026-05-01T10:00:00Z');
			expect(result).toContain('**Risk Level**: low');
			expect(result).toContain('**Issues**: 2');
		});

		test('formats task with test entry as markdown', () => {
			const evidence = {
				hasEvidence: true,
				taskId: 'task-test',
				createdAt: '2026-05-02T08:00:00Z',
				updatedAt: '2026-05-02T12:00:00Z',
				entries: [
					{
						index: 1,
						entry: {} as any,
						type: 'test',
						verdict: 'pass',
						verdictIcon: '✅',
						agent: 'test-agent',
						summary: 'All tests passed',
						timestamp: '2026-05-02T09:00:00Z',
						details: { tests_passed: 42, tests_failed: 0 },
					},
				],
			};
			const result = formatTaskEvidenceMarkdown(evidence);
			expect(result).toContain('## Evidence for Task task-test');
			expect(result).toContain('### Entry 1: test (pass) ✅');
			expect(result).toContain('**Tests**: 42 passed, 0 failed');
		});

		test('formats task with multiple entries of different types', () => {
			const evidence = {
				hasEvidence: true,
				taskId: 'task-multi',
				createdAt: '2026-05-03T07:00:00Z',
				updatedAt: '2026-05-03T15:00:00Z',
				entries: [
					{
						index: 1,
						entry: {} as any,
						type: 'review',
						verdict: 'fail',
						verdictIcon: '❌',
						agent: 'reviewer-bot',
						summary: 'Security concerns found',
						timestamp: '2026-05-03T09:00:00Z',
						details: { risk: 'high', issues: 3 },
					},
					{
						index: 2,
						entry: {} as any,
						type: 'test',
						verdict: 'pass',
						verdictIcon: '✅',
						agent: 'ci-agent',
						summary: 'Tests passed after fix',
						timestamp: '2026-05-03T14:00:00Z',
						details: { tests_passed: 100, tests_failed: 0 },
					},
				],
			};
			const result = formatTaskEvidenceMarkdown(evidence);
			expect(result).toContain('**Entries**: 2');
			expect(result).toContain('### Entry 1: review (fail) ❌');
			expect(result).toContain('### Entry 2: test (pass) ✅');
			expect(result).toContain('**Issues**: 3');
			expect(result).toContain('**Tests**: 100 passed, 0 failed');
		});
	});

	// -------------------------------------------------------------------------
	// Async I/O tests — use _internals DI seam
	// -------------------------------------------------------------------------

	describe('getTaskEvidenceData', () => {
		let origLoadEvidence: typeof _internals.loadEvidence;

		beforeEach(() => {
			origLoadEvidence = _internals.loadEvidence;
		});

		afterEach(() => {
			_internals.loadEvidence = origLoadEvidence;
		});

		test('returns hasEvidence false when loadEvidence returns not_found', async () => {
			_internals.loadEvidence = mock(() =>
				Promise.resolve({ status: 'not_found' as const }),
			);

			const result = await getTaskEvidenceData('/fake/dir', 'task-1');

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe('task-1');
			expect(result.createdAt).toBe('');
			expect(result.updatedAt).toBe('');
			expect(result.entries).toEqual([]);
		});

		test('returns hasEvidence false when loadEvidence returns error status', async () => {
			_internals.loadEvidence = mock(() =>
				Promise.resolve({ status: 'error' as const, message: 'oops' }),
			);

			const result = await getTaskEvidenceData('/fake/dir', 'task-2');

			expect(result.hasEvidence).toBe(false);
			expect(result.taskId).toBe('task-2');
		});

		test('returns hasEvidence true with entries when loadEvidence returns found', async () => {
			_internals.loadEvidence = mock(() =>
				Promise.resolve({
					status: 'found' as const,
					bundle: {
						task_id: 'task-3',
						created_at: '2026-05-01T10:00:00Z',
						updated_at: '2026-05-01T12:00:00Z',
						entries: [
							{
								type: 'review',
								verdict: 'approved',
								agent: 'reviewer',
								summary: 'Looks good',
								timestamp: '2026-05-01T11:00:00Z',
								details: {},
							},
						],
					},
				}),
			);

			const result = await getTaskEvidenceData('/fake/dir', 'task-3');

			expect(result.hasEvidence).toBe(true);
			expect(result.taskId).toBe('task-3');
			expect(result.createdAt).toBe('2026-05-01T10:00:00Z');
			expect(result.updatedAt).toBe('2026-05-01T12:00:00Z');
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]!.type).toBe('review');
			expect(result.entries[0]!.verdict).toBe('approved');
			expect(result.entries[0]!.verdictIcon).toBe('✅');
		});

		test('formats review entry details correctly', async () => {
			_internals.loadEvidence = mock(() =>
				Promise.resolve({
					status: 'found' as const,
					bundle: {
						task_id: 'task-review-detail',
						created_at: '2026-05-01T08:00:00Z',
						updated_at: '2026-05-01T14:00:00Z',
						entries: [
							{
								type: 'review',
								verdict: 'fail',
								agent: 'security-reviewer',
								summary: 'SQL injection risk',
								timestamp: '2026-05-01T10:00:00Z',
								details: {},
								risk: 'high',
								issues: ['SQL injection in query'],
							} as any,
						],
					},
				}),
			);

			const result = await getTaskEvidenceData(
				'/fake/dir',
				'task-review-detail',
			);

			expect(result.entries[0]!.details.risk).toBe('high');
			expect(result.entries[0]!.details.issues).toBe(1);
		});

		test('formats test entry details correctly', async () => {
			_internals.loadEvidence = mock(() =>
				Promise.resolve({
					status: 'found' as const,
					bundle: {
						task_id: 'task-test-detail',
						created_at: '2026-05-02T08:00:00Z',
						updated_at: '2026-05-02T16:00:00Z',
						entries: [
							{
								type: 'test',
								verdict: 'pass',
								agent: 'ci-agent',
								summary: 'All unit tests passed',
								timestamp: '2026-05-02T12:00:00Z',
								details: {},
								tests_passed: 150,
								tests_failed: 0,
							} as any,
						],
					},
				}),
			);

			const result = await getTaskEvidenceData('/fake/dir', 'task-test-detail');

			expect(result.entries[0]!.details.tests_passed).toBe(150);
			expect(result.entries[0]!.details.tests_failed).toBe(0);
		});
	});

	describe('getEvidenceListData', () => {
		let origListEvidenceTaskIds: typeof _internals.listEvidenceTaskIds;
		let origLoadEvidence: typeof _internals.loadEvidence;

		beforeEach(() => {
			origListEvidenceTaskIds = _internals.listEvidenceTaskIds;
			origLoadEvidence = _internals.loadEvidence;
		});

		afterEach(() => {
			_internals.listEvidenceTaskIds = origListEvidenceTaskIds;
			_internals.loadEvidence = origLoadEvidence;
		});

		test('returns hasEvidence false with empty tasks when no task IDs', async () => {
			_internals.listEvidenceTaskIds = mock(() => Promise.resolve([]));

			const result = await getEvidenceListData('/fake/dir');

			expect(result.hasEvidence).toBe(false);
			expect(result.tasks).toEqual([]);
		});

		test('returns hasEvidence true with tasks when task IDs are found', async () => {
			_internals.listEvidenceTaskIds = mock(() =>
				Promise.resolve(['task-a', 'task-b']),
			);
			_internals.loadEvidence = mock((taskId: string) =>
				Promise.resolve({
					status: 'found' as const,
					bundle: {
						task_id: taskId,
						created_at: '2026-05-01T09:00:00Z',
						updated_at: '2026-05-01T10:00:00Z',
						entries: [
							{
								type: 'review',
								verdict: 'approved',
								agent: 'r',
								summary: 's',
								timestamp: '2026-05-01T09:30:00Z',
								details: {},
							},
						],
					},
				}),
			);

			const result = await getEvidenceListData('/fake/dir');

			expect(result.hasEvidence).toBe(true);
			expect(result.tasks).toHaveLength(2);
			expect(result.tasks[0]!.taskId).toBe('task-a');
			expect(result.tasks[0]!.entryCount).toBe(1);
			expect(result.tasks[1]!.taskId).toBe('task-b');
		});

		test('returns entryCount 0 and lastUpdated unknown when load fails for a task', async () => {
			_internals.listEvidenceTaskIds = mock(() => Promise.resolve(['task-c']));
			_internals.loadEvidence = mock(() =>
				Promise.resolve({ status: 'error' as const, message: 'read error' }),
			);

			const result = await getEvidenceListData('/fake/dir');

			expect(result.tasks).toHaveLength(1);
			expect(result.tasks[0]!.entryCount).toBe(0);
			expect(result.tasks[0]!.lastUpdated).toBe('unknown');
		});
	});
});
