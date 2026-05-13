/**
 * Shared test helpers for curator.ts test suites.
 * Provides common fixtures and utilities for both standard and adversarial tests.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	CuratorConfig,
	CuratorSummary,
	KnowledgeRecommendation,
} from '../../src/hooks/curator-types';
import type {
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../src/hooks/knowledge-types';

/**
 * Creates a unique temporary directory for tests.
 * Includes .swarm subdirectory creation.
 */
export function createCuratorTestDir(suffix = 'curator-test'): {
	tempDir: string;
	cleanup: () => void;
} {
	const tempDir = join(
		tmpdir(),
		`.swarm-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });

	const cleanup = (): void => {
		try {
			const { rmSync } = require('node:fs');
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	};

	return { tempDir, cleanup };
}

/**
 * Creates a valid CuratorSummary for testing.
 */
export function createValidSummary(
	overrides?: Partial<CuratorSummary>,
): CuratorSummary {
	return {
		schema_version: 1,
		session_id: 'test-session-adversarial',
		last_updated: new Date().toISOString(),
		last_phase_covered: 1,
		digest: 'test-digest-adversarial',
		phase_digests: [],
		compliance_observations: [],
		knowledge_recommendations: [],
		...overrides,
	};
}

/**
 * Creates a valid CuratorSummary for standard curator tests.
 */
export function createStandardValidSummary(
	overrides?: Partial<CuratorSummary>,
): CuratorSummary {
	return {
		schema_version: 1,
		session_id: 'test-session-123',
		last_updated: '2024-01-15T10:30:00.000Z',
		last_phase_covered: 2,
		digest: 'phase1:foo;phase2:bar',
		phase_digests: [
			{
				phase: 1,
				timestamp: '2024-01-15T09:00:00.000Z',
				summary: 'Completed Phase 1',
				agents_used: ['coder', 'reviewer'],
				tasks_completed: 5,
				tasks_total: 5,
				key_decisions: ['decision1'],
				blockers_resolved: ['blocker1'],
			},
		],
		compliance_observations: [
			{
				phase: 1,
				timestamp: '2024-01-15T10:00:00.000Z',
				type: 'missing_reviewer',
				description: 'No reviewer detected',
				severity: 'info',
			},
		],
		knowledge_recommendations: [
			{
				action: 'promote',
				entry_id: 'entry-1',
				lesson: 'Always run tests',
				reason: 'Important lesson',
			},
		],
		...overrides,
	};
}

/**
 * Creates a large valid JSON string of specified size.
 */
export function createLargeValidJson(sizeInBytes: number): string {
	const baseObj = {
		schema_version: 1,
		session_id: 'test-session-large',
		last_updated: new Date().toISOString(),
		last_phase_covered: 1,
		digest: 'x'.repeat(1000), // 1KB of digest
		phase_digests: [],
		compliance_observations: [],
		knowledge_recommendations: [],
	};

	const json = JSON.stringify(baseObj);
	// Pad to reach desired size
	const padding = ' '.repeat(Math.max(0, sizeInBytes - json.length));
	return json + padding;
}

/**
 * Creates a deeply nested object for stress testing.
 */
export function createDeepNestedObject(depth: number): Record<string, unknown> {
	let current: Record<string, unknown> = {};
	const obj = current;

	for (let i = 0; i < depth; i++) {
		current.level = i;
		current.next = {};
		current = current.next as Record<string, unknown>;
	}

	return obj;
}

/**
 * Creates a standard CuratorConfig for tests.
 */
export function createStandardCuratorConfig(
	overrides?: Partial<CuratorConfig>,
): CuratorConfig {
	return {
		enabled: true,
		init_enabled: true,
		phase_enabled: true,
		max_summary_tokens: 2000,
		min_knowledge_confidence: 0.7,
		compliance_report: true,
		suppress_warnings: true,
		drift_inject_max_chars: 500,
		...overrides,
	};
}

/**
 * Creates an adversarial CuratorConfig for stress testing.
 */
export function createAdversarialCuratorConfig(
	overrides?: Partial<CuratorConfig>,
): CuratorConfig {
	return {
		enabled: true,
		init_enabled: true,
		phase_enabled: true,
		max_summary_tokens: 1000,
		min_knowledge_confidence: 0.7,
		compliance_report: true,
		suppress_warnings: false,
		drift_inject_max_chars: 5000,
		...overrides,
	};
}

/**
 * Creates a default KnowledgeConfig for tests.
 */
export function createDefaultKnowledgeConfig(
	overrides?: Partial<KnowledgeConfig>,
): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		same_project_weight: 1.0,
		cross_project_weight: 0.5,
		min_encounter_score: 0.1,
		initial_encounter_score: 1.0,
		encounter_increment: 0.1,
		max_encounter_score: 10.0,
		...overrides,
	};
}

/**
 * Creates a SwarmKnowledgeEntry for tests.
 */
export function createKnowledgeEntry(
	id: string,
	overrides?: Partial<SwarmKnowledgeEntry>,
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `Test lesson for ${id}`,
		category: 'process',
		tags: ['test'],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'test-project',
		...overrides,
	};
}

/**
 * Writes knowledge entries to a knowledge.jsonl file.
 */
export function writeKnowledgeJsonl(
	dir: string,
	entries: SwarmKnowledgeEntry[],
): void {
	const swarmDir = join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	const jsonlContent = entries.map((e) => JSON.stringify(e)).join('\n');
	writeFileSync(join(swarmDir, 'knowledge.jsonl'), jsonlContent);
}

/**
 * Reads knowledge entries from knowledge.jsonl.
 */
export function readKnowledgeJsonl(dir: string): SwarmKnowledgeEntry[] {
	const { readFileSync, existsSync } = require('node:fs');
	const filePath = join(dir, '.swarm', 'knowledge.jsonl');
	if (!existsSync(filePath)) return [];

	const content = readFileSync(filePath, 'utf-8');
	const entries: SwarmKnowledgeEntry[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (trimmed) {
			entries.push(JSON.parse(trimmed) as SwarmKnowledgeEntry);
		}
	}
	return entries;
}

/**
 * Creates a knowledge recommendation.
 */
export function createKnowledgeRecommendation(
	action: KnowledgeRecommendation['action'],
	entryId: string,
	overrides?: Partial<KnowledgeRecommendation>,
): KnowledgeRecommendation {
	return {
		action,
		entry_id: entryId,
		lesson: 'Test lesson',
		reason: 'Test reason',
		...overrides,
	};
}

/**
 * Creates a plan.json file for phase tests.
 */
export function createPlanFile(
	dir: string,
	currentPhase: number,
	phases: Array<{
		id: number;
		name: string;
		status: string;
		tasks: Array<{
			id: string;
			phase: number;
			status: string;
			description: string;
		}>;
	}>,
): void {
	const swarmDir = join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	const plan = {
		schema_version: '1.0.0',
		title: 'Test',
		swarm: 'test',
		current_phase: currentPhase,
		phases,
	};
	writeFileSync(join(swarmDir, 'plan.json'), JSON.stringify(plan));
}

/**
 * Creates a simple plan file with one phase.
 */
export function createSimplePlan(
	dir: string,
	phase: number,
	completedTasks: number,
	totalTasks: number,
): void {
	createPlanFile(dir, phase, [
		{
			id: phase,
			name: `Phase ${phase}`,
			status: 'in_progress',
			tasks: Array.from({ length: totalTasks }, (_, i) => ({
				id: `${phase}.${i + 1}`,
				phase,
				status: i < completedTasks ? 'completed' : 'pending',
				description: `Task ${i + 1}`,
			})),
		},
	]);
}

/**
 * Creates knowledge.jsonl with many entries for stress testing.
 */
export function createKnowledgeEntriesBulk(
	count: number,
	idPrefix = 'entry',
): SwarmKnowledgeEntry[] {
	return Array.from({ length: count }, (_, i) =>
		createKnowledgeEntry(`${idPrefix}-${i}`, {
			lesson: `Lesson ${i}`,
			confidence: 0.8,
			status: 'established',
		}),
	);
}

/**
 * Creates many knowledge recommendations for stress testing.
 */
export function createKnowledgeRecommendationsBulk(
	count: number,
	actions: KnowledgeRecommendation['action'][],
	idPrefix = 'entry',
): KnowledgeRecommendation[] {
	return Array.from({ length: count }, (_, i) => ({
		action: actions[i % actions.length],
		entry_id: `${idPrefix}-${i % 100}`,
		lesson: `Recommendation ${i}`,
		reason: `Reason ${i}`,
	}));
}

/**
 * Creates a simple phase event for testing.
 */
export function createPhaseEvent(
	type: string,
	agent?: string,
	index = 0,
): object {
	const event: Record<string, unknown> = { type, index };
	if (agent) event.agent = agent;
	return event;
}

/**
 * Creates many phase events for stress testing.
 */
export function createPhaseEventsBulk(
	count: number,
	agentType: 'coder' | 'reviewer',
): object[] {
	return Array.from({ length: count }, (_, i) => ({
		type: 'agent.delegation',
		agent: i % 2 === 0 ? agentType : 'reviewer',
		timestamp: '2024-01-01T00:00:00Z',
		index: i,
	}));
}

/**
 * Writes events to events.jsonl.
 */
export function writeEventsJsonl(dir: string, events: object[]): void {
	const swarmDir = join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(
		join(swarmDir, 'events.jsonl'),
		events.map((e) => JSON.stringify(e)).join('\n'),
	);
}
