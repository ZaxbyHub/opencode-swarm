import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	createCuratorBeforeEach,
	createCuratorMocks,
	defaultConfig,
	setupMockModules,
} from './curator-test-fixtures.js';

const mocks = createCuratorMocks();
setupMockModules(mocks);

const { mockReadSwarmFileAsync } = mocks;
const { createKnowledgeCuratorHook, _internals } = await import(
	'../../../src/hooks/knowledge-curator.js'
);
const { transactKnowledge: mockTransactKnowledge } = await import(
	'../../../src/hooks/knowledge-store.js'
);
const resetFixtures = createCuratorBeforeEach(mocks, mockTransactKnowledge);
const realCurate = _internals.curateAndStoreSwarm;
const realRealpath = _internals.realpath;

function trigger(sessionID = 'multi-entry-session') {
	return {
		toolName: 'write',
		path: '/project/.swarm/evidence/task-1/evidence.json',
		sessionID,
	};
}

describe('knowledge curator multi-entry evidence — regression: issue #1769', () => {
	beforeEach(() => {
		resetFixtures();
		_internals.seenRetroSections.clear();
		_internals.inFlightEvidenceEntries.clear();
		_internals.curateAndStoreSwarm = realCurate;
		_internals.realpath = realRealpath;
	});

	afterEach(() => {
		_internals.curateAndStoreSwarm = realCurate;
		_internals.realpath = realRealpath;
	});

	test('ingests a later retrospective when the first entry has no lessons', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		mockReadSwarmFileAsync.mockResolvedValueOnce(
			JSON.stringify({
				task_id: 'task-1',
				entries: [
					{ type: 'test', summary: 'no lessons here' },
					{
						type: 'retrospective',
						task_id: 'task-1',
						timestamp: '2026-07-10T00:00:00.000Z',
						agent: 'reviewer',
						phase_number: 4,
						lessons_learned: ['Run the focused regression before publishing'],
					},
				],
			}),
		);

		await createKnowledgeCuratorHook('/project', defaultConfig)(trigger(), {});

		expect(curate).toHaveBeenCalledTimes(1);
		expect(curate.mock.calls[0][0]).toEqual([
			'Run the focused regression before publishing',
		]);
		expect(curate.mock.calls[0][2]).toEqual({ phase_number: 4 });
	});

	test('processes every eligible entry sequentially with entry metadata precedence', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		mockReadSwarmFileAsync.mockResolvedValueOnce(
			JSON.stringify({
				project_name: 'legacy-root',
				phase_number: 1,
				entries: [
					{
						type: 'retrospective',
						task_id: 'one',
						timestamp: '2026-07-10T00:00:00.000Z',
						agent: 'one',
						phase_number: 2,
						metadata: { project_name: 'metadata-project' },
						lessons_learned: ['Keep the first entry independently retryable'],
					},
					{
						type: 'retrospective',
						task_id: 'two',
						timestamp: '2026-07-10T00:01:00.000Z',
						agent: 'two',
						phase_number: 3,
						project_name: 'entry-project',
						lessons_learned: ['Keep the second entry phase-specific'],
					},
				],
			}),
		);

		await createKnowledgeCuratorHook('/project', defaultConfig)(trigger(), {});

		expect(curate).toHaveBeenCalledTimes(2);
		expect(curate.mock.calls[0][1]).toBe('metadata-project');
		expect(curate.mock.calls[0][2]).toEqual({ phase_number: 2 });
		expect(curate.mock.calls[1][1]).toBe('entry-project');
		expect(curate.mock.calls[1][2]).toEqual({ phase_number: 3 });
	});

	test('entries that differ only by resolved project metadata are both curated', async () => {
		const batches = _internals.extractEvidenceLessonBatches({
			entries: [
				{
					type: 'retrospective',
					task_id: 'shared',
					timestamp: '2026-07-10T00:00:00.000Z',
					project_name: 'project-one',
					lessons_learned: ['Preserve project-specific attribution'],
				},
				{
					type: 'retrospective',
					task_id: 'shared',
					timestamp: '2026-07-10T00:00:00.000Z',
					metadata: { project_name: 'project-two' },
					lessons_learned: ['Preserve project-specific attribution'],
				},
			],
		});

		expect(batches).toHaveLength(2);
		expect(batches[0].identity).not.toBe(batches[1].identity);
		expect(batches.map((batch) => batch.projectName)).toEqual([
			'project-one',
			'project-two',
		]);
	});

	test('accepts missing-type legacy entries but rejects explicit non-retrospective spoofing', async () => {
		const batches = _internals.extractEvidenceLessonBatches({
			entries: [
				{ lessons_learned: ['Preserve the legacy structural format'] },
				{
					type: 'test',
					lessons_learned: ['Do not ingest a spoofed test entry'],
				},
				{
					type: null,
					lessons_learned: ['Do not ingest an explicit null type'],
				},
				{
					type: 7,
					lessons_learned: ['Do not ingest an explicit numeric type'],
				},
				{
					type: {},
					lessons_learned: ['Do not ingest an explicit object type'],
				},
				{
					type: 'retrospective',
					lessons_learned: [null, '   ', 'x'.repeat(281)],
				},
			],
		});

		expect(batches).toHaveLength(1);
		expect(batches[0].lessons).toEqual([
			'Preserve the legacy structural format',
		]);
	});

	test('appending entry 2 processes only entry 2, independent of session id', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		const first = {
			type: 'retrospective',
			task_id: 'one',
			timestamp: '2026-07-10T00:00:00.000Z',
			agent: 'one',
			phase_number: 1,
			lessons_learned: ['Process the original entry once'],
		};
		const second = {
			type: 'retrospective',
			task_id: 'two',
			timestamp: '2026-07-10T00:01:00.000Z',
			agent: 'two',
			phase_number: 2,
			lessons_learned: ['Process only the appended entry next'],
		};
		mockReadSwarmFileAsync
			.mockResolvedValueOnce(JSON.stringify({ entries: [first] }))
			.mockResolvedValueOnce(JSON.stringify({ entries: [first, second] }));
		const hook = createKnowledgeCuratorHook('/project', defaultConfig);

		await hook(trigger('session-one'), {});
		await hook(trigger('session-two'), {});

		expect(curate).toHaveBeenCalledTimes(2);
		expect(curate.mock.calls[1][0]).toEqual([
			'Process only the appended entry next',
		]);
	});

	test('identical evidence in different project roots is curated independently', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		const content = JSON.stringify({
			entries: [
				{
					type: 'retrospective',
					task_id: 'shared-task',
					timestamp: '2026-07-10T00:00:00.000Z',
					lessons_learned: ['Keep project-local evidence claims isolated'],
				},
			],
		});
		mockReadSwarmFileAsync.mockResolvedValue(content);
		const firstProject = createKnowledgeCuratorHook(
			'/project-one',
			defaultConfig,
		);
		const secondProject = createKnowledgeCuratorHook(
			'/project-two',
			defaultConfig,
		);

		await firstProject(trigger('first-session'), {});
		await secondProject(trigger('second-session'), {});
		await firstProject(trigger('third-session'), {});

		expect(curate).toHaveBeenCalledTimes(2);
		expect(curate.mock.calls.map((call) => call[3])).toEqual([
			'/project-one',
			'/project-two',
		]);
	});

	test('Windows path casing and separator variants share one evidence claim', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		mockReadSwarmFileAsync.mockResolvedValue(
			JSON.stringify({
				type: 'retrospective',
				task_id: 'case-test',
				lessons_learned: ['Normalize the complete Windows evidence key'],
			}),
		);
		const onWindows = process.platform === 'win32';
		const firstRoot = onWindows ? 'C:\\Repo' : '/repo';
		const secondRoot = onWindows ? 'c:/repo' : '/repo';
		const firstPath = onWindows
			? 'C:\\Repo\\.SWARM\\EVIDENCE\\Task-1\\Evidence.JSON'
			: '/repo/.SWARM/evidence/task-1/evidence.json';
		const first = createKnowledgeCuratorHook(firstRoot, defaultConfig);
		const second = createKnowledgeCuratorHook(secondRoot, defaultConfig);

		await first(
			{
				toolName: 'write',
				path: firstPath,
				sessionID: 'case-one',
			},
			{},
		);
		await second(
			{
				toolName: 'write',
				path: 'c:/repo/.swarm/evidence/task-1/evidence.json',
				sessionID: 'case-two',
			},
			{},
		);

		expect(curate).toHaveBeenCalledTimes(1);
		expect(mockReadSwarmFileAsync.mock.calls[0][1]).toBe(
			onWindows
				? 'EVIDENCE/Task-1/Evidence.JSON'
				: 'evidence/task-1/evidence.json',
		);
	});

	test('dot and redundant path segments share one evidence claim', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		mockReadSwarmFileAsync.mockResolvedValue(
			JSON.stringify({
				type: 'retrospective',
				lessons_learned: ['Canonicalize equivalent evidence paths'],
			}),
		);
		const hook = createKnowledgeCuratorHook('/project', defaultConfig);

		for (const evidencePath of [
			'/project/.swarm/evidence/task/evidence.json',
			'/project/.swarm/evidence/task/./evidence.json',
			'/project/.swarm/evidence//task/evidence.json',
		]) {
			await hook(
				{ toolName: 'write', path: evidencePath, sessionID: evidencePath },
				{},
			);
		}

		expect(curate).toHaveBeenCalledTimes(1);
	});

	test('physical project-root aliases share one evidence claim', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		_internals.realpath = mock(async () =>
			process.platform === 'win32'
				? 'C:\\physical-project'
				: '/physical-project',
		);
		mockReadSwarmFileAsync.mockResolvedValue(
			JSON.stringify({
				type: 'retrospective',
				lessons_learned: ['Canonicalize physical project aliases'],
			}),
		);
		const firstAlias = createKnowledgeCuratorHook('/alias-one', defaultConfig);
		const secondAlias = createKnowledgeCuratorHook('/alias-two', defaultConfig);

		await firstAlias(trigger('alias-one'), {});
		await secondAlias(trigger('alias-two'), {});

		expect(curate).toHaveBeenCalledTimes(1);
		expect(_internals.realpath).toHaveBeenCalledTimes(8);
	});

	test('physical evidence-file aliases share one evidence claim', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		_internals.realpath = mock(async (candidate: string) => {
			const normalized = candidate.replaceAll('\\', '/');
			if (
				normalized.endsWith('/evidence/alias-one.json') ||
				normalized.endsWith('/evidence/alias-two.json')
			) {
				return process.platform === 'win32'
					? 'C:\\project\\.swarm\\evidence\\physical.json'
					: '/project/.swarm/evidence/physical.json';
			}
			return candidate;
		});
		mockReadSwarmFileAsync.mockResolvedValue(
			JSON.stringify({
				type: 'retrospective',
				lessons_learned: ['Canonicalize physical evidence aliases'],
			}),
		);
		const hook = createKnowledgeCuratorHook('/project', defaultConfig);

		await hook(
			{
				toolName: 'write',
				path: '/project/.swarm/evidence/alias-one.json',
				sessionID: 'file-alias-one',
			},
			{},
		);
		await hook(
			{
				toolName: 'write',
				path: '/project/.swarm/evidence/alias-two.json',
				sessionID: 'file-alias-two',
			},
			{},
		);

		expect(curate).toHaveBeenCalledTimes(1);
	});

	test('physical evidence aliases outside the project are rejected', async () => {
		const curate = mock(async () => ({
			stored: 1,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		_internals.curateAndStoreSwarm = curate;
		_internals.realpath = mock(async (candidate: string) =>
			candidate.replaceAll('\\', '/').endsWith('/evidence/escape.json')
				? process.platform === 'win32'
					? 'C:\\outside\\escape.json'
					: '/outside/escape.json'
				: candidate,
		);
		const hook = createKnowledgeCuratorHook('/project', defaultConfig);

		await hook(
			{
				toolName: 'write',
				path: '/project/.swarm/evidence/escape.json',
				sessionID: 'escape',
			},
			{},
		);

		expect(mockReadSwarmFileAsync).not.toHaveBeenCalled();
		expect(curate).not.toHaveBeenCalled();
	});
});
