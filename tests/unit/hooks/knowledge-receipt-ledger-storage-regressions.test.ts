import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	commitDisplayedMembership,
	commitPhaseClosed,
	ensureLegacyCutover,
	queryLiveMemberships,
	type ReceiptLedgerResult,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
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

async function seedMembership(
	directory: string,
	input: {
		trace_id: string;
		session_id: string;
		phase: string;
		task_id?: string;
		entry_id: string;
	},
): Promise<void> {
	unwrap(
		await commitDisplayedMembership(directory, {
			trace_id: input.trace_id,
			session_id: input.session_id,
			phase: input.phase,
			task_id: input.task_id,
			exposure_kind: 'architect_directive',
			entries: [{ entry_id: input.entry_id, critical: true }],
		}),
	);
}

describe('knowledge receipt storage final-critic regressions', () => {
	test('phase closure is isolated by exact session and rejects ambiguous inference', async () => {
		const directory = project('receipt-lifecycle-session-');
		await seedMembership(directory, {
			trace_id: 'trace-one',
			session_id: 'session-one',
			phase: 'Shared phase',
			task_id: 'task-one',
			entry_id: 'entry-one',
		});
		await seedMembership(directory, {
			trace_id: 'trace-two',
			session_id: 'session-two',
			phase: 'Shared phase',
			task_id: 'task-two',
			entry_id: 'entry-two',
		});

		// Previous code keyed lifecycle by phase text and closed both sessions.
		unwrap(await commitPhaseClosed(directory, 'Shared phase', 'session-one'));
		const scoped = unwrap(await queryLiveMemberships(directory)).memberships;
		expect(
			scoped.find((item) => item.session_id === 'session-one')?.phase_closed_at,
		).toBeString();
		expect(
			scoped.find((item) => item.session_id === 'session-two')?.phase_closed_at,
		).toBeUndefined();

		const ambiguous = await commitPhaseClosed(directory, 'Shared phase');
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) {
			expect(ambiguous.code).toBe('store_unavailable');
			expect(ambiguous.detail).toContain('ambiguous');
		}
	});

	test('explicit session closure persists even when the phase has no receipts', async () => {
		const directory = project('receipt-lifecycle-empty-');
		const closed = unwrap(
			await commitPhaseClosed(directory, 'Empty phase', 'truthful-session'),
		);
		expect(closed.event_id).toBeString();
		const snapshot = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'knowledge-receipts-v2.snapshot.json'),
				'utf8',
			),
		) as { phase_lifecycle: Array<Record<string, unknown>> };
		expect(snapshot.phase_lifecycle).toContainEqual(
			expect.objectContaining({
				phase: 'Empty phase',
				session_id: 'truthful-session',
			}),
		);
	});

	test('a closed exact lifecycle cannot be reopened by a new membership', async () => {
		const directory = project('receipt-lifecycle-reopen-');
		await seedMembership(directory, {
			trace_id: 'trace-closed',
			session_id: 'session-closed',
			phase: 'Closed scope',
			task_id: 'task-closed',
			entry_id: 'entry-closed',
		});
		unwrap(
			await commitPhaseClosed(directory, 'Closed scope', 'session-closed'),
		);

		// Previous replay accepted a new pair without inheriting/rejecting closure.
		const reopened = await commitDisplayedMembership(directory, {
			trace_id: 'trace-reopened',
			session_id: 'session-closed',
			phase: 'Closed scope',
			task_id: 'task-closed',
			exposure_kind: 'architect_directive',
			entries: [{ entry_id: 'entry-reopened', critical: true }],
		});
		expect(reopened.ok).toBe(false);
		if (!reopened.ok) expect(reopened.detail).toContain('closed lifecycle');

		const independent = await commitDisplayedMembership(directory, {
			trace_id: 'trace-independent',
			session_id: 'different-session',
			phase: 'Closed scope',
			task_id: 'task-closed',
			exposure_kind: 'architect_directive',
			entries: [{ entry_id: 'entry-independent', critical: true }],
		});
		expect(independent.ok).toBe(true);
	});

	test('imports a structurally complete unresolved multi-day legacy trace', async () => {
		const directory = project('receipt-legacy-multiday-');
		fs.mkdirSync(path.join(directory, '.swarm'));
		fs.writeFileSync(
			path.join(directory, '.swarm', 'knowledge-events.jsonl'),
			`${JSON.stringify({
				type: 'retrieved',
				event_id: 'legacy-retrieval',
				trace_id: 'legacy-multiday-trace',
				timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				session_id: 'legacy-session',
				phase: 'Multi-day phase',
				result_ids: ['legacy-entry'],
			})}\n`,
			'utf8',
		);

		// Previous code treated age >30 minutes as proof the live phase had ended.
		unwrap(await ensureLegacyCutover(directory));
		const terminal = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'legacy-multiday-trace',
				session_id: 'legacy-session',
				items: [{ entry_id: 'legacy-entry', outcome: 'applied' }],
			}),
		);
		expect(terminal.accepted).toHaveLength(1);
		expect(terminal.rejected).toEqual([]);
	});

	test('rejects event ID reuse for a distinct authorized terminal transition', async () => {
		const directory = project('receipt-terminal-event-id-');
		await seedMembership(directory, {
			trace_id: 'trace-event',
			session_id: 'session-event',
			phase: 'Event phase',
			entry_id: 'entry-event',
		});
		const first = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-event',
				session_id: 'session-event',
				items: [
					{
						entry_id: 'entry-event',
						outcome: 'violated',
						event_id: 'stable-event-id',
					},
				],
			}),
		);
		expect(first.accepted).toHaveLength(1);

		const retry = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-event',
				session_id: 'session-event',
				items: [
					{
						entry_id: 'entry-event',
						outcome: 'violated',
						event_id: 'stable-event-id',
					},
				],
			}),
		);
		expect(retry.idempotent_events).toEqual([
			{
				entry_id: 'entry-event',
				outcome: 'violated',
				event_id: 'stable-event-id',
			},
		]);

		const reused = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-event',
				session_id: 'session-event',
				items: [
					{
						entry_id: 'entry-event',
						outcome: 'applied',
						event_id: 'stable-event-id',
					},
				],
				authorization: {
					actor: 'reviewer-remediation',
					reason: 'verified remediation',
					expected_event_id: 'stable-event-id',
				},
			}),
		);
		expect(reused.accepted).toEqual([]);
		expect(reused.rejected).toEqual([
			{ entry_id: 'entry-event', reason: 'event_id_conflict' },
		]);
		const membership = unwrap(await queryLiveMemberships(directory))
			.memberships[0];
		expect(membership.terminal?.outcome).toBe('violated');
		expect(membership.terminal_history).toHaveLength(1);
	});

	test('terminal commits reject supplied phase or task identities that do not match membership', async () => {
		const directory = project('receipt-terminal-scope-');
		await seedMembership(directory, {
			trace_id: 'trace-scope',
			session_id: 'session-scope',
			phase: 'Phase one',
			task_id: 'task-one',
			entry_id: 'entry-scope',
		});

		const wrongPhase = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-scope',
				session_id: 'session-scope',
				phase: 'Phase two',
				task_id: 'task-one',
				items: [{ entry_id: 'entry-scope', outcome: 'applied' }],
			}),
		);
		expect(wrongPhase.rejected).toEqual([
			{ entry_id: 'entry-scope', reason: 'wrong_phase' },
		]);

		const wrongTask = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-scope',
				session_id: 'session-scope',
				phase: 'Phase one',
				task_id: 'task-two',
				items: [{ entry_id: 'entry-scope', outcome: 'applied' }],
			}),
		);
		expect(wrongTask.rejected).toEqual([
			{ entry_id: 'entry-scope', reason: 'wrong_task' },
		]);

		const exact = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-scope',
				session_id: 'session-scope',
				phase: 'Phase one',
				task_id: 'task-one',
				items: [{ entry_id: 'entry-scope', outcome: 'applied' }],
			}),
		);
		expect(exact.accepted).toHaveLength(1);
	});
});
