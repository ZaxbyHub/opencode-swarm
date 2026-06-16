/**
 * End-to-end proof of the repeat-mistake prevention loop (Change 3).
 *
 * When the same directive is violated twice within the window, the escalator
 * promotes it to critical/enforce, records the escalation, AND the next
 * retrieval force-includes it — even past higher-ranked, trigger-matching
 * siblings that would otherwise crowd it out of the result cap. This stitches
 * the escalator, the unified retrieval core, and the diagnostics telemetry.
 *
 * The store is deliberately built so the escalated directive (`d1`) scores
 * BELOW the result cap before escalation: `d1` matches the decision point by
 * agent only, while two distractor directives (`d2`/`d3`) also match by trigger
 * (a strictly stronger directive signal). With `maxResults: 2`, `d1` is excluded
 * pre-escalation and can only re-enter — at rank 0 — via the critical
 * force-include path. That makes the assertions non-vacuous.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../src/config/schema';
import { maybeEscalateOnViolation } from '../../src/hooks/knowledge-escalator';
import { readKnowledgeEvents } from '../../src/hooks/knowledge-events';
import { searchKnowledge } from '../../src/hooks/search-knowledge';
import { computeKnowledgeDebug } from '../../src/services/knowledge-diagnostics';

const config = KnowledgeConfigSchema.parse({});
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T00:00:00.000Z');

// Low confidence (< the 0.75 directive-boost threshold) so no confidence boost
// is added — this keeps an agent-only match BELOW the saturation clamp, so the
// extra trigger signal on the distractors genuinely out-ranks d1.
const LOW_CONF = 0.4;

function directiveLine(
	id: string,
	withTrigger: boolean,
	lesson: string,
): string {
	return JSON.stringify({
		id,
		tier: 'swarm',
		// Distinct lessons so the near-duplicate merge does not collapse them.
		lesson,
		category: 'process',
		tags: ['testing'],
		scope: 'global',
		confidence: LOW_CONF,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'test',
		directive_priority: 'medium',
		enforcement_mode: 'warn',
		// All three are in scope for a coder (agent match). Only d2/d3 additionally
		// match the decision point's `currentAction` via their trigger.
		applies_to_agents: ['coder'],
		...(withTrigger
			? { triggers: ['isolating the failing collaborator'] }
			: {}),
		required_actions: ['re-run the failing test file'],
	});
}

function violatedLine(id: string, ms: number): string {
	return JSON.stringify({
		type: 'violated',
		event_id: `v-${id}-${ms}`,
		trace_id: 't',
		knowledge_id: id,
		timestamp: new Date(ms).toISOString(),
		session_id: 's',
		agent: 'coder',
	});
}

const DECISION_CONTEXT = {
	currentPhase: 'Phase 2',
	targetAgent: 'coder',
	currentAction: 'isolating the failing collaborator',
	currentTool: 'edit',
} as const;

async function resultIds(dir: string): Promise<string[]> {
	const { results } = await searchKnowledge({
		directory: dir,
		config,
		context: DECISION_CONTEXT,
		mode: 'auto_injection',
		agent: 'architect',
		tier: 'swarm',
		// Cap below the in-scope entry count so ranking — not scope — decides
		// membership, and the force-include is observable.
		maxResults: 2,
		emitEvent: false,
	});
	return results.map((r) => r.id);
}

function readEntry(swarmDir: string, id: string): Record<string, unknown> {
	const line = fs
		.readFileSync(path.join(swarmDir, 'knowledge.jsonl'), 'utf-8')
		.trim()
		.split('\n')
		.find((l) => JSON.parse(l).id === id);
	return JSON.parse(line as string);
}

describe('repeat-mistake prevention (Change 3, end-to-end)', () => {
	let dir: string;
	let swarmDir: string;
	let prevXdg: string | undefined;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-mistake-'));
		swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		// d1: agent-only match (the directive that will be violated). d2/d3:
		// agent + trigger match → strictly higher directive score, so they fill the
		// 2-slot result cap and d1 is excluded until it is escalated.
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			`${directiveLine(
				'd1',
				false,
				'always re-run the failing unit test before calling the fix complete',
			)}\n${directiveLine(
				'd2',
				true,
				'check the database rollback path prior to merging a schema migration',
			)}\n${directiveLine(
				'd3',
				true,
				'run the linter and formatter before pushing any styling-only change',
			)}\n`,
		);
		prevXdg = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = path.join(dir, 'xdg');
	});

	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('a twice-violated directive is escalated to enforce and force-included past higher-ranked siblings', async () => {
		// Baseline: d1 scores below the cap and is excluded — the trigger-matching
		// siblings fill both slots.
		const before = await resultIds(dir);
		expect(before).not.toContain('d1');
		expect(before).toHaveLength(2);

		// Two violations of d1 within the window.
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			`${violatedLine('d1', NOW.getTime() - 2 * DAY)}\n${violatedLine(
				'd1',
				NOW.getTime() - 1 * DAY,
			)}\n`,
		);

		const result = await maybeEscalateOnViolation(dir, 'd1', NOW);
		expect(result.escalated).toBe(true);
		expect(result.to).toBe('critical');

		// d1 is now enforce/critical with one escalation record; the siblings are
		// untouched.
		const d1 = readEntry(swarmDir, 'd1');
		expect(d1.enforcement_mode).toBe('enforce');
		expect(d1.directive_priority).toBe('critical');
		expect((d1.escalation_history as unknown[]).length).toBe(1);
		expect(readEntry(swarmDir, 'd2').enforcement_mode).toBe('warn');

		// An escalation event was emitted.
		const events = await readKnowledgeEvents(dir);
		expect(events.some((e) => e.type === 'escalation')).toBe(true);

		// Retrieval now force-includes d1 at rank 0 — it can ONLY enter the 2-slot
		// result (let alone lead it) because it is critical and matches the context;
		// it even carries a negative outcome from its two violations.
		const after = await resultIds(dir);
		expect(after).toContain('d1');
		expect(after[0]).toBe('d1');

		// Diagnostics reflects the new enforcement posture (only d1).
		const debug = await computeKnowledgeDebug(dir);
		expect(debug.learning.enforced_directives).toBe(1);
		expect(debug.learning.escalated_directives).toBe(1);
	});

	it('a single violation neither escalates nor force-includes the directive', async () => {
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			`${violatedLine('d1', NOW.getTime() - 1 * DAY)}\n`,
		);
		const result = await maybeEscalateOnViolation(dir, 'd1', NOW);
		expect(result.escalated).toBe(false);

		const d1 = readEntry(swarmDir, 'd1');
		expect(d1.enforcement_mode).toBe('warn');
		expect(d1.directive_priority).toBe('medium');

		// Still below the cap and not critical → still excluded from retrieval.
		expect(await resultIds(dir)).not.toContain('d1');

		const debug = await computeKnowledgeDebug(dir);
		expect(debug.learning.enforced_directives).toBe(0);
		expect(debug.learning.escalated_directives).toBe(0);
	});
});
