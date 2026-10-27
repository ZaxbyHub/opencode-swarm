/**
 * Empty-trace sentinel conflict classification (#2965, Workstream J slot J15).
 *
 * A second `'none'`-sentinel no-retrieval receipt in the same session with a
 * differing or omitted task/phase is a PERMANENT identity conflict. These
 * tests pin that the ledger rejects it with the precise taxonomy codes
 * (`wrong_task` / `wrong_phase` / `duplicate_conflicting_terminal`) — never
 * the retry-inviting `store_unavailable` — that idempotent same-identity
 * re-files keep succeeding, and that genuine store failures keep their
 * store-class code. Real ledger state in tmpdir fixtures carrying the
 * family-convention `.git` marker; no mocks. (The directive-gate classifier
 * seam tests live in the sibling knowledge-receipt-conflict-classifier.test.ts
 * — synthetic classifier coverage, not end-to-end gate evidence.)
 *
 * Hermeticity: every `commit()` through the helper pins `grace_days: 7`
 * explicitly, so the pre-cutover configured-grace resolution can never leak
 * a developer's user-level `receipt_close_grace_days` into these outcomes.
 * The grace test that intentionally exercises resolution re-files the
 * journal-derived recorded value, which is config-independent by construction.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type CommitEmptyRetrievalResult,
	commitEmptyRetrieval,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { _internals as observationInternals } from '../../../src/hooks/knowledge-receipt-observability.js';
import { validateReceipt } from '../../../src/hooks/knowledge-receipt-validator.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const SESSION = 'sess-conflict';
const PREFIX = 'conflicting immutable empty retrieval for none/' + SESSION;

type CommitOpts = {
	task_id?: string;
	phase?: string;
	grace_days?: number;
};

/** Hermetic filing: grace pinned so user-level config can never leak in. */
const commit = (dir: string, opts: CommitOpts = {}) =>
	commitEmptyRetrieval(dir, {
		trace_id: 'none',
		session_id: SESSION,
		phase: opts.phase,
		task_id: opts.task_id,
		agent: 'probe',
		grace_days: opts.grace_days ?? 7,
	});

const cleanups: Array<() => void> = [];

/** Family-convention fixture: realpath'd tmpdir + `.git` marker + cleanup. */
const fixture = (): string => {
	const { dir, cleanup } = createSafeTestDir('j15-conflict-');
	cleanups.push(cleanup);
	fs.mkdirSync(path.join(dir, '.git'));
	return dir;
};

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
	path.join(dir, '.swarm', 'knowledge-receipts-v2.jsonl');

const journalLineCount = (dir: string): number =>
	fs.existsSync(journalOf(dir))
		? fs.readFileSync(journalOf(dir), 'utf8').split('\n').filter(Boolean).length
		: 0;

/** The stored empty trace's resolved grace_days, read from the journal. */
const storedGraceDaysOf = (dir: string): number | undefined => {
	for (const line of fs
		.readFileSync(journalOf(dir), 'utf8')
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
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('empty-trace conflict classification (#2965)', () => {
	test('differing task_id rejects with wrong_task and axis-naming detail', async () => {
		const dir = fixture();
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
		const presentThenOmitted = fixture();
		await commit(presentThenOmitted, { task_id: 'T1', phase: 'P1' });
		const rejectedA = conflict(
			await commit(presentThenOmitted, { phase: 'P1' }),
		);
		expect(rejectedA.code).toBe('wrong_task');
		expect(rejectedA.detail).toContain(
			"recorded task 'T1' differs from filed omitted",
		);

		const omittedThenPresent = fixture();
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
		const dir = fixture();
		await commit(dir, { task_id: 'T1', phase: 'P1' });
		const rejected = conflict(await commit(dir, { task_id: '', phase: 'P1' }));
		expect(rejected.code).toBe('wrong_task');
		expect(rejected.detail).toContain("differs from filed ''");
		expect(rejected.detail).not.toContain('filed omitted');
	});

	test('phase differing and present-then-omitted reject with wrong_phase', async () => {
		const differing = fixture();
		await commit(differing, { task_id: 'T1', phase: 'P1' });
		const rejectedA = conflict(
			await commit(differing, { task_id: 'T1', phase: 'P2' }),
		);
		expect(rejectedA.code).toBe('wrong_phase');
		expect(rejectedA.detail).toContain(
			"recorded phase 'P1' differs from filed 'P2'",
		);

		const omitted = fixture();
		await commit(omitted, { task_id: 'T1', phase: 'P1' });
		const rejectedB = conflict(await commit(omitted, { task_id: 'T1' }));
		expect(rejectedB.code).toBe('wrong_phase');
		expect(rejectedB.detail).toContain("recorded phase 'P1'");
		expect(rejectedB.detail).toContain('filed omitted');
	});

	test('phase omitted-then-present rejects with wrong_phase symmetrically', async () => {
		const dir = fixture();
		await commit(dir, { task_id: 'T1' });
		const rejected = conflict(
			await commit(dir, { task_id: 'T1', phase: 'P1' }),
		);
		expect(rejected.code).toBe('wrong_phase');
		expect(rejected.detail).toContain('recorded phase omitted');
		expect(rejected.detail).toContain("differs from filed 'P1'");
	});

	test('both axes mismatch resolves to wrong_task (task-first precedence)', async () => {
		const dir = fixture();
		await commit(dir, { task_id: 'T1', phase: 'P1' });
		const rejected = conflict(
			await commit(dir, { task_id: 'T2', phase: 'P2' }),
		);
		expect(rejected.code).toBe('wrong_task');
		expect(rejected.detail).toContain('task');
	});

	test('both axes omitted resolves to wrong_task (task axis fires first)', async () => {
		const dir = fixture();
		await commit(dir, { task_id: 'T1', phase: 'P1' });
		const rejected = conflict(await commit(dir, {}));
		expect(rejected.code).toBe('wrong_task');
		expect(rejected.detail).toContain(
			"recorded task 'T1' differs from filed omitted",
		);
	});

	test('grace drift rejects with duplicate_conflicting_terminal; equal grace stays idempotent', async () => {
		const dir = fixture();
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

	test('omitted grace resolved value filed explicitly is idempotent (config-independent)', async () => {
		const dir = fixture();
		// Direct calls without a pinned grace: re-filing the journal-derived
		// recorded value is idempotent under ANY receipt_close_grace_days
		// setting, so this leg stays hermetic by construction.
		const first = await commitEmptyRetrieval(dir, {
			trace_id: 'none',
			session_id: SESSION,
			phase: 'P1',
			task_id: 'T1',
			agent: 'probe',
		});
		expect(first.ok).toBe(true);
		const resolvedGrace = storedGraceDaysOf(dir);
		expect(resolvedGrace).toBeGreaterThanOrEqual(0);
		const retry = await commitEmptyRetrieval(dir, {
			trace_id: 'none',
			session_id: SESSION,
			phase: 'P1',
			task_id: 'T1',
			agent: 'probe',
			grace_days: resolvedGrace,
		});
		expect(retry.ok).toBe(true);
	});

	test('conflict detail is bounded, sanitized, and marks truncated values', async () => {
		const dir = fixture();
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
		// The truncated filed value carries the visible elision marker.
		expect(rejected.detail).toContain("filed 'T-");
		expect(rejected.detail).toContain('…');
	});

	test('axis sentence survives unbounded trace/session identifiers', async () => {
		const dir = fixture();
		const longTrace = 't'.repeat(200);
		const longSession = 's'.repeat(80);
		await commitEmptyRetrieval(dir, {
			trace_id: longTrace,
			session_id: longSession,
			phase: 'P1',
			task_id: 'T1',
			agent: 'probe',
			grace_days: 7,
		});
		const rejected = conflict(
			await commitEmptyRetrieval(dir, {
				trace_id: longTrace,
				session_id: longSession,
				phase: 'P1',
				task_id: 'T2',
				agent: 'probe',
				grace_days: 7,
			}),
		);
		expect(rejected.detail.length).toBeLessThanOrEqual(300);
		expect(rejected.detail).toContain("recorded task 'T1'");
		expect(rejected.detail).toContain("differs from filed 'T2'");
	});

	test('trace/session identifiers are sanitized like the axis values', async () => {
		const dir = fixture();
		const controlSession = 'sess\u0007ctl';
		await commitEmptyRetrieval(dir, {
			trace_id: 'none',
			session_id: controlSession,
			phase: 'P1',
			task_id: 'T1',
			agent: 'probe',
			grace_days: 7,
		});
		const rejected = conflict(
			await commitEmptyRetrieval(dir, {
				trace_id: 'none',
				session_id: controlSession,
				phase: 'P1',
				task_id: 'T2',
				agent: 'probe',
				grace_days: 7,
			}),
		);
		expect(rejected.detail).not.toContain('\u0007');
		expect(rejected.detail).toContain('sess?ctl');
	});

	test('embedded quotes are doubled so a value cannot forge axis clauses', async () => {
		const dir = fixture();
		const forged = "x' differs from filed 'Y";
		await commit(dir, { task_id: forged, phase: 'P1' });
		const rejected = conflict(
			await commit(dir, { task_id: 'T2', phase: 'P1' }),
		);
		expect(rejected.detail).toContain(
			"recorded task 'x'' differs from filed ''Y'",
		);
	});

	test('truncation never splits a surrogate pair', async () => {
		const dir = fixture();
		const astralTask = `${'A'.repeat(64)}\u{1F4A9}`;
		await commit(dir, { task_id: astralTask, phase: 'P1' });
		const rejected = conflict(
			await commit(dir, { task_id: 'T2', phase: 'P1' }),
		);
		expect(rejected.detail).not.toContain('\uD83D');
		expect(rejected.detail).not.toContain('\uDCA9');
		expect(rejected.detail).toContain('…');
	});

	test('rejected re-file appends no journal records and emits no transitions', async () => {
		const dir = fixture();
		// Positive control FIRST: the spy is live before the committing
		// operation, and a real commit must produce emissions through it.
		let emissions = 0;
		observationInternals.emit = (() => {
			emissions += 1;
		}) as typeof observationInternals.emit;
		const first = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(first.ok).toBe(true);
		expect(emissions).toBeGreaterThan(0);
		const baseline = journalLineCount(dir);
		expect(baseline).toBeGreaterThan(0);
		emissions = 0;
		const rejected = conflict(
			await commit(dir, { task_id: 'T2', phase: 'P1' }),
		);
		expect(rejected.code).toBe('wrong_task');
		expect(journalLineCount(dir)).toBe(baseline);
		expect(emissions).toBe(0);
	});

	test('conflict then retry with the originally recorded identity is idempotent', async () => {
		const dir = fixture();
		const first = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(first.ok).toBe(true);
		const rejected = conflict(
			await commit(dir, { task_id: 'T2', phase: 'P1' }),
		);
		expect(rejected.code).toBe('wrong_task');
		const retry = await commit(dir, { task_id: 'T1', phase: 'P1' });
		expect(retry.ok).toBe(true);
		if (retry.ok && first.ok) {
			expect(retry.event_id).toBe(first.event_id);
			expect(retry.terminal_event_id).toBe(first.terminal_event_id);
		}
	});

	test('genuine store failure still returns store_unavailable', async () => {
		const missing = path.join(fixture(), 'does-not-exist');
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

	test('concurrent same-identity filings serialize with stable ids under lock contention', async () => {
		const dir = fixture();
		const outcomes = await Promise.all([
			commit(dir, { task_id: 'T1', phase: 'P1' }),
			commit(dir, { task_id: 'T1', phase: 'P1' }),
		]);
		// A contended loser may legitimately exhaust the lock budget and
		// receive the retry-class lock_timeout; every settled outcome must be
		// an ok sharing the canonical ids or exactly that store code.
		const oks = outcomes.filter((o) => o.ok);
		expect(oks.length).toBeGreaterThanOrEqual(1);
		const canonical = oks[0];
		if (!canonical || !canonical.ok) throw new Error('unreachable');
		for (const outcome of outcomes) {
			if (outcome.ok) {
				expect(outcome.event_id).toBe(canonical.event_id);
				expect(outcome.terminal_event_id).toBe(canonical.terminal_event_id);
			} else {
				expect(outcome.code).toBe('lock_timeout');
			}
		}
		expect(journalLineCount(dir)).toBeGreaterThan(0);
	});

	test('concurrent differing-identity filings yield one commit and at most one typed conflict', async () => {
		const dir = fixture();
		const outcomes = await Promise.all([
			commit(dir, { task_id: 'T1', phase: 'P1' }),
			commit(dir, { task_id: 'T2', phase: 'P1' }),
		]);
		const oks = outcomes.filter((o) => o.ok);
		expect(oks.length).toBeGreaterThanOrEqual(1);
		for (const outcome of outcomes) {
			if (outcome.ok) continue;
			// The loser is either the typed permanent conflict or a legitimate
			// lock-budget expiry (retry-class) — never any other code.
			expect(
				outcome.code === 'wrong_task' || outcome.code === 'lock_timeout',
			).toBe(true);
			if (outcome.code === 'wrong_task') {
				expect(outcome.detail).toContain(PREFIX);
			}
		}
	});
});

describe('validator sentinel branch carries the precise reason (#2965)', () => {
	test('reject() returns the typed conflict code and axis detail', async () => {
		const dir = fixture();
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
