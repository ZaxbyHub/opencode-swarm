import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock knowledge-store — required because quarantine/restore handlers now call readKnowledge
// to resolve prefix matches before delegating to the backend.
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

export function setupMocks() {
	mock.module('../../../src/hooks/knowledge-store.js', () => ({
		readKnowledge: (path: string) => mockReadKnowledge(path),
		resolveSwarmKnowledgePath: (dir: string) =>
			mockResolveSwarmKnowledgePath(dir),
		enforceKnowledgeCap: async () => {},
		sweepAgedEntries: async () => {},
		sweepStaleTodos: async () => {},
		bumpKnowledgeConfidenceBatch: async () => {},
	}));

	mock.module('../../../src/hooks/knowledge-validator.js', () => ({
		quarantineEntry: mockQuarantineEntry,
		restoreEntry: mockRestoreEntry,
		unarchiveEntry: mockUnarchiveEntry,
	}));

	mock.module('../../../src/hooks/knowledge-migrator.js', () => ({
		migrateContextToKnowledge: mockMigrate,
	}));
}

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
