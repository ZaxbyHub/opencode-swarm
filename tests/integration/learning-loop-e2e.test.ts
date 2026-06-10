/**
 * End-to-end proof of the knowledge learning loop (Changes 4-6 + retrieval).
 *
 *   capture (micro-reflection insight candidates)
 *     -> curate (Layer-5 actionability gate stores them, writes the synonym map)
 *     -> retrieve (the directive surfaces for a matching decision point)
 *     -> outcome (the directive is applied)
 *     -> observe (diagnostics telemetry reflects the whole loop)
 *
 * Deterministic and LLM-free: it exercises the real wiring, not a stub.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../src/config/schema';
import { curateAndStoreSwarm } from '../../src/hooks/knowledge-curator';
import { appendKnowledgeEvent } from '../../src/hooks/knowledge-events';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../src/hooks/knowledge-store';
import type { InsightCandidate } from '../../src/hooks/micro-reflector';
import { resolveInsightCandidatesPath } from '../../src/hooks/micro-reflector';
import { searchKnowledge } from '../../src/hooks/search-knowledge';
import { computeKnowledgeDebug } from '../../src/services/knowledge-diagnostics';

const config = KnowledgeConfigSchema.parse({});

function candidate(
	lesson: string,
	extra: Partial<InsightCandidate> = {},
): InsightCandidate {
	return {
		lesson,
		category: 'testing',
		tags: ['mocks', 'seams'],
		applies_to_agents: ['coder'],
		required_actions: ['re-run the failing test before finishing'],
		triggers: ['isolating collaborators in a unit test'],
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

describe('learning loop end-to-end (capture -> curate -> retrieve -> outcome)', () => {
	let dir: string;
	let kp: string;
	let prevXdg: string | undefined;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-loop-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		kp = resolveSwarmKnowledgePath(dir);
		prevXdg = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = path.join(dir, 'xdg');
	});

	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function seedInsights(cands: InsightCandidate[]): void {
		fs.writeFileSync(
			resolveInsightCandidatesPath(dir),
			`${cands.map((c) => JSON.stringify(c)).join('\n')}\n`,
		);
	}

	it('captures reflections, curates them into directives, retrieves a match, and records its outcome', async () => {
		// 1. CAPTURE — three already-actionable micro-reflection candidates
		//    (distinct lessons) that share the {mocks, seams} tag pair.
		seedInsights([
			candidate(
				'prefer dependency seams over module mocks when isolating tests',
			),
			candidate(
				'verify the rollback path before merging a database migration',
				{
					triggers: ['merging a database migration'],
				},
			),
			candidate(
				'run the linter before pushing a styling-only commit upstream',
				{
					triggers: ['pushing a styling change'],
					applies_to_tools: ['bash'],
				},
			),
		]);

		// 2. CURATE — the curator folds them in with no LLM; all pass the Layer-5
		//    actionability gate and activate.
		const result = await curateAndStoreSwarm(
			[],
			'proj',
			{ phase_number: 1 },
			dir,
			config,
		);
		expect(result.stored).toBe(3);
		expect(result.quarantined).toBe(0);
		const stored = await readKnowledge(kp);
		expect(stored).toHaveLength(3);

		// 2b. The curator wrote the tag co-occurrence synonym map as a side effect.
		const debug1 = await computeKnowledgeDebug(dir);
		expect(debug1.status_breakdown.active).toBe(3);
		expect(debug1.learning.synonym_pairs).toBeGreaterThan(0);
		expect(debug1.learning.unactionable_queue_depth).toBe(0);

		// 3. RETRIEVE — a coder at a test-isolation decision point. All three stored
		//    directives are in scope (agent=coder), but only the seam directive's
		//    trigger matches `currentAction`, so it must RANK FIRST. Asserting rank 0
		//    (not mere membership) means directive scoring genuinely selected it —
		//    the assertion would fail if trigger/agent matching were broken.
		const seam = stored.find((e) => e.lesson.includes('dependency seams'));
		expect(seam).toBeDefined();
		const seamId = (seam as { id: string }).id;
		const { results, trace_id } = await searchKnowledge({
			directory: dir,
			config,
			context: {
				currentPhase: 'Phase 1',
				targetAgent: 'coder',
				currentAction: 'isolating collaborators in a unit test',
				currentTool: 'edit',
			},
			mode: 'auto_injection',
			agent: 'coder',
			tier: 'swarm',
			maxResults: 5,
			emitEvent: true,
		});
		expect(results.map((r) => r.id)).toContain(seamId);
		expect(results[0]?.id).toBe(seamId);

		// 4. OUTCOME — the surfaced directive is applied.
		await appendKnowledgeEvent(dir, {
			type: 'applied',
			trace_id,
			knowledge_id: seamId,
			session_id: 's',
			agent: 'coder',
		});

		// 5. OBSERVE — the full loop is visible in diagnostics: the directive is
		//    active, a retrieval happened, and the application was recorded.
		const debug2 = await computeKnowledgeDebug(dir);
		expect(debug2.learning.events_by_type.retrieved).toBeGreaterThanOrEqual(1);
		expect(debug2.learning.events_by_type.applied).toBe(1);
	});
});
