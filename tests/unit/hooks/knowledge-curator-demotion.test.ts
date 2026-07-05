/**
 * Verifies the G7 (#1716) demotion pass: a `promoted` entry with a sustained
 * net-negative outcome signal over consecutive phase evaluations demotes to
 * `established`. Mirrors `knowledge-curator-outcome-promotion.test.ts`.
 *
 * Covers:
 *  - Demotion after `promoted_demotion_min_negative_phases` (default 3) consecutive
 *    net-negative phases.
 *  - Counter reset on a non-negative phase (no premature demotion).
 *  - Phase-keyed dedupe: calling runAutoDemotion twice with the same phase
 *    increments the counter only once (handles curateAndStoreSwarm multi-caller).
 *  - On demotion: status → established, hive_eligible cleared, G2
 *    confidence_floor_demoted flag cleared, recent_negative_phase_count reset.
 *  - Non-promoted entries are untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import { runAutoDemotion } from '../../../src/hooks/knowledge-curator';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from '../../../src/hooks/knowledge-store';
import type {
	RetrievalOutcome,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';

let tempDir: string;
const config = KnowledgeConfigSchema.parse({});

const EMPTY_OUTCOMES: RetrievalOutcome = {
	applied_count: 0,
	succeeded_after_count: 0,
	failed_after_count: 0,
};

const NEGATIVE_OUTCOMES: RetrievalOutcome = {
	...EMPTY_OUTCOMES,
	// Strongly net-negative: 5 ignored + 4 contradicted vs 0 positives.
	// computeOutcomeSignal returns (0 - 9) / (9 + 4) ≈ -0.69, well below the
	// -0.3 default threshold.
	ignored_count: 5,
	contradicted_count: 4,
};

const POSITIVE_OUTCOMES: RetrievalOutcome = {
	...EMPTY_OUTCOMES,
	applied_explicit_count: 5,
	succeeded_after_shown_count: 3,
};

function entry(
	id: string,
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson ${id} with enough characters to be valid`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.7,
		status: 'promoted',
		confirmed_by: [],
		retrieval_outcomes: EMPTY_OUTCOMES,
		schema_version: 2,
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		project_name: 'p',
		hive_eligible: true,
		...overrides,
	};
}

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'swarm-demotion-')),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

async function seed(entries: SwarmKnowledgeEntry[]): Promise<void> {
	await rewriteKnowledge(resolveSwarmKnowledgePath(tempDir), entries);
}

async function readBack(): Promise<Map<string, SwarmKnowledgeEntry>> {
	const after = await readKnowledge<SwarmKnowledgeEntry>(
		resolveSwarmKnowledgePath(tempDir),
	);
	return new Map(after.map((e) => [e.id, e]));
}

describe('runAutoDemotion (G7 #1716)', () => {
	test('demotes a promoted entry after 3 consecutive net-negative phases', async () => {
		await seed([entry('bad', { retrieval_outcomes: NEGATIVE_OUTCOMES })]);

		// Phase 1: counter → 1, no demotion yet.
		await runAutoDemotion(tempDir, config, 1);
		let m = await readBack();
		expect(m.get('bad')!.status).toBe('promoted');
		expect(m.get('bad')!.recent_negative_phase_count).toBe(1);
		expect(m.get('bad')!.last_demotion_phase).toBe(1);

		// Phase 2: counter → 2.
		await runAutoDemotion(tempDir, config, 2);
		m = await readBack();
		expect(m.get('bad')!.status).toBe('promoted');
		expect(m.get('bad')!.recent_negative_phase_count).toBe(2);

		// Phase 3: counter → 3 → demote.
		await runAutoDemotion(tempDir, config, 3);
		m = await readBack();
		const bad = m.get('bad')!;
		expect(bad.status).toBe('established');
		expect(bad.hive_eligible).toBe(false);
		expect(bad.confidence_floor_demoted).toBe(false);
		// Counter resets on demotion so a future re-promotion gets a fresh window.
		expect(bad.recent_negative_phase_count).toBe(0);
	});

	test('phase-keyed dedupe: same phase called twice increments once', async () => {
		await seed([entry('bad', { retrieval_outcomes: NEGATIVE_OUTCOMES })]);

		// Two calls in phase 1 (simulating phase-complete + close both running
		// curateAndStoreSwarm in the same logical phase).
		await runAutoDemotion(tempDir, config, 1);
		await runAutoDemotion(tempDir, config, 1);
		const m = await readBack();
		expect(m.get('bad')!.recent_negative_phase_count).toBe(1);
		expect(m.get('bad')!.last_demotion_phase).toBe(1);
	});

	test('a non-negative phase resets the counter (no premature demotion)', async () => {
		await seed([entry('bad', { retrieval_outcomes: NEGATIVE_OUTCOMES })]);

		await runAutoDemotion(tempDir, config, 1); // neg → counter 1
		await runAutoDemotion(tempDir, config, 2); // neg → counter 2
		let m = await readBack();
		expect(m.get('bad')!.recent_negative_phase_count).toBe(2);

		// Flip to positive for phase 3 — counter resets.
		await rewriteKnowledge(resolveSwarmKnowledgePath(tempDir), [
			entry('bad', { retrieval_outcomes: POSITIVE_OUTCOMES }),
		]);
		await runAutoDemotion(tempDir, config, 3);
		m = await readBack();
		expect(m.get('bad')!.status).toBe('promoted');
		expect(m.get('bad')!.recent_negative_phase_count).toBe(0);

		// Two more negative phases alone (4, 5) are not enough — need 3 in a row.
		await rewriteKnowledge(resolveSwarmKnowledgePath(tempDir), [
			entry('bad', { retrieval_outcomes: NEGATIVE_OUTCOMES }),
		]);
		await runAutoDemotion(tempDir, config, 4);
		await runAutoDemotion(tempDir, config, 5);
		m = await readBack();
		expect(m.get('bad')!.status).toBe('promoted');
		expect(m.get('bad')!.recent_negative_phase_count).toBe(2);
	});

	test('clears the G2 confidence_floor_demoted flag on demotion', async () => {
		// A promoted entry that is BOTH confidence-floor-demoted (G2) and
		// sustained-negative (G7). After G7 demotion, the G2 flag is stale
		// (the entry is no longer promoted) and must be cleared.
		await seed([
			entry('both', {
				retrieval_outcomes: NEGATIVE_OUTCOMES,
				confidence_floor_demoted: true,
				recent_negative_phase_count: 2,
			}),
		]);

		await runAutoDemotion(tempDir, config, 10);
		const m = await readBack();
		const both = m.get('both')!;
		expect(both.status).toBe('established');
		expect(both.confidence_floor_demoted).toBe(false);
	});

	test('does not touch non-promoted entries', async () => {
		await seed([
			entry('promoted-bad', { retrieval_outcomes: NEGATIVE_OUTCOMES }),
			entry('established', {
				id: 'established-id',
				status: 'established',
				hive_eligible: false,
				retrieval_outcomes: NEGATIVE_OUTCOMES,
			} as Partial<SwarmKnowledgeEntry>),
			entry('candidate', {
				id: 'candidate-id',
				status: 'candidate',
				hive_eligible: false,
				retrieval_outcomes: NEGATIVE_OUTCOMES,
			} as Partial<SwarmKnowledgeEntry>),
		]);

		await runAutoDemotion(tempDir, config, 1);
		const m = await readBack();
		// Only the promoted entry had its counter incremented by runAutoDemotion.
		// (normalizeEntry defaults the field to 0 on read for all entries, so the
		// non-promoted entries show 0, not undefined.)
		expect(m.get('promoted-bad')!.recent_negative_phase_count).toBe(1);
		expect(m.get('promoted-bad')!.last_demotion_phase).toBe(1);
		expect(m.get('established-id')!.status).toBe('established');
		expect(m.get('established-id')!.last_demotion_phase).toBeUndefined();
		expect(m.get('candidate-id')!.status).toBe('candidate');
		expect(m.get('candidate-id')!.last_demotion_phase).toBeUndefined();
	});
});
