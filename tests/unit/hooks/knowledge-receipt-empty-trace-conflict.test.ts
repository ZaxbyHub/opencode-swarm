/**
 * Empty-trace sentinel conflict classification (#2965, Workstream J slot J15).
 *
 * A second `'none'`-sentinel no-retrieval receipt in the same session with a
 * differing or omitted task/phase is a PERMANENT identity conflict. These
 * tests pin that the ledger rejects it with the precise taxonomy codes
 * (`wrong_task` / `wrong_phase` / `duplicate_conflicting_terminal`) — never
 * the retry-inviting `store_unavailable` — that idempotent same-identity
 * re-files keep succeeding, and that genuine store failures keep their
 * store-class code. Real ledger state in canonical tmpdirs; no mocks. The
 * directive-gate classifier block at the bottom drives the `_internals` seam
 * directly: those are synthetic classifier tests, not end-to-end gate
 * evidence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type CommitEmptyRetrievalResult,
	commitEmptyRetrieval,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { _internals as observationInternals } from '../../../src/hooks/knowledge-receipt-observability.js';
import { validateReceipt } from '../../../src/hooks/knowledge-receipt-validator.js';
import { _internals as gateInternals } from '../../../src/hooks/phase-complete-directive-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION = 'sess-conflict';
const PREFIX = 'conflicting immutable empty retrieval for none/' + SESSION;

type CommitOpts = {
	task_id?: string;
	phase?: string;
	grace_days?: number;
};

const commit = (dir: string, opts: CommitOpts = {}) =>
	commitEmptyRetrieval(dir, {
		trace_id: 'none',
		session_id: SESSION,
		phase: opts.phase,
		task_id: opts.task_id,
		agent: 'probe',
		grace_days: opts.grace_days,
	});

/** Asserts the result is a semantic conflict rejection, never a store code. */
const conflict = (result: CommitEmptyRetrievalResult) => {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error('unreachable');
	expect(result.code).not.toBe('store_unavailable');
	expect(result.code).not.toBe('lock_timeout');
	expect(result.code).not.toBe('store_corrupt');
	expect(result.code).not.toBe('legacy_unverifiable');
	return result;
};

const journalOf = (dir: string): string =>
	join(dir, '.swarm', 'knowledge-receipts-v2.jsonl');

const journalLineCount = (dir: string): number =>
	existsSync(journalOf(dir))
		? readFileSync(journalOf(dir), 'utf8').split('\n').filter(Boolean).length
		: 0;

/** The stored empty trace's resolved grace_days, read from the journal. */
const storedGraceDaysOf = (dir: string): number | undefined => {
	for (const line of readFileSync(journalOf(dir), 'utf8')
		.split('\n')
		.filter(Boolean)) {
		const record = JSON.parse(line) as {
			kind?: string;
			payload?: { trace?: { grace_days?: number } };
		};
		if (record.kind === 'empty_retrieval_committed' && record.payload?.trace) {
			return record.payload.trace.grace_days;
		}
	}
	return undefined;
};

const realEmit = observationInternals.emit;

afterEach(() => {
	observationInternals.emit = realEmit;
});

describe('empty-trace conflict classification (#2965)', () => {
	test('differing task_id rejects with wrong_task and axis-naming detail', async () => {
		const dir = canonicalMkdtemp('j15-task-differ-');
		const first = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(first.ok).toBe(true);
		const rejected = conflict(
			await commit(dir, { task_id: 'T2', phase: 'P1' }),
		);
		expect(rejected.code).toBe('wrong_task');
		expect(rejected.detail).toContain(PREFIX);
		expect(rejected.detail).toContain(
			"recorded task 'T1' differs from filed 'T2'",
		);
	});

	test('task omission conflicts symmetrically in both directions', async () => {
		const presentThenOmitted = canonicalMkdtemp('j15-task-omit-a-');
		await commit(presentThenOmitted, { task_id: 'T1', phase: 'P1' });
		const rejectedA = conflict(
			await commit(presentThenOmitted, { phase: 'P1' }),
		);
		expect(rejectedA.code).toBe('wrong_task');
		expect(rejectedA.detail).toContain(
			"recorded task 'T1' differs from filed omitted",
		);

		const omittedThenPresent = canonicalMkdtemp('j15-task-omit-b-');
		await commit(omittedThenPresent, { phase: 'P1' });
		const rejectedB = conflict(
			await commit(omittedThenPresent, { task_id: 'T1', phase: 'P1' }),
		);
		expect(rejectedB.code).toBe('wrong_task');
		expect(rejectedB.detail).toContain(
			"recorded task omitted differs from filed 'T1'",
		);
	});

	test('empty-string task is a defined value, rendered distinctly from omitted', async () => {
		const dir = canonicalMkdtemp('j15-task-empty-');
		await commit(dir, { task_id: 'T1', phase: 'P1' });
		const rejected = conflict(await commit(dir, { task_id: '', phase: 'P1' }));
		expect(rejected.code).toBe('wrong_task');
		expect(rejected.detail).toContain("differs from filed ''");
		expect(rejected.detail).not.toContain('filed omitted');
	});

	test('phase differing and omitted reject with wrong_phase in both directions', async () => {
		const differing = canonicalMkdtemp('j15-phase-differ-');
		await commit(differing, { task_id: 'T1', phase: 'P1' });
		const rejectedA = conflict(
			await commit(differing, { task_id: 'T1', phase: 'P2' }),
		);
		expect(rejectedA.code).toBe('wrong_phase');
		expect(rejectedA.detail).toContain(
			"recorded phase 'P1' differs from filed 'P2'",
		);

		const omitted = canonicalMkdtemp('j15-phase-omit-');
		await commit(omitted, { task_id: 'T1', phase: 'P1' });
		const rejectedB = conflict(await commit(omitted, { task_id: 'T1' }));
		expect(rejectedB.code).toBe('wrong_phase');
		expect(rejectedB.detail).toContain("recorded phase 'P1'");
		expect(rejectedB.detail).toContain('filed omitted');
	});

	test('both axes mismatch resolves to wrong_task (task-first precedence)', async () => {
		const dir = canonicalMkdtemp('j15-both-axes-');
		await commit(dir, { task_id: 'T1', phase: 'P1' });
		const rejected = conflict(
			await commit(dir, { task_id: 'T2', phase: 'P2' }),
		);
		expect(rejected.code).toBe('wrong_task');
		expect(rejected.detail).toContain('task');
	});

	test('grace drift rejects with duplicate_conflicting_terminal; equal grace stays idempotent', async () => {
		const dir = canonicalMkdtemp('j15-grace-');
		await commit(dir, { task_id: 'T1', phase: 'P1', grace_days: 5 });
		const sameGrace = await commit(dir, {
			task_id: 'T1',
			phase: 'P1',
			grace_days: 5,
		});
		expect(sameGrace.ok).toBe(true);
		const rejected = conflict(
			await commit(dir, {
				task_id: 'T1',
				phase: 'P1',
				grace_days: 99,
			}),
		);
		expect(rejected.code).toBe('duplicate_conflicting_terminal');
		expect(rejected.detail).toContain('recorded grace_days 5');
		expect(rejected.detail).toContain('resolved 99');
	});

	test('omitted grace resolved value filed explicitly is idempotent', async () => {
		const dir = canonicalMkdtemp('j15-grace-default-');
		const first = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(first.ok).toBe(true);
		const resolvedGrace = storedGraceDaysOf(dir);
		expect(resolvedGrace).toBeGreaterThan(0);
		const retry = await commit(dir, {
			task_id: 'T1',
			phase: 'P1',
			grace_days: resolvedGrace,
		});
		expect(retry.ok).toBe(true);
	});

	test('conflict detail is bounded and control-character sanitized', async () => {
		const dir = canonicalMkdtemp('j15-bounded-');
		const longTask = `T-${'x'.repeat(500)}`;
		await commit(dir, { task_id: longTask, phase: 'P1' });
		const rejected = conflict(
			await commit(dir, {
				task_id: `T-\u0007${'y'.repeat(400)}`,
				phase: 'P1',
			}),
		);
		expect(rejected.detail.length).toBeLessThanOrEqual(300);
		expect(rejected.detail).not.toContain('\u0007');
	});

	test('rejected re-file appends no journal records and emits no transitions', async () => {
		const dir = canonicalMkdtemp('j15-noappend-');
		const first = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(first.ok).toBe(true);
		const baseline = journalLineCount(dir);
		expect(baseline).toBeGreaterThan(0);
		let emissions = 0;
		observationInternals.emit = (() => {
			emissions += 1;
		}) as typeof observationInternals.emit;
		const rejected = conflict(
			await commit(dir, { task_id: 'T2', phase: 'P1' }),
		);
		expect(rejected.code).toBe('wrong_task');
		expect(journalLineCount(dir)).toBe(baseline);
		expect(emissions).toBe(0);
	});

	test('conflict then retry with the originally recorded identity is idempotent', async () => {
		const dir = canonicalMkdtemp('j15-recover-');
		const first = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(first.ok).toBe(true);
		conflict(await commit(dir, { task_id: 'T2', phase: 'P1' }));
		const retry = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(retry.ok).toBe(true);
		if (retry.ok && first.ok) {
			expect(retry.event_id).toBe(first.event_id);
			expect(retry.terminal_event_id).toBe(first.terminal_event_id);
		}
	});

	test('genuine store failure still returns store_unavailable', async () => {
		const missing = join(canonicalMkdtemp('j15-store-'), 'does-not-exist');
		const result = await commitEmptyRetrieval(missing, {
			trace_id: 'none',
			session_id: SESSION,
			agent: 'probe',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('store_unavailable');
			expect(result.detail).toMatch(/project root/i);
		}
	});

	test('concurrent same-identity filings serialize to one idempotent commit', async () => {
		const dir = canonicalMkdtemp('j15-conc-same-');
		const [a, b] = await Promise.all([
			commit(dir, { task_id: 'T1', phase: 'P1' }),
			commit(dir, { task_id: 'T1', phase: 'P1' }),
		]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) {
			expect(a.event_id).toBe(b.event_id);
			expect(a.terminal_event_id).toBe(b.terminal_event_id);
		}
		expect(journalLineCount(dir)).toBeGreaterThan(0);
	});

	test('concurrent differing-identity filings yield one commit and one typed conflict', async () => {
		const dir = canonicalMkdtemp('j15-conc-diff-');
		const [a, b] = await Promise.all([
			commit(dir, { task_id: 'T1', phase: 'P1' }),
			commit(dir, { task_id: 'T2', phase: 'P1' }),
		]);
		const outcomes = [a, b];
		const oks = outcomes.filter((o) => o.ok);
		const rejected = outcomes.filter((o) => !o.ok);
		expect(oks.length).toBe(1);
		expect(rejected.length).toBe(1);
		const loser = conflict(rejected[0] as CommitEmptyRetrievalResult);
		expect(loser.code).toBe('wrong_task');
	});
});

describe('validator sentinel branch carries the precise reason (#2965)', () => {
	test('reject() returns the typed conflict code and axis detail', async () => {
		const dir = canonicalMkdtemp('j15-validator-');
		const first = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(first.ok).toBe(true);
		const result = await validateReceipt({
			directory: dir,
			trace_id: 'none',
			session_id: SESSION,
			phase: 'P1',
			task_id: 'T2',
			agent: 'coder',
			source: 'agent',
			items: [],
			no_relevant_knowledge: true,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.rejected).toBe(true);
			expect(result.reason).toBe('wrong_task');
			expect(result.detail).toContain(PREFIX);
		}
	});
});

describe('directive-gate failure classifier (#2965, synthetic seam tests)', () => {
	test('conflict codes map to RECEIPT_CONFLICT with tool recovery, ahead of detail sniffing', () => {
		const transientLacedDetail =
			'conflicting immutable empty retrieval for none/sess — temporarily unavailable, transient, EBUSY';
		for (const code of [
			'wrong_task',
			'wrong_phase',
			'duplicate_conflicting_terminal',
		] as const) {
			const classified = gateInternals.classifyDirectiveGateFailure({
				ok: false,
				code,
				detail: transientLacedDetail,
			});
			expect(classified.failure?.code).toBe('RECEIPT_CONFLICT');
			expect(classified.recovery?.kind).toBe('tool');
			expect(classified.recovery?.action).toBe('knowledge_receipt');
		}
	});

	test('genuine transient store failure still classifies as retry', () => {
		const classified = gateInternals.classifyDirectiveGateFailure({
			ok: false,
			code: 'store_unavailable',
			detail: 'the operation was temporarily unavailable (EBUSY)',
		});
		expect(classified.failure?.code).toBe('RECEIPT_TRANSIENT');
		expect(classified.recovery?.kind).toBe('retry');
	});

	test('store_corrupt and lock_timeout arms are unchanged', () => {
		const corrupt = gateInternals.classifyDirectiveGateFailure({
			ok: false,
			code: 'store_corrupt',
			detail: 'journal hash mismatch',
		});
		expect(corrupt.failure?.code).toBe('RECEIPT_CORRUPT');
		expect(corrupt.recovery?.action).toBe('repair_knowledge_receipt_ledger');
		const lock = gateInternals.classifyDirectiveGateFailure({
			ok: false,
			code: 'lock_timeout',
			detail: 'receipt correctness lock unavailable before bounded timeout',
		});
		expect(lock.failure?.code).toBe('RECEIPT_LOCK_TIMEOUT');
		expect(lock.recovery?.kind).toBe('retry');
	});
});
