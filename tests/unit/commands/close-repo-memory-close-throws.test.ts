/** repo-memory clean-stage resilience without process-wide module mocks. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
	type CloseStageContext,
	_internals as closeInternals,
	runCleanStage,
} from '../../../src/commands/close.js';
import {
	closeAllRepoMemory,
	REPO_MEMORY_FILENAME,
	syncIndexFromGraph,
} from '../../../src/tools/repo-graph/indexed-storage.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const closeRepoMemorySpy = mock(() => {
	throw new Error('simulated closeRepoMemory failure');
});
const originalCloseRepoMemory = closeInternals.closeRepoMemory;

let testDir: string;

beforeEach(() => {
	testDir = canonicalMkdtemp('close-repo-memory-throws-');
	mkdirSync(path.join(testDir, '.opencode'), { recursive: true });
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	closeRepoMemorySpy.mockClear();
	closeInternals.closeRepoMemory = closeRepoMemorySpy;
});

afterEach(() => {
	closeInternals.closeRepoMemory = originalCloseRepoMemory;
	closeAllRepoMemory();
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function cleanContext(): CloseStageContext {
	return {
		directory: testDir,
		swarmDir: path.join(testDir, '.swarm'),
		warnings: [],
		archivedActiveStateFiles: new Set([REPO_MEMORY_FILENAME]),
		archivedActiveStateDirs: new Set(),
		archiveFailureReasons: new Map(),
		projectName: 'Repo Memory Close Throws',
		isForced: false,
		planAlreadyDone: true,
	} as unknown as CloseStageContext;
}

describe('repo-memory.sqlite clean stage survives closeRepoMemory throwing', () => {
	it('keeps cleanup bounded while a real WAL handle remains open', async () => {
		const synced = await syncIndexFromGraph(
			testDir,
			{
				schema_version: '1.2.0',
				workspaceRoot: testDir,
				nodes: {},
				edges: [],
				metadata: {
					generatedAt: new Date(0).toISOString(),
					generator: 'test',
					nodeCount: 0,
					edgeCount: 0,
				},
			},
			{ size: 1, mtimeMs: 0, ino: '0' },
		);
		expect(synced).toBe(true);
		const ctx = cleanContext();

		const result = await runCleanStage(ctx);

		expect(closeRepoMemorySpy).toHaveBeenCalledTimes(1);
		if (process.platform === 'win32') {
			expect(ctx.warnings.join('\n')).toContain(
				`Failed to clean active-state file ${REPO_MEMORY_FILENAME}`,
			);
			expect(result.cleanedFiles).not.toContain(REPO_MEMORY_FILENAME);
		} else {
			expect(ctx.warnings.join('\n')).not.toContain(
				`Failed to clean active-state file ${REPO_MEMORY_FILENAME}`,
			);
			expect(result.cleanedFiles).toContain(REPO_MEMORY_FILENAME);
			expect(
				existsSync(path.join(testDir, '.swarm', REPO_MEMORY_FILENAME)),
			).toBe(false);
		}
	});
});
