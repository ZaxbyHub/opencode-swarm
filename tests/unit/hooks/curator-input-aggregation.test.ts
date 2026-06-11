/**
 * Tests for meso-reflector insight aggregation (Change 6 / Task 5.2):
 * consumeInsightCandidates (atomic consume + remainder), insightCandidateToEntry
 * (v3 → store entry), and curateAndStoreSwarm folding insights into the store
 * (deduped, no enrichment for already-actionable candidates).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import {
	consumeInsightCandidates,
	curateAndStoreSwarm,
	insightCandidateToEntry,
} from '../../../src/hooks/knowledge-curator.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import { validateActionability } from '../../../src/hooks/knowledge-validator.js';
import type { InsightCandidate } from '../../../src/hooks/micro-reflector.js';
import { resolveInsightCandidatesPath } from '../../../src/hooks/micro-reflector.js';
import {
	buildSynonymIndex,
	readSynonymMap,
	resolveSynonymMapPath,
} from '../../../src/services/synonym-map.js';

const config = KnowledgeConfigSchema.parse({});

function candidate(
	lesson: string,
	extra: Partial<InsightCandidate> = {},
): InsightCandidate {
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
		...extra,
	};
}

describe('insightCandidateToEntry', () => {
	it('builds an actionable swarm entry carrying the v3 fields', () => {
		const entry = insightCandidateToEntry(
			candidate('Re-run the failing test before declaring the fix complete'),
			'proj',
			2,
			config,
		);
		expect(entry.tier).toBe('swarm');
		expect(entry.status).toBe('candidate');
		expect(entry.applies_to_agents).toEqual(['coder']);
		expect(entry.required_actions).toEqual([
			'run the failing test before finishing',
		]);
		expect(entry.source_knowledge_ids).toEqual(['task:t-1']);
		expect(validateActionability(entry).actionable).toBe(true);
	});

	it('falls back to category "process" for an unknown category', () => {
		const entry = insightCandidateToEntry(
			candidate('Some lesson with a bogus category value attached here', {
				category: 'not-a-real-category',
			}),
			'proj',
			1,
			config,
		);
		expect(entry.category).toBe('process');
	});
});

describe('consumeInsightCandidates', () => {
	let dir: string;

	function seed(cands: InsightCandidate[]): void {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			resolveInsightCandidatesPath(dir),
			`${cands.map((c) => JSON.stringify(c)).join('\n')}\n`,
		);
	}

	function remaining(): InsightCandidate[] {
		const p = resolveInsightCandidatesPath(dir);
		if (!fs.existsSync(p)) return [];
		return fs
			.readFileSync(p, 'utf-8')
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-consume-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('returns [] when the queue file is absent', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		expect(await consumeInsightCandidates(dir)).toEqual([]);
	});

	it('consumes the whole queue and empties the file', async () => {
		seed([
			candidate('lesson one about test reruns here for length'),
			candidate('lesson two about lint gating here for length'),
		]);
		const consumed = await consumeInsightCandidates(dir);
		expect(consumed).toHaveLength(2);
		expect(remaining()).toHaveLength(0);
	});

	it('respects the batch limit and preserves the unconsumed tail', async () => {
		seed([
			candidate('lesson A about something generalizable for length'),
			candidate('lesson B about something generalizable for length'),
			candidate('lesson C about something generalizable for length'),
		]);
		const consumed = await consumeInsightCandidates(dir, 2);
		expect(consumed).toHaveLength(2);
		const rest = remaining();
		expect(rest).toHaveLength(1);
		expect(rest[0].lesson).toContain('lesson C');
	});
});

describe('curateAndStoreSwarm folds insight candidates (Task 5.2)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meso-fold-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function seedInsights(cands: InsightCandidate[]): void {
		fs.writeFileSync(
			resolveInsightCandidatesPath(dir),
			`${cands.map((c) => JSON.stringify(c)).join('\n')}\n`,
		);
	}

	it('stores already-actionable insight candidates with NO LLM enrichment', async () => {
		seedInsights([
			candidate('Always re-run the failing test file before finishing a fix'),
			candidate(
				'Run the linter before declaring a styling change complete now',
				{
					applies_to_tools: ['bash'],
					forbidden_actions: ['skip the lint step'],
					required_actions: undefined,
				},
			),
		]);
		// No retro lessons, no LLM delegate — proves insights pass the gate alone.
		const result = await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 1 },
			dir,
			config,
		);
		expect(result.stored).toBe(2);
		expect(result.quarantined).toBe(0);

		const stored = await readKnowledge(resolveSwarmKnowledgePath(dir));
		expect(stored).toHaveLength(2);
		// The queue is emptied after consumption.
		expect(
			fs.readFileSync(resolveInsightCandidatesPath(dir), 'utf-8').trim(),
		).toBe('');
	});

	it('rebuilds the tag co-occurrence synonym map from the post-store corpus (Task 6.2 write wiring)', async () => {
		// Three distinct, already-actionable candidates that all share the tag pair
		// {alpha, beta}. After they are stored, the curator must refresh
		// .swarm/synonym-map.json so retrieval can later expand along the learned
		// synonyms — this is the write side that closes the Task 6.2 loop.
		seedInsights([
			candidate(
				'Re-run the failing unit test before declaring the bug fix complete',
				{ tags: ['alpha', 'beta'] },
			),
			candidate(
				'Verify the database migration rollback path before merging the change',
				{ tags: ['alpha', 'beta'] },
			),
			candidate(
				'Check the linter output before pushing a styling-only commit upstream',
				{ tags: ['alpha', 'beta'] },
			),
		]);
		const result = await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 1 },
			dir,
			config,
		);
		expect(result.stored).toBe(3);

		// The map file now exists and encodes alpha<->beta as synonyms (co-occurred
		// across all three stored entries → count 3, the default threshold).
		expect(fs.existsSync(resolveSynonymMapPath(dir))).toBe(true);
		const map = await readSynonymMap(dir);
		const index = buildSynonymIndex(map);
		expect(index.get('alpha')).toBeDefined();
		expect(index.get('alpha')?.has('beta')).toBe(true);
		expect(index.get('beta')?.has('alpha')).toBe(true);
	});

	it('quarantines a TAMPERED insight candidate (verification_predicate / malformed shape) — never stored (regression: Phase 5 review)', async () => {
		// Simulate an attacker editing .swarm/insight-candidates.jsonl directly.
		// (1) a verification_predicate (executes subprocesses) must NOT reach the
		//     store, and (2) a malformed scope value must fail the shape gate.
		const tampered = [
			// verification_predicate smuggled — must be dropped by the explicit
			// field allowlist (never carried onto the entry).
			{
				lesson: 'Tampered lesson trying to smuggle a predicate runner here',
				category: 'process',
				tags: [],
				applies_to_agents: ['coder'],
				required_actions: ['do the thing'],
				verification_predicate: 'tool:rm -rf /',
				source: {
					kind: 'micro_reflection',
					agent: 'coder',
					outcome: 'failure_test',
					trajectory_steps: 1,
				},
				created_at: '2026-01-01T00:00:00.000Z',
			},
			// malformed scope (invalid agent name) — must fail validateActionableFields.
			{
				lesson: 'Tampered lesson with a malformed agent scope value here now',
				category: 'process',
				tags: [],
				applies_to_agents: ['not a valid agent name!!!'],
				required_actions: ['do x'],
				source: {
					kind: 'micro_reflection',
					agent: 'coder',
					outcome: 'failure_test',
					trajectory_steps: 1,
				},
				created_at: '2026-01-01T00:00:00.000Z',
			},
		];
		fs.writeFileSync(
			resolveInsightCandidatesPath(dir),
			`${tampered.map((c) => JSON.stringify(c)).join('\n')}\n`,
		);

		const result = await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 1 },
			dir,
			config,
		);

		// The malformed-shape candidate is quarantined; the predicate-bearing one
		// is stored WITHOUT the predicate (allowlist copy) — assert neither carries
		// a verification_predicate into the active store.
		expect(result.quarantined).toBeGreaterThanOrEqual(1);
		const stored = (await readKnowledge(
			resolveSwarmKnowledgePath(dir),
		)) as Array<Record<string, unknown>>;
		for (const e of stored) {
			expect(e.verification_predicate).toBeUndefined();
		}
		// The malformed-agent candidate must NOT be in the store.
		expect(
			stored.some(
				(e) =>
					(e.applies_to_agents as string[] | undefined)?.[0] ===
					'not a valid agent name!!!',
			),
		).toBe(false);
	});

	it('dedups an insight candidate against the retro lessons in the same call', async () => {
		const shared =
			'Re-run the entire suite before completing a cross-cutting refactor';
		seedInsights([candidate(shared)]);
		// The same lesson arrives as a retro prose lesson WITH a delegate that
		// makes it actionable; the insight copy must dedup (not double-store).
		const v3 = async () =>
			JSON.stringify({
				applies_to_agents: ['coder'],
				required_actions: ['run the full suite before finishing a refactor'],
			});
		const result = await curateAndStoreSwarm(
			[shared],
			'proj',
			{ phase_number: 1 },
			dir,
			config,
			{ llmDelegate: v3 },
		);
		// One stored (retro), one skipped (insight dedup).
		expect(result.stored).toBe(1);
		expect(result.skipped).toBe(1);
		const stored = await readKnowledge(resolveSwarmKnowledgePath(dir));
		expect(stored).toHaveLength(1);
	});
});
