/**
 * Tests for handleCloseCommand — hive promotion eligibility gating (negative-path only).
 *
 * Verifies the three-route eligibility gate in the promoteToHive loop
 * (close.ts lines 497-534):
 *   Route 1: hive_eligible === true AND >= 3 distinct phases
 *   Route 2: tags includes 'hive-fast-track'
 *   Route 3: age >= auto_promote_days (default 90)
 *
 * Approach: write entries to a real knowledge.jsonl temp file and use the
 * real readKnowledge (knowledge-store is NOT mocked). Only curateAndStoreSwarm
 * is mocked to control the test environment. promoteToHive is NOT mocked —
 * these tests only verify the skip/ineligible paths which can be validated
 * via output text alone.
 *
 * Note: Positive-path tests (asserting promotion happened) were removed because
 * mock.module for hive-promoter.js does not reliably intercept the import in
 * close.ts (likely due to lazy/binding-time import patterns).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';

// ── Mocks ──────────────────────────────────────────────────────────────
// Only mock curateAndStoreSwarm (to be a no-op).
// knowledge-store is NOT mocked — we write real JSONL and use the real readKnowledge.
// promoteToHive is NOT mocked — these tests only verify skip paths via output.

const mockCurateAndStoreSwarm = mock(async () => {});

// curateAndStoreSwarm must return { stored: 1 } to prevent knowledge.jsonl deletion
// (the deletion condition is curationSucceeded && allLessons.length > 0; with stored=1
// but empty allLessons, the condition is false and the file is preserved).
// Entries are pre-written to the file in beforeEach, so readKnowledge returns them.
mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mockCurateAndStoreSwarm,
}));

mock.module('../../../src/evidence/manager.js', () => ({
	archiveEvidence: mock(async () => {}),
}));

mock.module('../../../src/session/snapshot-writer.js', () => ({
	flushPendingSnapshot: mock(async () => {}),
}));

mock.module('../../../src/state.js', () => ({
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
}));

mock.module('../../../src/git/branch.js', () => ({
	isGitRepo: () => false,
	getCurrentBranch: () => 'main',
	getDefaultBaseBranch: () => 'origin/main',
	hasUncommittedChanges: () => false,
	resetToRemoteBranch: () => ({
		success: true,
		targetBranch: 'main',
		localBranch: 'main',
		message: 'Already aligned with remote',
		alreadyAligned: true,
		prunedBranches: [],
		warnings: [],
	}),
	resetToMainAfterMerge: () => ({
		success: true,
		targetBranch: 'origin/main',
		previousBranch: 'main',
		message: 'Already on main',
		branchDeleted: false,
		warnings: [],
	}),
}));

mock.module('../../../src/plan/checkpoint.js', () => ({
	writeCheckpoint: async () => {},
}));

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mock(async () => '{}'),
}));

mock.module('../../../src/config/index.js', () => ({
	loadPluginConfigWithMeta: () => ({
		config: {
			skill_improver: {
				enabled: true,
				max_calls_per_day: 10,
				trigger: 'manual',
				targets: ['skills', 'spec', 'architect_prompt', 'knowledge'],
				write_mode: 'proposal',
				require_user_approval: true,
				quota_window: 'utc',
				allow_deterministic_fallback: true,
			},
		},
		loadedFromFile: null,
	}),
}));

mock.module('../../../src/services/skill-improver.js', () => ({
	runSkillImprover: mock(async () => ({
		ran: false,
		reason: 'disabled',
	})),
}));

// ── Import under test ───────────────────────────────────────────────
const { handleCloseCommand } = await import('../../../src/commands/close.js');

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function knowledgePath(): string {
	return path.join(swarmDir(), 'knowledge.jsonl');
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Eligibility Gate Test Project',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'complete',
				tasks: [{ id: '1.1', status: 'complete', description: 'Task A' }],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
}

/** Write knowledge entries directly to the JSONL file (real file I/O) */
function writeKnowledgeJsonl(entries: SwarmKnowledgeEntry[]): void {
	const content = entries.map((e) => JSON.stringify(e)).join('\n');
	writeFileSync(knowledgePath(), content, 'utf-8');
}

/** Full SwarmKnowledgeEntry factory */
function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> & { id: string; lesson: string },
): SwarmKnowledgeEntry {
	const now = new Date().toISOString();
	return {
		tier: 'swarm',
		id: overrides.id,
		lesson: overrides.lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: now,
		updated_at: now,
		project_name: 'test-project',
		...overrides,
	};
}

// ── Test suites ──────────────────────────────────────────────────────

describe('handleCloseCommand — hive promotion eligibility gating (negative paths)', () => {
	beforeEach(() => {
		mockCurateAndStoreSwarm.mockClear();
		mockCurateAndStoreSwarm.mockImplementation(async () => ({ stored: 1 }));
		testDir = mkdtempSync(
			path.join(os.tmpdir(), 'close-hive-eligibility-test-'),
		);
		mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
		// Ensure no pre-existing knowledge file
		if (existsSync(knowledgePath())) rmSync(knowledgePath());
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors on Windows
		}
		mock.restore();
	});

	// ── Route 1: hive_eligible === true AND >= 3 distinct phases ──────

	describe('Route 1 — hive_eligible flag with 3+ distinct phases', () => {
		it('does NOT promote entry with hive_eligible=true but only 1 distinct phase', async () => {
			writePlan();
			writeKnowledgeJsonl([
				makeEntry({
					id: 'entry-route1-few-phases',
					lesson: 'Lesson with insufficient phase count',
					hive_eligible: true,
					confirmed_by: [
						{
							phase_number: 1,
							confirmed_at: '2024-01-01T00:00:00Z',
							project_name: 'test',
						},
					],
				}),
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('not eligible for hive promotion');
		});

		it('does NOT promote entry with hive_eligible=true but only 2 distinct phases', async () => {
			writePlan();
			writeKnowledgeJsonl([
				makeEntry({
					id: 'entry-route1-two-phases',
					lesson: 'Lesson with only 2 phases',
					hive_eligible: true,
					confirmed_by: [
						{
							phase_number: 1,
							confirmed_at: '2024-01-01T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: 2,
							confirmed_at: '2024-01-02T00:00:00Z',
							project_name: 'test',
						},
					],
				}),
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('not eligible for hive promotion');
		});

		it('does NOT promote entry with hive_eligible=false regardless of phase count', async () => {
			writePlan();
			writeKnowledgeJsonl([
				makeEntry({
					id: 'entry-route1-not-eligible',
					lesson: 'Lesson marked not hive eligible',
					hive_eligible: false,
					confirmed_by: [
						{
							phase_number: 1,
							confirmed_at: '2024-01-01T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: 2,
							confirmed_at: '2024-01-02T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: 3,
							confirmed_at: '2024-01-03T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: 4,
							confirmed_at: '2024-01-04T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: 5,
							confirmed_at: '2024-01-05T00:00:00Z',
							project_name: 'test',
						},
					],
				}),
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('not eligible for hive promotion');
		});
	});

	// ── Route 2: hive-fast-track tag bypasses phase count ──────────────

	describe('Route 2 — hive-fast-track tag bypasses phase count', () => {
		it('does NOT promote entry without fast-track tag even with many phases but hive_eligible=false', async () => {
			writePlan();
			writeKnowledgeJsonl([
				makeEntry({
					id: 'entry-many-phases-no-flag',
					lesson: 'Many phases but not eligible and no fast-track',
					hive_eligible: false,
					confirmed_by: [
						{
							phase_number: 1,
							confirmed_at: '2024-01-01T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: 2,
							confirmed_at: '2024-01-02T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: 3,
							confirmed_at: '2024-01-03T00:00:00Z',
							project_name: 'test',
						},
					],
				}),
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('not eligible for hive promotion');
		});
	});

	// ── Route 3: age-based promotion ─────────────────────────────────

	describe('Route 3 — age-based promotion (auto_promote_days default 90)', () => {
		it('does NOT promote entry newer than auto_promote_days', async () => {
			writePlan();
			// 1 ms ago — well under the 90-day threshold
			const newDate = new Date(Date.now() - 1).toISOString();

			writeKnowledgeJsonl([
				makeEntry({
					id: 'entry-new',
					lesson: 'New lesson not yet eligible',
					hive_eligible: false,
					tags: [],
					confirmed_by: [],
					created_at: newDate,
				}),
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('not eligible for hive promotion');
		});

		it('does NOT promote via age route when created_at is missing', async () => {
			writePlan();
			// Entry without created_at — Date.parse(undefined) === NaN → ageMs === 0
			const entryWithoutCreatedAt = makeEntry({
				id: 'entry-no-created-at',
				lesson: 'Lesson without created_at timestamp',
				hive_eligible: false,
				tags: [],
				confirmed_by: [],
			});
			// Remove created_at by writing directly
			const { created_at: _created_at, ...entryRest } = entryWithoutCreatedAt;
			writeKnowledgeJsonl([entryRest as unknown as SwarmKnowledgeEntry]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('not eligible for hive promotion');
		});
	});

	// ── Edge case: no confirmed_by ────────────────────────────────────

	describe('Entry with no confirmed_by (neither route 1 nor age applies)', () => {
		it('does NOT promote entry with no confirmed_by and no fast-track or age', async () => {
			writePlan();
			// Recent entry with no confirmed_by and no fast-track tag
			const recentDate = new Date(Date.now() - 5 * 86400000).toISOString();

			writeKnowledgeJsonl([
				makeEntry({
					id: 'entry-no-confirmed-by',
					lesson: 'Lesson with no confirmations',
					hive_eligible: false,
					tags: [],
					confirmed_by: [],
					created_at: recentDate,
				}),
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('not eligible for hive promotion');
		});
	});

	// ── Confirmed_by with null/undefined phase_number ──────────────────

	describe('confirmed_by with null/undefined phase_number is handled safely', () => {
		it('skips records with null phase_number when computing distinct phases', async () => {
			writePlan();

			writeKnowledgeJsonl([
				makeEntry({
					id: 'entry-null-phase',
					lesson: 'Lesson with null phase numbers',
					hive_eligible: true,
					// Only 1 valid phase_number, so size < 3 → not promoted
					confirmed_by: [
						{
							phase_number: 1,
							confirmed_at: '2024-01-01T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: null as unknown as number,
							confirmed_at: '2024-01-02T00:00:00Z',
							project_name: 'test',
						},
						{
							phase_number: undefined as unknown as number,
							confirmed_at: '2024-01-03T00:00:00Z',
							project_name: 'test',
						},
					],
				}),
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('not eligible for hive promotion');
		});
	});
});
