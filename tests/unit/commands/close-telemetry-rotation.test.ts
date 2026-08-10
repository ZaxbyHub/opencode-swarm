/**
 * Telemetry rotation archive/clean test (issue #2030 item 8).
 *
 * Extracted from close-cleanup.test.ts to respect the FR-006 ratchet: that file
 * is already over the 500-line cap and the telemetry.jsonl.1 addition pushed it
 * past its recorded baseline. Verifies that `/swarm close` archives AND cleans
 * both the active telemetry.jsonl and the rotated telemetry.jsonl.1, so a
 * rotated generation is not orphaned on disk.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import * as actualEvidenceManager from '../../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import * as actualState from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Mirror the mock.module setup used by close-cleanup.test.ts so
// handleCloseCommand runs without LLM/git side effects.
mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mock(async () =>
		JSON.stringify({ success: true, phase: 1, task_id: 'r', message: 'ok' }),
	),
}));
mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	...actualKnowledgeCurator,
	curateAndStoreSwarm: mock(async () => {}),
}));
mock.module('../../../src/evidence/manager.js', () => ({
	...actualEvidenceManager,
	archiveEvidence: mock(async () => {}),
}));
mock.module('../../../src/session/snapshot-writer.js', () => ({
	flushPendingSnapshot: mock(async () => {}),
}));
mock.module('../../../src/state.js', () => ({
	...actualState,
	swarmState: {
		activeToolCalls: new Map(),
		toolAggregates: new Map(),
		activeAgent: new Map(),
		delegationChains: new Map(),
		pendingEvents: 0,
		lastBudgetPct: 0,
		agentSessions: new Map(),
		pendingRehydrations: new Set(),
	},
	endAgentSession: () => {},
	resetSwarmState: () => {},
	resetSwarmStatePreservingSingletons: () => {},
	hasActiveFullAuto: () => false,
}));
mock.module('../../../src/git/branch.js', () => ({
	isGitRepo: () => false,
	getCurrentBranch: () => 'main',
	getDefaultBaseBranch: () => 'origin/main',
	hasUncommittedChanges: () => false,
	getGitRepositoryStatus: () => ({ isRepo: false }),
	resetToRemoteBranch: () => ({
		success: true,
		targetBranch: 'main',
		message: 'Already aligned with remote',
		alreadyAligned: true,
		prunedBranches: [],
		warnings: [],
	}),
	resetToMainAfterMerge: () => ({
		success: true,
		targetBranch: 'origin/main',
		message: 'Already on main',
		warnings: [],
	}),
	_internals: {
		gitExec: () => '',
		getGitRepositoryStatus: () => ({ isRepo: false }),
	},
}));
mock.module('../../../src/plan/checkpoint.js', () => ({
	writeCheckpoint: async () => {},
}));

const { handleCloseCommand } = await import('../../../src/commands/close.js');

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');

beforeEach(() => {
	testDir = canonicalMkdtemp('close-tel-rot-');
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	mock.restore();
});

function writePlan(): void {
	writeFileSync(
		path.join(swarmDir(), 'plan.json'),
		JSON.stringify({
			title: 'Telemetry Rotation',
			phases: [{ id: 1, name: 'P1', status: 'complete', tasks: [] }],
		}),
	);
}

function getLatestArchivePath(): string {
	const archiveBase = path.join(swarmDir(), 'archive');
	const entries = readdirSync(archiveBase).filter((e) =>
		e.startsWith('swarm-'),
	);
	expect(entries.length).toBeGreaterThanOrEqual(1);
	entries.sort();
	return path.join(archiveBase, entries[entries.length - 1]!);
}

describe('telemetry rotation archive/clean (issue #2030 item 8)', () => {
	it('archives and removes both telemetry.jsonl and rotated telemetry.jsonl.1', async () => {
		writePlan();
		// Stage BOTH the active and rotated generations: rotateTelemetryIfNeeded
		// renames telemetry.jsonl → telemetry.jsonl.1, so a session that crossed
		// the rotation threshold leaves exactly this pair on disk. The archive
		// must capture both as a complete ordered set, and the clean stage must
		// remove both so the rotated generation is not orphaned.
		writeFileSync(
			path.join(swarmDir(), 'telemetry.jsonl'),
			'{"event":"active","ts":2}\n',
		);
		writeFileSync(
			path.join(swarmDir(), 'telemetry.jsonl.1'),
			'{"event":"rotated","ts":1}\n',
		);

		await handleCloseCommand(testDir, []);

		const archivePath = getLatestArchivePath();
		// Both generations archived to their own names (no collision).
		expect(existsSync(path.join(archivePath, 'telemetry.jsonl'))).toBe(true);
		expect(existsSync(path.join(archivePath, 'telemetry.jsonl.1'))).toBe(true);
		// Both cleaned from source.
		expect(existsSync(path.join(swarmDir(), 'telemetry.jsonl'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'telemetry.jsonl.1'))).toBe(false);
	});
});
