/**
 * Issue #3036 — ledger-side authorized filing: a child session attested by
 * dispatch lineage may file its architect's stamp (role-matched); every other
 * mismatch stays fail-closed wrong_session with the out-of-band stamp map.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	commitDisplayedMembership,
	type ReceiptLedgerResult,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { writeDispatchParentEntry } from '../../../src/state.js';
import { knowledge_receipt } from '../../../src/tools/knowledge-receipt.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const ARCH = 'ses-arch-3036-led';
const CHILD = 'ses-child-3036-led';
const FOREIGN = 'ses-foreign-3036-led';

function unwrap<T>(result: ReceiptLedgerResult<T>): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
	return result;
}

describe('knowledge receipt authorized filing (issue #3036)', () => {
	let directory: string;
	let cleanup: () => void;
	const trace = 'trace-3036-led';
	const entry = 'entry-3036-led';

	beforeEach(async () => {
		const fixture = createSafeTestDir('receipt-authorized-3036-');
		directory = fixture.dir;
		cleanup = fixture.cleanup;
		fs.mkdirSync(path.join(directory, '.git'));
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: trace,
				session_id: ARCH,
				exposure_kind: 'delegate_directive',
				task_id: '2.3',
				agent: 'reviewer',
				entries: [{ entry_id: entry, critical: true, rank: 1, score: 1 }],
			}),
		);
	});
	afterEach(() => {
		cleanup();
	});

	test('authorized child filing (role match) is accepted', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'reviewer',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([]);
		expect(committed.accepted).toHaveLength(1);
	});

	test('unauthorized same-role filer (no lineage attestation) stays wrong_session with the out-of-band stamp map', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: FOREIGN,
				task_id: '2.3',
				agent: 'reviewer',
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		// Byte-identical rejected item shape (C4 fence pin).
		expect(committed.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
		expect(committed.wrong_session_membership_sessions).toEqual({
			[entry]: ARCH,
		});
	});

	test('lineage attestation does NOT override a role mismatch (fail-closed)', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'test_engineer',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
	});

	test('prefixed agent names normalize for the role match', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'swarm1_reviewer',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([]);
	});

	test('attested session with an EMPTY filing agent role is rejected (fail-closed, review round-2)', async () => {
		const committedEmpty = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: '',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committedEmpty.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
		const committedMissing = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: entry, outcome: 'ignored' }],
			}),
		);
		expect(committedMissing.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
	});

	test('empty/whitespace authorized entries are ignored (sanitization)', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'reviewer',
				authorized_filing_sessions: ['', '   ', CHILD],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
	});

	test('tool filing attributes the ACTUAL filer in the knowledge event (review round-1 nit)', async () => {
		// Drive the real tool surface: register the child's dispatch lineage,
		// then file from the child session and read the knowledge event.
		writeDispatchParentEntry(CHILD, ARCH);
		const raw = await knowledge_receipt.execute(
			{
				trace_id: trace,
				applied: [{ id: entry, how: 'applied during the dispatched review' }],
			} as never,
			{ directory, sessionID: CHILD, agent: 'reviewer' } as never,
		);
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(parsed.recorded).toBe(true);
		const eventsPath = path.join(directory, '.swarm', 'knowledge-events.jsonl');
		const lines = fs
			.readFileSync(eventsPath, 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const applied = lines.filter(
			(line) => line.type === 'applied' && line.knowledge_id === entry,
		);
		expect(applied.length).toBeGreaterThan(0);
		for (const event of applied) {
			expect(event.session_id).toBe(CHILD);
		}
	});

	test('converse normalization: prefixed membership stamp matches plain filer role (PRR-008)', async () => {
		// Seed a membership whose agent carries the swarm prefix.
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-3036-led-prefixed',
				session_id: ARCH,
				exposure_kind: 'delegate_directive',
				task_id: '2.3',
				agent: 'swarm1_reviewer',
				entries: [
					{ entry_id: 'entry-3036-led-pfx', critical: true, rank: 1, score: 1 },
				],
			}),
		);
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-3036-led-prefixed',
				session_id: CHILD,
				task_id: '2.3',
				agent: 'reviewer',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [{ entry_id: 'entry-3036-led-pfx', outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([]);
	});

	test('authorized set is truncated to MAX_AUTHORIZED_FILING_SESSIONS (PRR-002)', async () => {
		// ARCH appears at index 10 — beyond the cap — so the attestation must
		// NOT authorize; a filer-side-only set would wrongly accept.
		const padded = Array.from({ length: 10 }, (_, i) => `ses-filler-${i}`);
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'reviewer',
				authorized_filing_sessions: [CHILD, ...padded, ARCH],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([
			{ entry_id: entry, reason: 'wrong_session' },
		]);
	});

	test('authorized set entries are trimmed (PRR-014 trim pin)', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'reviewer',
				authorized_filing_sessions: [CHILD, `  ${ARCH}  `],
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([]);
	});

	test('mixed batch: accepted authorized item + wrong_session rejection carries per-entry stamp map (PRR-003)', async () => {
		// Seed a second membership stamped by a FOREIGN session.
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: trace,
				session_id: FOREIGN,
				exposure_kind: 'delegate_directive',
				task_id: '2.3',
				agent: 'reviewer',
				entries: [
					{
						entry_id: 'entry-3036-led-foreign',
						critical: true,
						rank: 2,
						score: 1,
					},
				],
			}),
		);
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: CHILD,
				task_id: '2.3',
				agent: 'reviewer',
				authorized_filing_sessions: [CHILD, ARCH],
				items: [
					{ entry_id: entry, outcome: 'applied' },
					{ entry_id: 'entry-3036-led-foreign', outcome: 'applied' },
				],
			}),
		);
		expect(committed.accepted).toHaveLength(1);
		expect(committed.accepted[0]?.entry_id).toBe(entry);
		expect(committed.rejected).toEqual([
			{ entry_id: 'entry-3036-led-foreign', reason: 'wrong_session' },
		]);
		expect(committed.wrong_session_membership_sessions).toEqual({
			'entry-3036-led-foreign': FOREIGN,
		});
	});

	test('same-session filing needs no attestation (legacy callers unchanged)', async () => {
		const committed = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: ARCH,
				task_id: '2.3',
				agent: 'reviewer',
				items: [{ entry_id: entry, outcome: 'applied' }],
			}),
		);
		expect(committed.rejected).toEqual([]);
	});
});
