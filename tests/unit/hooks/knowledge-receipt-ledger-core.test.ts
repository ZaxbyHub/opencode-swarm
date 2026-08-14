import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	commitApplicationMarkerBatch,
	commitDisplayedMembership,
	commitEmptyRetrieval,
	commitPhaseClosed,
	_internals as ledgerInternals,
	queryHistoricalOutcomes,
	queryLiveMemberships,
	type ReceiptLedgerResult,
	recordPhaseCloseIntent,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { _internals as observationInternals } from '../../../src/hooks/knowledge-receipt-observability.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const cleanups: Array<() => void> = [];
const realNowMs = ledgerInternals.nowMs;
const realEmit = observationInternals.emit;

afterEach(() => {
	ledgerInternals.nowMs = realNowMs;
	observationInternals.emit = realEmit;
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

describe('knowledge receipt ledger authority core', () => {
	test('keeps V2 membership independent of more than 5,000 legacy diagnostics', async () => {
		const directory = project('receipt-ledger-diagnostics-');
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(swarmDir);
		const diagnostics = Array.from({ length: 5_101 }, (_, index) =>
			JSON.stringify({
				type: 'outcome',
				event_id: `diagnostic-${index}`,
				timestamp: new Date().toISOString(),
				outcome: 'success',
				evidence_summary: 'diagnostic only',
			}),
		).join('\n');
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			`${diagnostics}\n`,
		);

		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-critical',
				session_id: 'session-a',
				phase: 'phase-a',
				entries: [{ entry_id: 'critical-rule', critical: true }],
			}),
		);

		const live = unwrap(
			await queryLiveMemberships(directory, {
				phase: 'phase-a',
				include_terminal: false,
			}),
		);
		expect(live.memberships).toHaveLength(1);
		expect(live.memberships[0]).toMatchObject({
			trace_id: 'trace-critical',
			entry_id: 'critical-rule',
			critical: true,
		});
	});

	test('validates exact trace pairs and sessions, then enforces terminal idempotency and conflicts', async () => {
		const directory = project('receipt-ledger-terminal-');
		for (const trace_id of ['trace-1', 'trace-2']) {
			unwrap(
				await commitDisplayedMembership(directory, {
					trace_id,
					session_id: 'session-a',
					phase: 'phase-a',
					entries: [{ entry_id: 'shared-entry', critical: true }],
				}),
			);
		}

		const wrongSession = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-1',
				session_id: 'session-b',
				items: [{ entry_id: 'shared-entry', outcome: 'applied' }],
			}),
		);
		expect(wrongSession.accepted).toEqual([]);
		expect(wrongSession.rejected).toEqual([
			{ entry_id: 'shared-entry', reason: 'wrong_session' },
		]);

		const first = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-1',
				session_id: 'session-a',
				cohort_id: 'cohort-a',
				source_link_id: 'source-link-a',
				items: [
					{
						entry_id: 'shared-entry',
						outcome: 'violated',
						source: 'reviewer',
						reason: 'predicate failed',
						event_id: 'stable-terminal-event',
					},
				],
			}),
		);
		expect(first.accepted).toHaveLength(1);
		const firstEventId = first.accepted[0].event_id;
		expect(firstEventId).toBe('stable-terminal-event');

		const retry = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-1',
				session_id: 'session-a',
				items: [{ entry_id: 'shared-entry', outcome: 'violated' }],
			}),
		);
		expect(retry.accepted).toEqual([]);
		expect(retry.idempotent).toEqual(['shared-entry']);
		expect(retry.idempotent_events).toEqual([
			{ entry_id: 'shared-entry', outcome: 'violated', event_id: firstEventId },
		]);

		const conflict = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-1',
				session_id: 'session-a',
				items: [{ entry_id: 'shared-entry', outcome: 'applied' }],
			}),
		);
		expect(conflict.rejected[0]?.reason).toBe('duplicate_conflicting_terminal');

		const authorized = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-1',
				session_id: 'session-a',
				items: [
					{
						entry_id: 'shared-entry',
						outcome: 'applied',
						source: 'reviewer',
					},
				],
				authorization: {
					actor: 'reviewer-remediation',
					reason: 'verified remediation',
					expected_event_id: firstEventId,
				},
			}),
		);
		expect(authorized.accepted[0]?.outcome).toBe('applied');

		const restarted = unwrap(await queryLiveMemberships(directory));
		const trace1 = restarted.memberships.find((m) => m.trace_id === 'trace-1');
		const trace2 = restarted.memberships.find((m) => m.trace_id === 'trace-2');
		expect(trace1?.terminal).toMatchObject({
			outcome: 'applied',
			source: 'reviewer',
		});
		expect(
			trace1?.terminal_history?.map((terminal) => terminal.outcome),
		).toEqual(['violated', 'applied']);
		expect(trace1).toMatchObject({
			cohort_id: 'cohort-a',
			source_link_id: 'source-link-a',
		});
		expect(trace2?.terminal).toBeUndefined();
	});

	test('keeps application markers durable and independent from terminal gate state', async () => {
		const directory = project('receipt-ledger-application-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-app',
				session_id: 'session-app',
				entries: [{ entry_id: 'entry-app', critical: true }],
			}),
		);
		const committed = unwrap(
			await commitApplicationMarkerBatch(directory, {
				trace_id: 'trace-app',
				session_id: 'session-app',
				items: [
					{
						entry_id: 'entry-app',
						outcome: 'applied',
						source: 'executor',
						reason: 'done',
					},
				],
			}),
		);
		expect(committed.committed).toHaveLength(1);
		const retry = unwrap(
			await commitApplicationMarkerBatch(directory, {
				trace_id: 'trace-app',
				session_id: 'session-app',
				items: [{ entry_id: 'entry-app', outcome: 'applied' }],
			}),
		);
		expect(retry.idempotent).toEqual(['entry-app']);
		const membership = unwrap(await queryLiveMemberships(directory))
			.memberships[0];
		expect(membership?.terminal).toBeUndefined();
		expect(membership?.application_marker).toMatchObject({
			outcome: 'applied',
			source: 'executor',
		});
	});

	test('does not let a repeated membership commit erase a durable terminal or change session ownership', async () => {
		const directory = project('receipt-ledger-membership-retry-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-retry',
				session_id: 'session-owner',
				entries: [{ entry_id: 'entry-retry', critical: true }],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-retry',
				session_id: 'session-owner',
				items: [{ entry_id: 'entry-retry', outcome: 'applied' }],
			}),
		);

		// A delivery retry is not a new authority grant. Replaying the same pair
		// must preserve both the original owner and its already-durable terminal.
		const equivalent = unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-retry',
				session_id: 'session-owner',
				entries: [{ entry_id: 'entry-retry', critical: true }],
			}),
		);
		expect(equivalent.memberships[0]?.terminal?.outcome).toBe('applied');

		const divergent = await commitDisplayedMembership(directory, {
			trace_id: 'trace-retry',
			session_id: 'session-attacker',
			entries: [{ entry_id: 'entry-retry', critical: true }],
		});
		expect(divergent.ok).toBe(false);

		const membership = unwrap(await queryLiveMemberships(directory))
			.memberships[0];
		expect(membership?.session_id).toBe('session-owner');
		expect(membership?.terminal?.outcome).toBe('applied');
	});

	test('rejects unknown traces and in-batch conflicts, returns empty terminal identity, and observes committed attempts', async () => {
		const observed: Array<Record<string, unknown>> = [];
		observationInternals.emit = ((_event, data) => {
			observed.push(data);
		}) as typeof observationInternals.emit;
		const directory = project('receipt-ledger-batch-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-batch',
				session_id: 'session-batch',
				entries: [{ entry_id: 'entry-batch', critical: false }],
			}),
		);

		const unknown = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'missing-trace',
				session_id: 'session-batch',
				items: [{ entry_id: 'entry-batch', outcome: 'applied' }],
			}),
		);
		expect(unknown.rejected[0]?.reason).toBe('trace_not_found');

		const duplicate = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-batch',
				session_id: 'session-batch',
				items: [
					{ entry_id: 'entry-batch', outcome: 'applied' },
					{ entry_id: 'entry-batch', outcome: 'violated' },
				],
			}),
		);
		expect(duplicate.accepted).toHaveLength(1);
		expect(duplicate.rejected).toEqual([
			{
				entry_id: 'entry-batch',
				reason: 'duplicate_conflicting_terminal',
			},
		]);
		const retry = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-batch',
				session_id: 'session-batch',
				items: [{ entry_id: 'entry-batch', outcome: 'applied' }],
			}),
		);
		expect(retry.idempotent).toEqual(['entry-batch']);

		const emptyCommit = unwrap(
			await commitEmptyRetrieval(directory, {
				trace_id: 'trace-empty',
				session_id: 'session-batch',
			}),
		);
		const emptyTerminal = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-empty',
				session_id: 'session-batch',
				no_relevant_knowledge: true,
			}),
		);
		expect(emptyTerminal.terminal_event_id).toBeString();
		expect(emptyTerminal.terminal_event_id).toBe(emptyCommit.terminal_event_id);
		const emptyRows = fs
			.readFileSync(
				path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'),
				'utf8',
			)
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(
			emptyRows.filter((row) => row.payload?.trace?.trace_id === 'trace-empty'),
		).toHaveLength(1);

		const transitions = observed.map((entry) => entry.transition);
		expect(transitions).toContain('cutover_completed');
		expect(transitions).toContain('membership_committed');
		expect(transitions).toContain('terminal_committed');
		expect(transitions).toContain('terminal_attempt_rejected');
		expect(transitions).toContain('terminal_attempt_idempotent');
	});

	test('keeps linked projects isolated and never redirects V2 state', async () => {
		const left = project('receipt-ledger-left-');
		const right = project('receipt-ledger-right-');
		for (const directory of [left, right]) {
			fs.mkdirSync(path.join(directory, '.swarm'));
			fs.writeFileSync(
				path.join(directory, '.swarm', 'link.json'),
				JSON.stringify({ cohort_id: 'same-cohort', target: 'shared' }),
			);
		}

		unwrap(
			await commitDisplayedMembership(left, {
				trace_id: 'left-trace',
				session_id: 'left-session',
				entries: [{ entry_id: 'left-entry', critical: false }],
			}),
		);
		unwrap(
			await commitDisplayedMembership(right, {
				trace_id: 'right-trace',
				session_id: 'right-session',
				entries: [{ entry_id: 'right-entry', critical: false }],
			}),
		);

		expect(
			unwrap(await queryLiveMemberships(left)).memberships.map(
				(m) => m.entry_id,
			),
		).toEqual(['left-entry']);
		expect(
			unwrap(await queryLiveMemberships(right)).memberships.map(
				(m) => m.entry_id,
			),
		).toEqual(['right-entry']);
	});

	test('archives a closed zero-grace terminal once and retains historical authority', async () => {
		const directory = project('receipt-ledger-archive-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-archive',
				session_id: 'session-a',
				phase: 'phase-archive',
				grace_days: 0,
				entries: [{ entry_id: 'entry-archive', critical: true }],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-archive',
				session_id: 'session-a',
				items: [{ entry_id: 'entry-archive', outcome: 'applied' }],
			}),
		);
		unwrap(
			await commitEmptyRetrieval(directory, {
				trace_id: 'trace-empty-archive',
				session_id: 'session-a',
				phase: 'phase-archive',
				grace_days: 0,
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-empty-archive',
				session_id: 'session-a',
				no_relevant_knowledge: true,
			}),
		);
		unwrap(await recordPhaseCloseIntent(directory, 'phase-archive'));
		unwrap(await commitPhaseClosed(directory, 'phase-archive'));
		unwrap(await commitPhaseClosed(directory, 'phase-archive'));

		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		const historical = unwrap(
			await queryHistoricalOutcomes(directory, ['entry-archive']),
		);
		expect(historical.memberships).toHaveLength(1);
		expect(historical.memberships[0]?.terminal?.outcome).toBe('applied');

		const archiveLines = fs
			.readFileSync(
				path.join(directory, '.swarm', 'knowledge-receipts-v2-archive.jsonl'),
				'utf8',
			)
			.trim()
			.split('\n');
		expect(archiveLines).toHaveLength(2);
		expect(
			archiveLines.some(
				(line) => JSON.parse(line).summary_kind === 'empty_trace',
			),
		).toBe(true);
	});

	test('compacts an elapsed grace period lazily on a later operation and observes the checkpoint', async () => {
		const observed: Array<Record<string, unknown>> = [];
		observationInternals.emit = ((_event, data) => {
			observed.push(data);
		}) as typeof observationInternals.emit;
		const base = Date.now();
		ledgerInternals.nowMs = () => base;
		const directory = project('receipt-ledger-lazy-archive-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-lazy',
				session_id: 'session-lazy',
				phase: 'phase-lazy',
				grace_days: 1,
				entries: [{ entry_id: 'entry-lazy', critical: false }],
			}),
		);
		ledgerInternals.nowMs = () => base + 10 * 86_400_000;
		expect(
			unwrap(await queryLiveMemberships(directory)).memberships,
		).toHaveLength(1);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-lazy',
				session_id: 'session-lazy',
				items: [{ entry_id: 'entry-lazy', outcome: 'ignored' }],
			}),
		);
		ledgerInternals.nowMs = () => base;
		unwrap(await commitPhaseClosed(directory, 'phase-lazy'));
		expect(
			unwrap(await queryLiveMemberships(directory)).memberships,
		).toHaveLength(1);

		ledgerInternals.nowMs = () => base + 12 * 86_400_000;
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		expect(observed.map((entry) => entry.transition)).toContain('checkpoint');
		expect(
			unwrap(await queryHistoricalOutcomes(directory, ['entry-lazy']))
				.memberships,
		).toHaveLength(1);
	});
});
