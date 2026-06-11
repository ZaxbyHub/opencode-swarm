/**
 * Adversarial test: the phase_complete critical-directive override is
 * architect-only (Swarm Learning System, Change 2 / Task 2.4).
 *
 * A non-architect caller (or a name crafted to look architect-ish) must NOT be
 * able to accept_violations away a critical directive block. The override is
 * denied and no `override` event is logged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readKnowledgeEvents } from '../../src/hooks/knowledge-events.js';
import { executePhaseComplete } from '../../src/tools/phase-complete.js';

const PHASE = 'Phase 2';

function entryLine(id: string): string {
	return JSON.stringify({
		id,
		tier: 'swarm',
		lesson: `lesson ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.9,
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
		directive_priority: 'critical',
	});
}

function events(id: string): string {
	return [
		JSON.stringify({
			type: 'retrieved',
			event_id: 'r-1',
			trace_id: 't',
			timestamp: '2026-02-01T00:00:00.000Z',
			session_id: 's',
			phase: PHASE,
			agent: 'coder',
			query: 'q',
			retrieval_mode: 'delegate_inject',
			result_ids: [id],
			ranks: {},
			scores: {},
		}),
		JSON.stringify({
			type: 'violated',
			event_id: `v-${id}`,
			trace_id: 't',
			knowledge_id: id,
			timestamp: '2026-02-01T00:02:00.000Z',
			session_id: 's',
			agent: 'coder',
			reason: 'forbidden pattern',
		}),
	].join('\n');
}

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
	return fs.mkdtempSync(path.join(baseDir, 'pc-spoof-'));
}

describe('phase_complete override spoofing', () => {
	let dir: string;

	beforeEach(() => {
		dir = createRelativeTempDir();
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), entryLine('c1'));
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			`${events('c1')}\n`,
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// Genuine non-architect identities. Note: the agent name comes from the
	// framework-controlled tool ctx, and is canonicalized via getCanonicalAgentRole
	// (so `mega_coder`→`coder`). A real subagent therefore canonicalizes to its
	// true non-architect role. `architect_evil` is NOT a canonical architect.
	for (const spoofed of [
		'coder',
		'mega_coder',
		'reviewer',
		'test_engineer',
		'sme',
		'critic',
		'architect_evil',
	]) {
		it(`denies override from non-architect caller "${spoofed}"`, async () => {
			const out = await executePhaseComplete(
				{
					phase: 2,
					sessionID: 'sess-spoof',
					callerAgent: spoofed,
					acceptViolations: ['c1'],
					acceptViolationsJustification: 'trust me',
				},
				dir,
				dir,
			);
			const parsed = JSON.parse(out);
			expect(parsed.reason).toBe('override_denied_non_architect');

			// No override event was logged.
			const evs = await readKnowledgeEvents(dir);
			expect(evs.filter((e) => e.type === 'override').length).toBe(0);
		});
	}

	it('allows the genuine architect to override (control)', async () => {
		const out = await executePhaseComplete(
			{
				phase: 2,
				sessionID: 'sess-ok',
				callerAgent: 'architect',
				acceptViolations: ['c1'],
				acceptViolationsJustification: 'tracked follow-up',
			},
			dir,
			dir,
		);
		const parsed = JSON.parse(out);
		expect(parsed.reason).not.toBe('override_denied_non_architect');
		expect(parsed.reason).not.toBe('unresolved_critical_directives');
		const evs = await readKnowledgeEvents(dir);
		expect(evs.filter((e) => e.type === 'override').length).toBe(1);
	});
});
