/**
 * Role/source/outcome property matrix (issue #2032).
 *
 * Proves the 5 canonical terminal outcomes behave identically across every
 * layer that produces or consumes them: the chat-marker parser, the shared
 * receipt validator, the authoritative V2 ledger (outcome + source preserved
 * per producer path), the counter rollup, the outcome signal, the
 * phase-complete directive gate, and the application-marker path.
 *
 * SCOPE: this matrix covers the 5 canonical outcomes x the explicit producer
 * sources exercised here (delegate, reviewer, architect_marker,
 * phase_override). It does NOT prove completeness over every canonical source
 * value or over malformed inputs — those have separate bounded-code and
 * legacy-uncertainty tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseAcknowledgments } from '../../../src/hooks/knowledge-application';
import {
	appendKnowledgeEvent,
	effectiveRetrievalOutcomes,
	type KnowledgeEvent,
	newTraceId,
	type ReceiptEvent,
	recomputeCounters,
} from '../../../src/hooks/knowledge-events';
import {
	commitApplicationOutcomeBatch,
	queryLiveMemberships,
	RECEIPT_TERMINAL_OUTCOMES,
	type ReceiptOutcome,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger';
import {
	emitKnowledgeReceiptTransition,
	_internals as observabilityInternals,
	RECEIPT_SEMANTICS_VERSION,
} from '../../../src/hooks/knowledge-receipt-observability';
import {
	type ReceiptItem,
	validateReceipt,
} from '../../../src/hooks/knowledge-receipt-validator';
import { computeOutcomeSignal } from '../../../src/hooks/knowledge-store';
import {
	evaluatePhaseCriticalDirectives,
	recordDirectiveOverrides,
} from '../../../src/hooks/phase-complete-directive-gate';

const SESSION = 'sess-matrix';
const PHASE = 'Phase 1';
const OUTCOMES: ReceiptOutcome[] = [
	'applied',
	'ignored',
	'n_a',
	'contradicted',
	'violated',
];
const MARKER_VERB: Record<ReceiptOutcome, string> = {
	applied: 'APPLIED',
	ignored: 'IGNORED',
	n_a: 'N_A',
	contradicted: 'CONTRADICTED',
	violated: 'VIOLATED',
};
/** Counter the rollup must bump exactly once for one event of the outcome. */
const ROLLUP_FIELD: Record<ReceiptOutcome, string> = {
	applied: 'applied_explicit_count',
	ignored: 'ignored_count',
	n_a: 'n_a_count',
	contradicted: 'contradicted_count',
	violated: 'violated_count',
};
/** Expected sign of computeOutcomeSignal for one event of the outcome. */
const SIGNAL_SIGN: Record<ReceiptOutcome, number> = {
	applied: 1,
	ignored: -1,
	n_a: 0,
	contradicted: -1,
	violated: -1,
};

function tmpSwarmDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-matrix-'));
	fs.mkdirSync(path.join(d, '.swarm'), { recursive: true });
	return d;
}

function rmrf(d: string): void {
	fs.rmSync(d, { recursive: true, force: true });
}

/** Seed a retrieved trace so legacy cutover imports it as a critical membership. */
async function seedTrace(
	dir: string,
	traceId: string,
	resultIds: string[],
	opts: { mode?: string; phase?: string } = {},
): Promise<void> {
	await appendKnowledgeEvent(dir, {
		type: 'retrieved',
		trace_id: traceId,
		session_id: SESSION,
		phase: opts.phase ?? PHASE,
		agent: 'architect',
		query: 'matrix',
		retrieval_mode: opts.mode ?? 'auto_injection',
		result_ids: resultIds,
		ranks: Object.fromEntries(resultIds.map((id, i) => [id, i + 1])),
		scores: Object.fromEntries(resultIds.map((id) => [id, 1])),
		timestamp: new Date().toISOString(),
	});
}

async function validatorCtx(
	dir: string,
	traceId: string,
	items: ReceiptItem[],
	source = 'delegate',
) {
	return validateReceipt({
		directory: dir,
		trace_id: traceId,
		session_id: SESSION,
		phase: PHASE,
		agent: 'coder',
		source,
		items,
		no_relevant_knowledge: false,
	});
}

async function terminalOf(
	dir: string,
	traceId: string,
	entryId: string,
): Promise<{ outcome: string; source: string; reason?: string } | undefined> {
	const state = await queryLiveMemberships(dir, {
		session_id: SESSION,
		include_terminal: true,
	});
	if (!state.ok) throw new Error(state.detail);
	return state.memberships.find(
		(m) => m.trace_id === traceId && m.entry_id === entryId,
	)?.terminal;
}

function syntheticReceiptEvent(
	outcome: ReceiptOutcome,
	reason?: string,
): ReceiptEvent {
	return {
		type: outcome,
		event_id: `evt-${outcome}`,
		trace_id: 't',
		knowledge_id: 'k1',
		timestamp: new Date().toISOString(),
		session_id: SESSION,
		agent: 'coder',
		source: 'delegate',
		reason,
	} as ReceiptEvent;
}

describe('knowledge outcome/source semantic matrix (#2032)', () => {
	let dir: string;
	beforeEach(() => {
		dir = tmpSwarmDir();
	});
	afterEach(() => {
		rmrf(dir);
	});

	test('matrix enumerates the complete canonical terminal outcome set', () => {
		// If ReceiptOutcome ever gains or loses a member, this fails loudly
		// instead of the matrix silently skipping (or ghost-testing) it.
		expect([...RECEIPT_TERMINAL_OUTCOMES].sort()).toEqual([...OUTCOMES].sort());
	});

	for (const outcome of OUTCOMES) {
		describe(`outcome=${outcome}`, () => {
			test('chat-marker parser recognizes the exact-pair form', () => {
				const verb = MARKER_VERB[outcome];
				const acks = parseAcknowledgments(
					`KNOWLEDGE_${verb}:trace-1:k1 reason=matrix reason`,
				);
				expect(acks).toHaveLength(1);
				expect(acks[0].result).toBe(outcome);
				expect(acks[0].trace_id).toBe('trace-1');
				expect(acks[0].id).toBe('k1');
			});

			test('shared validator accepts the outcome and the ledger terminal preserves outcome + delegate source', async () => {
				const traceId = newTraceId();
				await seedTrace(dir, traceId, ['k1']);
				const r = await validatorCtx(dir, traceId, [
					{ id: 'k1', outcome, reason: 'matrix' },
				]);
				expect(r.ok).toBe(true);
				const terminal = await terminalOf(dir, traceId, 'k1');
				expect(terminal?.outcome).toBe(outcome);
				expect(terminal?.source).toBe('delegate');
			});

			test('counter rollup bumps exactly the outcome counter; outcome signal sign matches policy', () => {
				const rollups = recomputeCounters([
					syntheticReceiptEvent(outcome, 'matrix'),
				]);
				const rollup = rollups.get('k1');
				expect(rollup).toBeDefined();
				expect(rollup?.[ROLLUP_FIELD[outcome] as keyof typeof rollup]).toBe(1);
				// No cross-contamination of the other outcome counters.
				for (const other of OUTCOMES) {
					if (other === outcome) continue;
					expect(
						rollup?.[ROLLUP_FIELD[other] as keyof typeof rollup] ?? 0,
					).toBe(0);
				}
				const signal = computeOutcomeSignal(
					effectiveRetrievalOutcomes(undefined, rollup),
				);
				if (SIGNAL_SIGN[outcome] === 0) {
					expect(signal).toBe(0);
				} else {
					expect(Math.sign(signal)).toBe(SIGNAL_SIGN[outcome]);
				}
			});

			test('phase-complete directive gate resolves per policy', async () => {
				const traceId = newTraceId();
				await seedTrace(dir, traceId, ['k1']);
				const withReason = await validatorCtx(dir, traceId, [
					{ id: 'k1', outcome, reason: 'matrix' },
				]);
				expect(withReason.ok).toBe(true);
				let gate = await evaluatePhaseCriticalDirectives({
					directory: dir,
					sessionId: SESSION,
					phaseLabel: PHASE,
				});
				expect(gate.failedClosed).toBe(false);
				if (
					outcome === 'applied' ||
					outcome === 'ignored' ||
					outcome === 'n_a'
				) {
					expect(gate.blocked).toBe(false);
				} else {
					expect(gate.blocked).toBe(true);
					expect(gate.unresolved[0]?.reason).toBe('unremediated_violation');
				}

				// Without a reason, ignored/n_a do NOT clear the obligation.
				if (outcome === 'ignored' || outcome === 'n_a') {
					const dir2 = tmpSwarmDir();
					try {
						const traceId2 = newTraceId();
						await seedTrace(dir2, traceId2, ['k1']);
						const bare = await validatorCtx(dir2, traceId2, [
							{ id: 'k1', outcome },
						]);
						expect(bare.ok).toBe(true);
						gate = await evaluatePhaseCriticalDirectives({
							directory: dir2,
							sessionId: SESSION,
							phaseLabel: PHASE,
						});
						expect(gate.blocked).toBe(true);
						expect(gate.unresolved[0]?.reason).toBe('no_verdict');
					} finally {
						rmrf(dir2);
					}
				}
			});
		});
	}

	test('application-marker path: an n_a architect_marker commits and satisfies the unacked filter (#2032)', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		const committed = await commitApplicationOutcomeBatch(dir, {
			trace_id: traceId,
			session_id: SESSION,
			items: [
				{
					entry_id: 'k1',
					outcome: 'n_a',
					source: 'architect_marker',
					reason: 'does not govern this action',
				},
			],
		});
		expect(committed.ok).toBe(true);
		const state = await queryLiveMemberships(dir, {
			session_id: SESSION,
			include_terminal: true,
		});
		if (!state.ok) throw new Error(state.detail);
		const membership = state.memberships.find(
			(m) => m.trace_id === traceId && m.entry_id === 'k1',
		);
		// The gate's unacked filter is `!membership.application_marker`, so an
		// n_a marker clears the acknowledgement obligation exactly like ignored.
		expect(membership?.application_marker?.outcome).toBe('n_a');
		expect(membership?.application_marker?.source).toBe('architect_marker');
	});

	test('duplicate/reorder: an N_A-then-IGNORED correction is a conflicting terminal, not an overwrite (#2032)', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		const first = await validateAndCommitTerminalBatch(dir, {
			trace_id: traceId,
			session_id: SESSION,
			items: [
				{ entry_id: 'k1', outcome: 'n_a', source: 'delegate', reason: 'a' },
			],
		});
		expect(first.ok).toBe(true);
		const second = await validateAndCommitTerminalBatch(dir, {
			trace_id: traceId,
			session_id: SESSION,
			items: [
				{ entry_id: 'k1', outcome: 'ignored', source: 'delegate', reason: 'b' },
			],
		});
		expect(second.ok).toBe(true);
		if (second.ok) {
			expect(second.rejected).toEqual([
				{ entry_id: 'k1', reason: 'duplicate_conflicting_terminal' },
			]);
		}
		const terminal = await terminalOf(dir, traceId, 'k1');
		expect(terminal?.outcome).toBe('n_a');
	});

	test('duplicate/reorder: a repeated identical marker is idempotent, a late marker adds no second terminal', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		const first = await validateAndCommitTerminalBatch(dir, {
			trace_id: traceId,
			session_id: SESSION,
			items: [
				{ entry_id: 'k1', outcome: 'applied', source: 'delegate', reason: 'x' },
			],
		});
		expect(first.ok).toBe(true);
		const late = await validateAndCommitTerminalBatch(dir, {
			trace_id: traceId,
			session_id: SESSION,
			items: [
				{ entry_id: 'k1', outcome: 'applied', source: 'delegate', reason: 'x' },
			],
		});
		expect(late.ok).toBe(true);
		if (late.ok) {
			expect(late.rejected).toHaveLength(0);
			expect(late.idempotent).toContain('k1');
		}
		const terminal = await terminalOf(dir, traceId, 'k1');
		expect(terminal?.outcome).toBe('applied');
	});

	test('legacy uncertainty: a terminal event with NO source round-trips as unknown, never coerced (#2032)', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		// Pre-#2032 delegate dual-writes omitted source entirely.
		const legacy: KnowledgeEvent = {
			type: 'applied',
			event_id: 'evt-legacy-1',
			trace_id: traceId,
			knowledge_id: 'k1',
			timestamp: new Date().toISOString(),
			session_id: SESSION,
			phase: PHASE,
			agent: 'coder',
		} as KnowledgeEvent;
		await appendKnowledgeEvent(dir, legacy);
		const terminal = await terminalOf(dir, traceId, 'k1');
		expect(terminal?.outcome).toBe('applied');
		expect(terminal?.source).toBe('unknown');
	});

	test('historical no-rewrite: a pre-existing ignored event with reason not_relevant still counts negative (#2032)', () => {
		// Historical records keep the meanings they were written with; the
		// zod-enum migration only affects NEW tool filings.
		const rollups = recomputeCounters([
			syntheticReceiptEvent('ignored', 'not_relevant'),
		]);
		const rollup = rollups.get('k1');
		expect(rollup?.ignored_count).toBe(1);
		const signal = computeOutcomeSignal(
			effectiveRetrievalOutcomes(undefined, rollup),
		);
		expect(signal).toBeLessThan(0);
	});

	test('phase override: terminal and diagnostic event both carry the phase_override source (#2032)', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		const violated = await validateAndCommitTerminalBatch(dir, {
			trace_id: traceId,
			session_id: SESSION,
			items: [
				{
					entry_id: 'k1',
					outcome: 'violated',
					source: 'delegate',
					reason: 'unacknowledged',
				},
			],
		});
		expect(violated.ok).toBe(true);
		await recordDirectiveOverrides(
			dir,
			[`${traceId}/k1`],
			'accepted risk for this phase',
			SESSION,
			PHASE,
		);
		const state = await queryLiveMemberships(dir, {
			session_id: SESSION,
			include_terminal: true,
		});
		if (!state.ok) throw new Error(state.detail);
		const membership = state.memberships.find(
			(m) => m.trace_id === traceId && m.entry_id === 'k1',
		);
		expect(membership?.terminal?.source).toBe('phase_override');
		expect(membership?.terminal?.authorized_transition?.actor).toBe(
			'phase-override',
		);
		// The gate treats the authorized transition as overridden, not blocked.
		const gate = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: SESSION,
			phaseLabel: PHASE,
		});
		expect(gate.blocked).toBe(false);
		expect(gate.overridden).toContain('k1');
	});

	test('observability: knowledge_receipt_transition emits receiptSemantics (#2032)', () => {
		const original = observabilityInternals.emit;
		const payloads: Array<Record<string, unknown>> = [];
		observabilityInternals.emit = ((_kind: string, payload: unknown) => {
			payloads.push(payload as Record<string, unknown>);
		}) as typeof original;
		try {
			emitKnowledgeReceiptTransition({
				transition: 'terminal_committed',
				reasonCode: 'committed',
				schemaVersion: 2,
				receiptOutcome: 'n_a',
				receiptSource: 'delegate',
			});
		} finally {
			observabilityInternals.emit = original;
		}
		expect(payloads).toHaveLength(1);
		expect(payloads[0].receiptSemantics).toBe(RECEIPT_SEMANTICS_VERSION);
		expect(payloads[0].receiptOutcome).toBe('n_a');
		expect(payloads[0].receiptSource).toBe('delegate');
	});
});
