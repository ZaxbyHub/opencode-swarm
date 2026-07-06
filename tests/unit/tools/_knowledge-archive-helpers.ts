import type {
	HiveKnowledgeEntry,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';

export function makeSwarmEntry(id: string): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `Lesson ${id} with enough characters to be valid`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'candidate',
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

export function makeHiveEntry(id: string): HiveKnowledgeEntry {
	return {
		id,
		tier: 'hive',
		lesson: `Hive Lesson ${id} with enough characters to be valid`,
		category: 'architecture',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		source_project: 'original-project',
		encounter_score: 1.5,
		retrieval_outcomes: {
			applied_count: 5,
			succeeded_after_count: 3,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

export function makeCtx(directory: string): any {
	return {
		directory,
		sessionID: 'sess-1',
		agent: 'architect',
	};
}
