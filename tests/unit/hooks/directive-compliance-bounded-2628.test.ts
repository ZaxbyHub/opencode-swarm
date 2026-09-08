/**
 * Issue #2628 regression tests — the reviewer "directives to verify" pipeline
 * is per-entry bounded:
 *
 * - readPhaseDirectivesToVerify dedupes to ONE obligation per entry
 *   (deterministic representative selection).
 * - buildDirectiveComplianceBlock renders under a hard char budget; overflow
 *   drops non-criticals with a count note and NEVER drops a critical (distinct
 *   overflow notice when criticals alone exceed the budget).
 * - evaluatePhaseCriticalDirectives resolves a critical ENTRY when a sibling
 *   membership carries a satisfying terminal, with later-applied-remediates
 *   semantics for violated siblings.
 * - Reconciliation stays consistent with the shown block on both the Task
 *   path (parse of the shown block) and the lane-settle path (fresh read).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import {
	buildDirectiveComplianceBlock,
	DIRECTIVE_COMPLIANCE_DEFAULT_CHAR_BUDGET,
	DIRECTIVE_COMPLIANCE_HARD_CHAR_CAP,
	type DirectiveToVerify,
	parseDirectivesToVerifyBlock,
} from '../../../src/agents/reviewer-directive-compliance.js';
import { appendKnowledgeEvent } from '../../../src/hooks/knowledge-events.js';
import {
	commitDisplayedMembership,
	_internals as ledgerInternals,
	queryLiveMemberships,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { evaluatePhaseCriticalDirectives } from '../../../src/hooks/phase-complete-directive-gate.js';
import {
	type DirectiveCandidate,
	isPreferredDirectiveCandidate,
	pickDirectiveRepresentatives,
	readEntriesById,
	readPhaseDirectivesToVerify,
} from '../../../src/hooks/phase-directives.js';
import { reconcileReviewerVerdicts } from '../../../src/hooks/reviewer-verdict-parser.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let dir: string;
let prevHome: string | undefined;
let prevLocalAppData: string | undefined;
let prevXdgDataHome: string | undefined;
let traceSequence: number;

function makeEntry(
	id: string,
	priority: SwarmKnowledgeEntry['directive_priority'],
	lesson = `Lesson for ${id} — always validate inputs before processing`,
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: ['validation'],
		scope: 'global',
		confidence: 0.85,
		status: 'established',
		confirmed_by: [],
		project_name: 'issue-2628',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
			shown_count: 0,
			applied_explicit_count: 0,
			ignored_count: 0,
		},
		schema_version: 2,
		created_at: '2026-09-07T00:00:00.000Z',
		updated_at: '2026-09-07T00:00:00.000Z',
		directive_priority: priority,
	};
}

async function seedDisplay(
	phase: string,
	traceId: string,
	entryIds: string[],
	sessionId = 'session-1',
): Promise<void> {
	const entries = await readEntriesById(dir);
	const displayed = await commitDisplayedMembership(dir, {
		trace_id: traceId,
		session_id: sessionId,
		agent: 'architect',
		phase,
		entries: entryIds.map((entry_id, index) => ({
			entry_id,
			critical: entries.get(entry_id)?.directive_priority === 'critical',
			rank: index + 1,
			score: 1.0 - index * 0.1,
		})),
	});
	if (!displayed.ok) throw new Error(displayed.detail);
}

async function seedTerminal(
	traceId: string,
	entryId: string,
	outcome: 'applied' | 'violated' | 'contradicted',
	sessionId = 'session-1',
): Promise<void> {
	const terminal = await validateAndCommitTerminalBatch(dir, {
		trace_id: traceId,
		session_id: sessionId,
		items: [{ entry_id: entryId, outcome }],
	});
	if (!terminal.ok) throw new Error(terminal.detail);
}

beforeEach(async () => {
	dir = canonicalMkdtemp('directive-bounded-2628-');
	writeFileSync(path.join(dir, '.git'), 'gitdir: fixture');
	traceSequence = 0;
	prevHome = process.env.HOME;
	prevLocalAppData = process.env.LOCALAPPDATA;
	prevXdgDataHome = process.env.XDG_DATA_HOME;
	const isolatedHome = path.join(dir, 'home');
	await mkdir(isolatedHome, { recursive: true });
	process.env.HOME = isolatedHome;
	process.env.LOCALAPPDATA = path.join(dir, 'localappdata');
	process.env.XDG_DATA_HOME = path.join(dir, 'xdg-data');
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = prevLocalAppData;
	if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = prevXdgDataHome;
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function nextTrace(): string {
	return `trace-${String(++traceSequence).padStart(3, '0')}`;
}

describe('#2628 per-entry dedupe (readPhaseDirectivesToVerify)', () => {
	it('returns one directive per entry across many traces', async () => {
		const kp = resolveSwarmKnowledgePath(dir);
		const ids = [
			'directive-2628-a-0000-000000000001',
			'directive-2628-b-0000-000000000002',
			'directive-2628-c-0000-000000000003',
		];
		for (const [index, id] of ids.entries()) {
			await appendKnowledge(
				kp,
				makeEntry(id, index === 0 ? 'critical' : 'high'),
			);
		}
		for (let t = 0; t < 8; t++) {
			await seedDisplay('Phase 1', nextTrace(), ids);
		}

		const directives = await readPhaseDirectivesToVerify(dir, 'Phase 1');

		expect(directives).toHaveLength(3);
		expect(new Set(directives.map((d) => d.entry_id)).size).toBe(3);
	});

	it('prefers a violated membership as the entry representative', async () => {
		const kp = resolveSwarmKnowledgePath(dir);
		const id = 'directive-2628-rem-0000-000000000004';
		await appendKnowledge(kp, makeEntry(id, 'critical'));
		// Oldest trace carries the violated terminal; newer traces stay live.
		await seedDisplay('Phase 1', 'trace-rem-old', [id]);
		await seedTerminal('trace-rem-old', id, 'violated');
		await seedDisplay('Phase 1', 'trace-rem-mid', [id]);
		await seedDisplay('Phase 1', 'trace-rem-new', [id]);

		const directives = await readPhaseDirectivesToVerify(dir, 'Phase 1');

		expect(directives).toHaveLength(1);
		expect(directives[0]).toMatchObject({
			trace_id: 'trace-rem-old',
			entry_id: id,
			prior_terminal_outcome: 'violated',
		});
		expect(directives[0]?.prior_terminal_event_id).toBeString();
	});

	it('breaks committed_at ties by greatest trace_id (pure helper)', () => {
		const directive = (traceId: string): DirectiveCandidate => ({
			committed_at: '2026-09-07T00:00:00.000Z',
			directive: {
				trace_id: traceId,
				entry_id: 'directive-2628-tie',
				session_id: 'session-1',
				priority: 'high',
			},
		});
		const candidates = [directive('trace-aaa'), directive('trace-zzz')];

		expect(
			pickDirectiveRepresentatives(candidates)[0]?.directive.trace_id,
		).toBe('trace-zzz');
		expect(isPreferredDirectiveCandidate(candidates[1]!, candidates[0]!)).toBe(
			true,
		);
		expect(isPreferredDirectiveCandidate(candidates[0]!, candidates[1]!)).toBe(
			false,
		);
	});
});

describe('#2628 bounded rendering (buildDirectiveComplianceBlock)', () => {
	it('drops non-criticals first under a tight budget with a count note', () => {
		const directives: DirectiveToVerify[] = [
			{
				trace_id: 'trace-crit',
				entry_id: 'd-crit',
				session_id: 'session-1',
				priority: 'critical',
				lesson: 'critical obligation',
			},
			...Array.from({ length: 30 }, (_, i) => ({
				trace_id: `trace-med-${i}`,
				entry_id: `d-med-${i}`,
				session_id: 'session-1',
				priority: 'medium' as const,
				lesson: `medium obligation ${i}`,
			})),
		];

		const block = buildDirectiveComplianceBlock(directives, 900);

		expect(block).not.toBeNull();
		expect(block).toContain('- trace_id: trace-crit');
		expect(block).toContain('  entry_id: d-crit');
		expect(block).toMatch(/omitted/i);
		expect(Buffer.byteLength(block ?? '', 'utf-8')).toBeLessThan(40000);
		// The omitted entries are absent from the shown set.
		expect(block).not.toContain('entry_id: d-med-29');
	});

	it('never drops a critical and emits the distinct overflow notice', () => {
		const directives: DirectiveToVerify[] = Array.from(
			{ length: 40 },
			(_, i) => ({
				trace_id: `trace-crit-${i}`,
				entry_id: `d-crit-${i}`,
				session_id: 'session-1',
				priority: 'critical' as const,
				lesson: `critical obligation ${i} — ${'x'.repeat(120)}`,
			}),
		);

		const block = buildDirectiveComplianceBlock(directives, 2000);

		expect(block).not.toBeNull();
		for (const d of directives) {
			expect(block).toContain(`entry_id: ${d.entry_id}`);
		}
		expect(block).toMatch(/critical overflow/i);
	});

	it('truncates oversized lessons while keeping pair identity exact', () => {
		const longLesson = 'L'.repeat(1200);
		const block = buildDirectiveComplianceBlock([
			{
				trace_id: 'trace-huge',
				entry_id: 'd-huge',
				session_id: 'session-1',
				priority: 'high',
				lesson: longLesson,
			},
		]);

		expect(block).toContain('- trace_id: trace-huge');
		expect(block).not.toContain(longLesson);
		const parsed = parseDirectivesToVerifyBlock(block ?? '');
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.lesson?.length).toBeLessThanOrEqual(404);
	});

	it('clamps the caller budget to the hard cap and defaults sanely', () => {
		expect(DIRECTIVE_COMPLIANCE_HARD_CHAR_CAP).toBeLessThanOrEqual(40_000);
		expect(DIRECTIVE_COMPLIANCE_DEFAULT_CHAR_BUDGET).toBeGreaterThan(0);
	});

	it('round-trips the shown pairs through the anti-spoofing parser', () => {
		const directives: DirectiveToVerify[] = [
			{
				trace_id: 'trace:rt one',
				entry_id: 'entry:rt one',
				session_id: 'session:rt',
				cohort_id: 'cohort:rt',
				source_link_id: 'link:rt',
				prior_terminal_outcome: 'violated',
				prior_terminal_event_id: 'event:rt',
				priority: 'critical',
				lesson: 'A lesson\nwith newlines',
				verification_predicate: 'grep:value:src/**/*.ts',
			},
			{
				trace_id: 'trace:rt two',
				entry_id: 'entry:rt two',
				session_id: 'session:rt',
				priority: 'low',
			},
		];

		const block = buildDirectiveComplianceBlock(directives, 24_000);
		expect(block).not.toBeNull();
		expect(parseDirectivesToVerifyBlock(block ?? '')).toEqual(directives);
	});

	it('no longer documents the per-pair multiplicity contract (#2628 AC7)', () => {
		const block = buildDirectiveComplianceBlock(
			[
				{
					trace_id: 'trace-spec',
					entry_id: 'd-spec',
					session_id: 'session-1',
					priority: 'medium',
				},
			],
			24_000,
		);

		expect(block).not.toContain('requires one verdict per pair');
		expect(block).toContain('DIRECTIVE_COMPLIANCE:');
	});
});

describe('#2628 per-entry gate resolution (evaluatePhaseCriticalDirectives)', () => {
	const PHASE = 'Phase 1';
	const SESSION = 'session-1';

	it('resolves the entry when a later applied remediates an earlier violated sibling', async () => {
		const kp = resolveSwarmKnowledgePath(dir);
		const id = 'directive-2628-later-rem-00000000000005';
		await appendKnowledge(kp, makeEntry(id, 'critical'));
		// Deterministic clock: the gate requires the applied terminal's
		// committed_at to be STRICTLY greater than the violated terminal's, and
		// wall-clock granularity can tie two adjacent commits on fast CI hosts.
		const realNowMs = ledgerInternals.nowMs;
		const clock = { tick: 1_000_000 };
		ledgerInternals.nowMs = () => (clock.tick += 1_000);
		try {
			await seedDisplay(PHASE, 'gate-violated', [id], SESSION);
			await seedTerminal('gate-violated', id, 'violated', SESSION);
			await seedDisplay(PHASE, 'gate-applied', [id], SESSION);
			await seedTerminal('gate-applied', id, 'applied', SESSION);
		} finally {
			ledgerInternals.nowMs = realNowMs;
		}

		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: SESSION,
			phaseLabel: PHASE,
		});

		expect(result).toMatchObject({ blocked: false, failedClosed: false });
		expect(result.unresolved).toEqual([]);
	});

	it('shows a contradicted-terminal entry to the reviewer as a remediation obligation (#2636 review)', async () => {
		// A 'contradicted' terminal blocks the phase gate (isViolation includes
		// it), so the reviewer must SEE the obligation to remediate it. Before
		// this fix the read filter skipped contradicted terminals entirely and
		// the phase could never resolve through the reviewer path.
		const kp = resolveSwarmKnowledgePath(dir);
		const id = 'directive-2628-contradicted-000000000008';
		await appendKnowledge(kp, makeEntry(id, 'critical'));
		const realNowMs = ledgerInternals.nowMs;
		const clock = { tick: 1_000_000 };
		ledgerInternals.nowMs = () => (clock.tick += 1_000);
		try {
			await seedDisplay(PHASE, 'gate-contradicted', [id], SESSION);
			await seedTerminal('gate-contradicted', id, 'contradicted', SESSION);

			const directives = await readPhaseDirectivesToVerify(dir, PHASE);
			expect(directives).toHaveLength(1);
			expect(directives[0]).toMatchObject({
				trace_id: 'gate-contradicted',
				entry_id: id,
				prior_terminal_outcome: 'contradicted',
			});
			expect(directives[0]?.prior_terminal_event_id).toBeString();

			// A strictly-later applied terminal on a sibling membership
			// remediates the contradiction and resolves the entry.
			await seedDisplay(PHASE, 'gate-contradicted-applied', [id], SESSION);
			await seedTerminal('gate-contradicted-applied', id, 'applied', SESSION);
		} finally {
			ledgerInternals.nowMs = realNowMs;
		}

		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: SESSION,
			phaseLabel: PHASE,
		});
		expect(result).toMatchObject({ blocked: false, failedClosed: false });
	});

	it('reports the shown (violated-preferred) trace for an unresolved entry', async () => {
		const kp = resolveSwarmKnowledgePath(dir);
		const id = 'directive-2628-rep-000000000000006';
		await appendKnowledge(kp, makeEntry(id, 'critical'));
		await seedDisplay(PHASE, 'gate-rep-old', [id], SESSION);
		await seedTerminal('gate-rep-old', id, 'violated', SESSION);
		await seedDisplay(PHASE, 'gate-rep-new', [id], SESSION);

		const result = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: SESSION,
			phaseLabel: PHASE,
		});

		expect(result.blocked).toBe(true);
		expect(result.unresolved).toEqual([
			{
				id,
				trace_id: 'gate-rep-old',
				reason: 'unremediated_violation',
			},
		]);
	});
});

describe('#2628 reconciliation consistency (lane-settle path)', () => {
	it('keeps the fresh-read verify-set consistent with the shown block', async () => {
		const kp = resolveSwarmKnowledgePath(dir);
		const id = 'directive-2628-rec-000000000000007';
		await appendKnowledge(kp, makeEntry(id, 'critical'));
		for (let t = 0; t < 5; t++) {
			await seedDisplay('Phase 1', nextTrace(), [id]);
		}

		const shown = await readPhaseDirectivesToVerify(dir, 'Phase 1');
		expect(shown).toHaveLength(1);
		const block = buildDirectiveComplianceBlock(shown);
		expect(block).not.toBeNull();

		// The reviewer verdicts exactly what was shown (Task-path parse).
		const shownPairs = parseDirectivesToVerifyBlock(block ?? '');
		expect(shownPairs).toHaveLength(1);
		const transcript = `VERIFIED:${encodeURIComponent(shownPairs[0]!.trace_id)}:${encodeURIComponent(shownPairs[0]!.entry_id)} evidence=src/x.ts:1`;

		// The lane-settle path re-reads the ledger fresh.
		const fresh = await readPhaseDirectivesToVerify(dir, 'Phase 1');
		const result = await reconcileReviewerVerdicts({
			directory: dir,
			transcript,
			directivesToVerify: fresh,
			sessionId: 'session-1',
			agent: 'reviewer',
		});

		expect(result.omittedCriticals).toEqual([]);
		expect(result.uncertainties).toEqual([]);
		expect(result.emitted).toHaveLength(1);

		const state = await queryLiveMemberships(dir, {
			phase: 'Phase 1',
			include_terminal: true,
			include_phase_closed: false,
		});
		expect(state.ok).toBe(true);
		const terminals = state.ok
			? state.memberships.filter((m) => m.terminal)
			: [];
		expect(terminals.length).toBeGreaterThanOrEqual(1);
	});
});
