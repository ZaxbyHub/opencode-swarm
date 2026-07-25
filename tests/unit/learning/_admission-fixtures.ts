/**
 * Shared fixtures for the real-time admission suites (issue #1821, Workstream B).
 *
 * Extracted so `admission-drain*.test.ts` and `admission-idempotency*.test.ts`
 * stay under the FR-006 500-line cap without each re-declaring the same config
 * literal and candidate shape. The leading underscore keeps this file out of the
 * `*.test.ts` glob, matching the existing `_dedup-sweep-helpers.ts` convention.
 *
 * These are plain builders — no mocks and no module-level mutable state — so
 * importing them cannot leak anything between test files.
 */

import * as fs from 'node:fs';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import type { InsightCandidate } from '../../../src/hooks/micro-reflector.js';
import {
	computeInsightCandidateId,
	resolveInsightCandidatesPath,
} from '../../../src/hooks/micro-reflector.js';

/**
 * One shared parsed config. FROZEN because a single object is imported by
 * several test files in one Bun process — an accidental
 * `knowledgeConfig.dedup_threshold = …` in one file would silently retune dedup
 * in all the others.
 */
export const knowledgeConfig = Object.freeze(
	KnowledgeConfigSchema.parse({}),
) as ReturnType<typeof KnowledgeConfigSchema.parse>;

/** The lesson used across the D1 suites. */
export const LESSON =
	'Re-run the failing test file before declaring a fix complete';

/** Schema defaults for `learning.realtime_admission`, overridable per test. */
export function admissionConfig(overrides: Record<string, unknown> = {}) {
	return {
		enabled: true,
		max_queue_size: 50,
		min_drain: 1,
		max_drain: 10,
		drain_depth_factor: 0.5,
		drain_velocity_factor: 0.25,
		max_llm_calls_per_session: 20,
		max_tokens_per_session: 50_000,
		max_concurrent_admissions: 2,
		max_retries_per_candidate: 1,
		per_candidate_llm_timeout_ms: 60_000,
		max_drain_wall_time_ms: 10_000,
		supersede_nudge: true,
		...overrides,
	};
}

/** A v3-actionable insight candidate. `id` is left unstamped by default. */
export function candidate(lesson: string): InsightCandidate {
	return {
		lesson,
		category: 'testing',
		tags: [],
		applies_to_agents: ['coder'],
		required_actions: ['run the failing test before finishing'],
		source: {
			kind: 'micro_reflection',
			task_id: 't-1',
			agent: 'coder',
			outcome: 'failure_test',
			trajectory_steps: 3,
		},
		created_at: '2026-01-01T00:00:00.000Z',
	};
}

/**
 * A candidate with its deterministic id stamped, mirroring what the live
 * micro-reflector writes at parse time.
 */
export function stampedCandidate(
	lesson = LESSON,
	overrides: Partial<InsightCandidate> = {},
): InsightCandidate {
	const base: InsightCandidate = { ...candidate(lesson), ...overrides };
	return { ...base, id: base.id ?? computeInsightCandidateId(base) };
}

/** Admission deps with no LLM delegate. */
export function baseDeps(phaseNumber = 2) {
	return { knowledgeConfig, projectName: 'proj', phaseNumber };
}

/** Read the persisted swarm knowledge entries for a project directory. */
export async function storedEntries(
	dir: string,
): Promise<SwarmKnowledgeEntry[]> {
	return (
		(await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		)) ?? []
	);
}

/** Write the durable insight-candidates backstop line(s). */
export function seedDurableQueue(
	dir: string,
	lines: Record<string, unknown>[],
): void {
	fs.writeFileSync(
		resolveInsightCandidatesPath(dir),
		`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
	);
}

/** A stored-entry skeleton for tests that construct knowledge.jsonl by hand. */
export function entryFixtureBase() {
	return {
		tier: 'swarm' as const,
		category: 'testing',
		tags: [],
		scope: 'global',
		confidence: 0.6,
		status: 'candidate',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: knowledgeConfig.schema_version,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'proj',
		auto_generated: true,
		applies_to_agents: ['coder'],
		required_actions: ['run the failing test before finishing'],
	};
}

/** The phase-1 confirmation record used by hand-built entry fixtures. */
export const FIXTURE_CONFIRMATION = {
	phase_number: 1,
	confirmed_at: '2026-01-01T00:00:00.000Z',
	project_name: 'proj',
};
