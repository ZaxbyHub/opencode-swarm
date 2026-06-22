import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as nodeFs from 'node:fs';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
	MemoryProposal,
	MemoryRecord,
} from '../../../src/memory/types.js';

// Save real fs functions before any mocks are applied to avoid recursion
const realRenameSync = nodeFs.renameSync;
const realReadFileSync = nodeFs.readFileSync;
const realReaddirSync = nodeFs.readdirSync;

// Import co-change-analyzer for _internals DI seam (avoids mock.module leakage)
import * as coChangeAnalyzer from '../../../src/tools/co-change-analyzer.js';

const realDetectDarkMatter = coChangeAnalyzer._internals.detectDarkMatter;

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'atomic-writes-test-'));
});

afterEach(() => {
	// Restore _internals DI seam
	coChangeAnalyzer._internals.detectDarkMatter = realDetectDarkMatter;

	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {}
	mock.restore();
});

describe('atomic writes — temp+rename verification (FR-008 SC-013/014/015)', () => {
	it('simulate.ts report write uses temp+rename', async () => {
		const renameCalls: [string, string][] = [];

		// Use _internals DI seam for co-change-analyzer
		coChangeAnalyzer._internals.detectDarkMatter = mock(async () => []);

		await mock.module('node:fs', () => ({
			...nodeFs,
			renameSync: mock((from: string, to: string) => {
				renameCalls.push([from, to]);
				return realRenameSync(from, to);
			}),
		}));

		const { handleSimulateCommand } = await import(
			'../../../src/commands/simulate.js'
		);

		await handleSimulateCommand(testDir, []);

		const reportRename = renameCalls.find(([_, to]) =>
			to.endsWith('simulate-report.md'),
		);
		expect(reportRename).toBeDefined();
		if (reportRename) {
			const [tempPath, finalPath] = reportRename;
			expect(tempPath).toContain('.tmp.');
			expect(path.dirname(tempPath)).toBe(path.dirname(finalPath));
		}
	});

	it('jsonl-migration.ts memories/proposals writes use temp+rename', async () => {
		const renameCalls: [string, string][] = [];

		await mock.module('node:fs', () => ({
			...nodeFs,
			renameSync: mock((from: string, to: string) => {
				renameCalls.push([from, to]);
				return realRenameSync(from, to);
			}),
		}));

		const { writeJsonlExport } = await import(
			'../../../src/memory/jsonl-migration.js'
		);

		await writeJsonlExport(testDir, {}, [], []);

		const memoryRename = renameCalls.find(([_, to]) =>
			to.endsWith('memories.jsonl'),
		);
		const proposalRename = renameCalls.find(([_, to]) =>
			to.endsWith('proposals.jsonl'),
		);
		expect(memoryRename).toBeDefined();
		expect(proposalRename).toBeDefined();

		for (const [from, to] of [memoryRename, proposalRename]) {
			expect(path.dirname(from)).toBe(path.dirname(to));
			expect(from).toContain('.tmp.');
		}
	});

	it('close.ts context.md write uses temp+rename', async () => {
		const renameCalls: [string, string][] = [];

		await mock.module('node:fs', () => ({
			...nodeFs,
			renameSync: mock((from: string, to: string) => {
				renameCalls.push([from, to]);
				return realRenameSync(from, to);
			}),
		}));

		const { _internals: ci } = await import('../../../src/commands/close.js');

		mkdirSync(path.join(testDir, '.swarm'), { recursive: true });

		const ctx = {
			directory: testDir,
			swarmDir: path.join(testDir, '.swarm'),
			planData: { title: 'test', phases: [] },
			planExists: false,
			planAlreadyDone: false,
			config: { enabled: true, hive_enabled: false },
			projectName: 'test',
			warnings: [] as string[],
			closedPhases: [] as number[],
			closedTasks: [] as string[],
			sessionStart: undefined as string | undefined,
			isForced: false,
			runSkillReview: false,
			options: {},
			phases: [] as any[],
			inProgressPhases: [] as any[],
			curationSucceeded: false,
			curationResult: undefined,
			allLessons: [] as string[],
			explicitLessons: [] as string[],
			retroLessons: [] as string[],
			knowledgeSkillHint: '',
			skillReviewSummary: '',
			postMortemSummary: '',
			hivePromoted: 0,
			sessionKnowledgeCreated: 0,
			fallbackKnowledgeCreated: 0,
			originalStatuses: new Map<string, string>(),
			guaranteeResult: {
				closedPhaseIds: [] as number[],
				closedTaskIds: [] as string[],
			},
			archiveResult: '',
			archivedFileCount: 0,
			archivedActiveStateFiles: new Set<string>(),
			archivedActiveStateDirs: new Set<string>(),
			archiveFailureReasons: new Map<string, string>(),
			timestamp: '',
			archiveDir: '',
			archiveSuffix: '',
			args: [] as string[],
		};

		await ci.runCleanStage(ctx);

		const contextPath = path.join(testDir, '.swarm', 'context.md');
		expect(existsSync(contextPath)).toBe(true);

		// Verify rename was used with a temp source path
		const contextRename = renameCalls.find(([_, to]) =>
			to.endsWith('context.md'),
		);
		expect(contextRename).toBeDefined();
		if (contextRename) {
			const [tempPath] = contextRename;
			expect(tempPath).toContain('.tmp.');
			expect(path.dirname(tempPath)).toBe(path.dirname(contextPath));
		}

		// Verify no temp files remain in .swarm/
		const swarmFiles = realReaddirSync(path.join(testDir, '.swarm'));
		const tempFiles = swarmFiles.filter((f) => f.includes('.tmp.'));
		expect(tempFiles).toHaveLength(0);

		// Verify content was written
		const content = realReadFileSync(contextPath, 'utf-8');
		expect(content).toContain('Session closed after: test');
	});

	it('Temp file is in same directory as final file', async () => {
		const renameCalls: [string, string][] = [];

		await mock.module('node:fs', () => ({
			...nodeFs,
			renameSync: mock((from: string, to: string) => {
				renameCalls.push([from, to]);
				return realRenameSync(from, to);
			}),
		}));

		const { writeJsonlExport } = await import(
			'../../../src/memory/jsonl-migration.js'
		);

		await writeJsonlExport(testDir, {}, [], []);

		// All rename calls should have temp files in the same directory as the destination
		for (const [from, to] of renameCalls) {
			expect(path.dirname(from)).toBe(path.dirname(to));
			expect(from).toContain('.tmp.');
		}
	});
});
