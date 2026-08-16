import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	commitDisplayedMembership,
	commitEmptyRetrieval,
	compactKnowledgeReceiptLedger,
	queryLiveMemberships,
	type ReceiptLedgerResult,
	recordPhaseCloseIntent,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { receiptRecordHash } from '../../../src/hooks/knowledge-receipt-ledger-storage.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const cleanups: Array<() => void> = [];
const originalMaxJournalRecords = _internals.maxJournalRecords;

afterEach(() => {
	_internals.maxJournalRecords = originalMaxJournalRecords;
	while (cleanups.length > 0) cleanups.pop()?.();
});

function project(prefix: string): string {
	const fixture = createSafeTestDir(prefix);
	cleanups.push(fixture.cleanup);
	fs.mkdirSync(path.join(fixture.dir, '.git'));
	return fixture.dir;
}

function unwrap<T>(result: ReceiptLedgerResult<T>): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
	return result;
}

function journalRows(directory: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(
			path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'utf8',
		)
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('knowledge receipt checkpoint audit and empty identity', () => {
	test('returns a terminal event id carried by a real exact empty terminal row', async () => {
		const directory = project('receipt-empty-terminal-row-');
		const committed = unwrap(
			await commitEmptyRetrieval(directory, {
				trace_id: 'empty-trace',
				session_id: 'empty-session',
				phase: 'empty-phase',
			}),
		);
		const rows = journalRows(directory);
		const terminal = rows.find(
			(row) => row.event_id === committed.terminal_event_id,
		);
		expect(terminal).toMatchObject({
			kind: 'terminal_committed',
			payload: {
				empty_trace_id: 'empty-trace',
				empty_trace_session_id: 'empty-session',
			},
		});

		const retry = unwrap(
			await commitEmptyRetrieval(directory, {
				trace_id: 'empty-trace',
				session_id: 'empty-session',
				phase: 'empty-phase',
			}),
		);
		expect(retry).toEqual(committed);
		expect(
			journalRows(directory).filter(
				(row) => row.event_id === committed.terminal_event_id,
			),
		).toHaveLength(1);
	});

	test('retains a bounded hash-covered audit tail when the journal exceeds its cap', async () => {
		const directory = project('receipt-checkpoint-audit-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'audit-trace',
				session_id: 'audit-session',
				phase: 'audit-phase',
				entries: [{ entry_id: 'audit-entry', critical: true }],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'audit-trace',
				session_id: 'audit-session',
				items: [{ entry_id: 'audit-entry', outcome: 'applied' }],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'audit-trace',
				session_id: 'audit-session',
				items: [{ entry_id: 'audit-entry', outcome: 'applied' }],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'audit-trace',
				session_id: 'audit-session',
				items: [{ entry_id: 'missing-entry', outcome: 'applied' }],
			}),
		);
		unwrap(await recordPhaseCloseIntent(directory, 'audit-phase'));

		_internals.maxJournalRecords = 1;
		unwrap(await compactKnowledgeReceiptLedger(directory));
		const rows = journalRows(directory);
		expect(rows).toHaveLength(1);
		const checkpoint = rows[0];
		expect(checkpoint.kind).toBe('checkpoint');
		const { hash, ...withoutHash } = checkpoint;
		expect(hash).toBe(receiptRecordHash(withoutHash));
		const payload = checkpoint.payload as {
			audit_tail: Array<{
				kind: string;
				original_hash: string;
				entry_ids?: string[];
				reason_codes?: string[];
			}>;
		};
		expect(payload.audit_tail.length).toBeLessThanOrEqual(256);
		const kinds = payload.audit_tail.map((entry) => entry.kind);
		expect(kinds).toContain('cutover_completed');
		expect(kinds).toContain('terminal_attempt_idempotent');
		expect(kinds).toContain('terminal_attempt_rejected');
		expect(kinds).toContain('phase_close_intent');
		expect(
			payload.audit_tail.every((entry) => entry.original_hash.length > 0),
		).toBe(true);
		expect(
			payload.audit_tail.find(
				(entry) => entry.kind === 'terminal_attempt_rejected',
			)?.reason_codes,
		).toEqual(['id_not_in_trace']);
	});
});
