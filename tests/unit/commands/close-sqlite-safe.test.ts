import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloseStageContext } from '../../../src/commands/close.js';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';

let testDir: string;
let spawnMock: ReturnType<typeof mock>;

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-sqlite-test-'));
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	writeFileSync(path.join(testDir, '.swarm', 'swarm.db'), 'fake db content');

	spawnMock = mock(() => ({
		error: undefined,
		status: 0,
		stdout: '0|0|0\n',
	}));
});

afterEach(async () => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {}
	await mock.restore();
});

function makeCtx(): CloseStageContext {
	return {
		directory: testDir,
		swarmDir: path.join(testDir, '.swarm'),
		planData: { title: 'test', phases: [] },
		planExists: false,
		planAlreadyDone: false,
		config: KnowledgeConfigSchema.parse({}),
		projectName: 'test',
		warnings: [],
		closedPhases: [],
		closedTasks: [],
		sessionStart: undefined,
		isForced: false,
		runSkillReview: false,
		options: {},
		phases: [],
		inProgressPhases: [],
		curationSucceeded: false,
		curationResult: undefined,
		allLessons: [],
		explicitLessons: [],
		retroLessons: [],
		knowledgeSkillHint: '',
		skillReviewSummary: '',
		postMortemSummary: '',
		hivePromoted: 0,
		sessionKnowledgeCreated: 0,
		fallbackKnowledgeCreated: 0,
		originalStatuses: new Map(),
		guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
		archiveResult: '',
		archivedFileCount: 0,
		archivedActiveStateFiles: new Set<string>(),
		archivedActiveStateDirs: new Set<string>(),
		archiveFailureReasons: new Map<string, string>(),
		timestamp: '',
		archiveDir: '',
		archiveSuffix: '',
		args: [],
	};
}

describe('copySqliteSafe via runArchiveStage (FR-007 SC-012)', () => {
	it('WAL checkpoint success (busy=0) → swarm.db added to archivedActiveStateFiles', async () => {
		await mock.module('node:child_process', () => ({
			...realChildProcess,
			spawnSync: spawnMock,
		}));

		const { _internals: ci } = await import('../../../src/commands/close.js');
		const realArchiveEvidence = ci.archiveEvidence;
		const realLoadPluginConfigWithMeta = ci.loadPluginConfigWithMeta;
		ci.loadPluginConfigWithMeta = () => ({
			config: {
				knowledge: { enabled: true, hive_enabled: false },
				curator: { enabled: false, postmortem_enabled: false },
				skill_improver: { enabled: false },
				evidence: {},
			},
			loadedFromFile: null,
		});
		ci.archiveEvidence = mock(async () => []);

		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);
			expect(ctx.archivedActiveStateFiles.has('swarm.db')).toBe(true);
			expect(ctx.warnings).toHaveLength(0);
			expect(spawnMock).toHaveBeenCalledTimes(1);
		} finally {
			ci.archiveEvidence = realArchiveEvidence;
			ci.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
		}
	});

	it('WAL checkpoint incomplete (busy=1) → original preserved', async () => {
		spawnMock.mockImplementation(() => ({
			error: undefined,
			status: 0,
			stdout: '1|104|103\n',
		}));

		await mock.module('node:child_process', () => ({
			...realChildProcess,
			spawnSync: spawnMock,
		}));

		const { _internals: ci } = await import('../../../src/commands/close.js');
		const realArchiveEvidence = ci.archiveEvidence;
		const realLoadPluginConfigWithMeta = ci.loadPluginConfigWithMeta;
		ci.loadPluginConfigWithMeta = () => ({
			config: {
				knowledge: { enabled: true, hive_enabled: false },
				curator: { enabled: false, postmortem_enabled: false },
				skill_improver: { enabled: false },
				evidence: {},
			},
			loadedFromFile: null,
		});
		ci.archiveEvidence = mock(async () => []);

		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);
			expect(ctx.archivedActiveStateFiles.has('swarm.db')).toBe(false);
			expect(ctx.warnings.length).toBeGreaterThan(0);
			expect(
				ctx.warnings.some((w) => w.includes('WAL checkpoint incomplete')),
			).toBe(true);
		} finally {
			ci.archiveEvidence = realArchiveEvidence;
			ci.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
		}
	});

	it('sqlite3 CLI absent (ENOENT) → fallback raw copy, original preserved', async () => {
		const enoentErr = Object.assign(new Error('spawnSync ENOENT'), {
			code: 'ENOENT',
		});
		spawnMock.mockImplementation(() => ({
			error: enoentErr,
			status: undefined,
			stdout: '',
		}));

		await mock.module('node:child_process', () => ({
			...realChildProcess,
			spawnSync: spawnMock,
		}));

		const { _internals: ci } = await import('../../../src/commands/close.js');
		const realArchiveEvidence = ci.archiveEvidence;
		const realLoadPluginConfigWithMeta = ci.loadPluginConfigWithMeta;
		ci.loadPluginConfigWithMeta = () => ({
			config: {
				knowledge: { enabled: true, hive_enabled: false },
				curator: { enabled: false, postmortem_enabled: false },
				skill_improver: { enabled: false },
				evidence: {},
			},
			loadedFromFile: null,
		});
		ci.archiveEvidence = mock(async () => []);

		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);
			expect(ctx.archivedActiveStateFiles.has('swarm.db')).toBe(false);
			expect(ctx.warnings.length).toBeGreaterThan(0);
			expect(
				ctx.warnings.some((w) => w.includes('sqlite3 CLI unavailable')),
			).toBe(true);
		} finally {
			ci.archiveEvidence = realArchiveEvidence;
			ci.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
		}
	});

	it('source absent → skipped silently', async () => {
		rmSync(path.join(testDir, '.swarm', 'swarm.db'));

		await mock.module('node:child_process', () => ({
			...realChildProcess,
			spawnSync: spawnMock,
		}));

		const { _internals: ci } = await import('../../../src/commands/close.js');
		const realArchiveEvidence = ci.archiveEvidence;
		const realLoadPluginConfigWithMeta = ci.loadPluginConfigWithMeta;
		ci.loadPluginConfigWithMeta = () => ({
			config: {
				knowledge: { enabled: true, hive_enabled: false },
				curator: { enabled: false, postmortem_enabled: false },
				skill_improver: { enabled: false },
				evidence: {},
			},
			loadedFromFile: null,
		});
		ci.archiveEvidence = mock(async () => []);

		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);
			expect(spawnMock).not.toHaveBeenCalled();
			expect(ctx.archivedActiveStateFiles.has('swarm.db')).toBe(false);
			expect(ctx.warnings).toHaveLength(0);
		} finally {
			ci.archiveEvidence = realArchiveEvidence;
			ci.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
		}
	});
});
