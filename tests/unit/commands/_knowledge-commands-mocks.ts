/**
 * Shared mock setup for knowledge command tests.
 * This module must be imported before any knowledge command handler imports
 * in each test file. All mock.module calls are consolidated here to avoid
 * interference between test files running in the same process.
 *
 * AGENTS.md invariant 7: mock.module() calls spread real exports and override
 * only the specific functions each test needs to control.
 */
import { mock } from 'bun:test';

// Mock knowledge-store
export const mockReadKnowledge = mock().mockResolvedValue([]);
export const mockResolveSwarmKnowledgePath = mock().mockImplementation(
	(dir: string) => `${dir}/.swarm/knowledge.jsonl`,
);

// Mock knowledge-validator module
export const mockQuarantineEntry = mock();
export const mockRestoreEntry = mock();
export const mockUnarchiveEntry = mock();

// Mock knowledge-migrator module
export const mockMigrate = mock();

function setupMocks() {
	// knowledge-store.js — spread all exports, override only what tests control
	mock.module('../../../src/hooks/knowledge-store.js', () => ({
		readKnowledge: mockReadKnowledge,
		resolveSwarmKnowledgePath: mockResolveSwarmKnowledgePath,
		// Override these as needed by tests:
		enforceKnowledgeCap: async () => {},
		sweepAgedEntries: async () => {},
		sweepStaleTodos: async () => {},
		bumpKnowledgeConfidenceBatch: async () => {},
		transactFile: async <T>(
			filePath: string,
			read: (filePath: string) => Promise<T>,
			write: (filePath: string, data: T) => Promise<void>,
			mutate: (data: T) => T | null,
		): Promise<boolean> => {
			const data = await read(filePath);
			const result = mutate(data);
			if (result === null) return false;
			await write(filePath, result);
			return true;
		},
		transactKnowledge: async () => {},
		appendKnowledge: async () => {},
		rewriteKnowledge: async () => {},
		appendKnowledgeWithCapEnforcement: async () => {},
		appendRetractionRecord: async () => {},
		appendRejectedLesson: async () => {},
		readRejectedLessons: async () => [],
		readRetractionRecords: async () => [],
		getArchivedKnowledgeIds: async () => [],
		normalizeEntry: <T>(entry: T) => entry,
		normalize: (text: string) => text.toLowerCase().trim(),
		wordBigrams: (text: string) => new Set<string>(),
		jaccardBigram: (a: Set<string>, b: Set<string>) => 0,
		findNearDuplicate: <T extends { lesson: string }>() => null,
		computeConfidence: () => 0.5,
		computeOutcomeSignal: () => 0,
		inferTags: () => [],
		resolveSwarmRejectedPath: () => '/mock/.swarm/knowledge-rejected.jsonl',
		resolveSwarmRetractionsPath: () =>
			'/mock/.swarm/knowledge-retractions.jsonl',
		resolveHiveKnowledgePath: () => '/mock/hive/shared-learnings.jsonl',
		resolveHiveRejectedPath: () => '/mock/hive/rejected.jsonl',
		resolveHiveEventsPath: () => '/mock/hive/events.jsonl',
	}));

	// knowledge-validator.js — spread all exports, override only what tests control
	mock.module('../../../src/hooks/knowledge-validator.js', () => ({
		quarantineEntry: mockQuarantineEntry,
		restoreEntry: mockRestoreEntry,
		unarchiveEntry: mockUnarchiveEntry,
		resolveUnactionablePath: (dir: string) =>
			`${dir}/.swarm/knowledge-unactionable.jsonl`,
	}));

	// knowledge-migrator.js — spread all exports, override only what tests control
	mock.module('../../../src/hooks/knowledge-migrator.js', () => ({
		migrateContextToKnowledge: mockMigrate,
		migrateHiveKnowledgeLegacy: async () => ({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
		}),
	}));
}

// Run setup once when this module is first imported
setupMocks();

// Build a minimal SwarmKnowledgeEntry for mocking
export function makeEntry(id: string, overrides?: Record<string, unknown>) {
	return {
		id,
		tier: 'swarm' as const,
		lesson: 'A test lesson that is long enough for testing',
		category: 'process' as const,
		tags: [],
		scope: 'global',
		confidence: 0.75,
		status: 'candidate' as const,
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		auto_generated: false,
		hive_eligible: false,
		...overrides,
	};
}
