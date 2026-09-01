/**
 * Issue #2045 — lane-side knowledge-ACK reconciliation.
 *
 * Lane outputs never pass through the Task `tool.execute.after` hook, so their
 * ACK markers were never reconciled against the directives shown to the lane
 * session. `collectLaneDelegateAcks` derives the proven-shown set from the
 * receipt ledger's session-bound `delegate_directive` memberships (what the
 * transform-path injector actually displayed) and runs the SAME shared core as
 * the Task adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectLaneDelegateAcks } from '../../../src/hooks/delegate-ack-collector.js';
import {
	type KnowledgeEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events.js';
import {
	commitDisplayedMembership,
	queryLiveMemberships,
} from '../../../src/hooks/knowledge-receipt-ledger.js';

const LANE_SESSION_ID = 'sess-lane-child-1';
const PARENT_SESSION_ID = 'sess-lane-parent-1';
const TRACE_ID = 'trace-lane-2045-0001';

const ID_APPLIED = '11111111-1111-4111-8111-111111111111';
const ID_IGNORED = '22222222-2222-4222-8222-222222222222';
const ID_CRITICAL = '33333333-3333-4333-8333-333333333333';
const ID_SPOOFED = '99999999-9999-4999-8999-999999999999';

async function seedMemberships(
	directory: string,
	entries: Array<{ entry_id: string; critical: boolean }>,
	options: { phase?: string } = {},
): Promise<void> {
	const committed = await commitDisplayedMembership(directory, {
		trace_id: TRACE_ID,
		session_id: LANE_SESSION_ID,
		phase: options.phase,
		agent: 'mega_sme',
		exposure_kind: 'delegate_directive',
		entries,
	});
	expect(committed.ok).toBe(true);
}

function receipts(events: KnowledgeEvent[]) {
	return events
		.filter((e) =>
			['applied', 'ignored', 'violated', 'n_a', 'unacknowledged'].includes(
				e.type,
			),
		)
		.map((e) => ({
			id: (e as { knowledge_id?: string }).knowledge_id,
			type: e.type,
		}));
}

describe('collectLaneDelegateAcks (issue #2045)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'lane-knowledge-receipts-')),
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('queries by the SUBAGENT session: a parent-session query finds nothing', async () => {
		await seedMemberships(dir, [{ entry_id: ID_APPLIED, critical: false }]);
		const parentQuery = await queryLiveMemberships(dir, {
			session_id: PARENT_SESSION_ID,
			exposure_kind: 'delegate_directive',
		});
		expect(parentQuery.ok && parentQuery.memberships).toHaveLength(0);
		const childQuery = await queryLiveMemberships(dir, {
			session_id: LANE_SESSION_ID,
			exposure_kind: 'delegate_directive',
		});
		expect(childQuery.ok && childQuery.memberships).toHaveLength(1);
	});

	it('emits one receipt per acked shown directive with the delegate source', async () => {
		await seedMemberships(dir, [
			{ entry_id: ID_APPLIED, critical: false },
			{ entry_id: ID_IGNORED, critical: false },
		]);
		const transcript = [
			'lane finished',
			`KNOWLEDGE_APPLIED:${TRACE_ID}:${ID_APPLIED}`,
			`KNOWLEDGE_IGNORED:${TRACE_ID}:${ID_IGNORED} reason=not applicable`,
		].join('\n');
		const result = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: LANE_SESSION_ID,
			agent: 'mega_sme',
			transcript,
		});
		expect(result.emitted).toEqual([
			{ id: ID_APPLIED, type: 'applied' },
			{ id: ID_IGNORED, type: 'ignored' },
		]);
		const events = await readKnowledgeEvents(dir);
		const applied = receipts(events);
		expect(applied).toContainEqual({ id: ID_APPLIED, type: 'applied' });
		expect(applied).toContainEqual({ id: ID_IGNORED, type: 'ignored' });
		// Every event is delegate-sourced (self-report; non-independent for the
		// promotion gate — the issue's high-risk acceptance contract).
		for (const event of events) {
			if ((event as { source?: string }).type === 'applied') {
				expect((event as { source?: string }).source).toBe('delegate');
			}
		}
	});

	it('drops acks for IDs never shown (anti-spoofing)', async () => {
		await seedMemberships(dir, [{ entry_id: ID_APPLIED, critical: false }]);
		const result = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: LANE_SESSION_ID,
			agent: 'mega_sme',
			transcript: `KNOWLEDGE_APPLIED:${TRACE_ID}:${ID_SPOOFED}`,
		});
		// The spoofed ack is DROPPED: it never becomes an applied receipt, and it
		// does not count as acknowledging the shown directive either — the shown
		// one falls through to the neutral unacknowledged observation instead.
		expect(result.emitted).toEqual([
			{ id: ID_APPLIED, type: 'unacknowledged' },
		]);
		const events = await readKnowledgeEvents(dir);
		const all = receipts(events);
		expect(all).toContainEqual({
			id: ID_APPLIED,
			type: 'unacknowledged',
		});
		expect(all.find((r) => r.id === ID_SPOOFED)).toBeUndefined();
	});

	it('an unacknowledged critical becomes violated + audited; non-criticals become unacknowledged', async () => {
		await seedMemberships(dir, [
			{ entry_id: ID_CRITICAL, critical: true },
			{ entry_id: ID_IGNORED, critical: false },
		]);
		const result = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: LANE_SESSION_ID,
			agent: 'mega_sme',
			transcript: 'lane finished without acknowledging anything',
		});
		expect(result.unacknowledgedCriticals).toEqual([ID_CRITICAL]);
		expect(result.unacknowledgedNonCritical).toEqual([ID_IGNORED]);
		const events = await readKnowledgeEvents(dir);
		expect(receipts(events)).toContainEqual({
			id: ID_CRITICAL,
			type: 'violated',
		});
		expect(receipts(events)).toContainEqual({
			id: ID_IGNORED,
			type: 'unacknowledged',
		});
		const criticalsPath = path.join(
			dir,
			'.swarm',
			'unacknowledged-criticals.jsonl',
		);
		expect(fs.existsSync(criticalsPath)).toBe(true);
	});

	it('is a no-op when the lane session has no memberships', async () => {
		const result = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: 'sess-never-injected',
			agent: 'mega_sme',
			transcript: `KNOWGE_APPLIED:${TRACE_ID}:${ID_APPLIED}`,
		});
		expect(result.emitted).toHaveLength(0);
		expect(result.phases).toHaveLength(0);
	});

	it('is idempotent across duplicate settles (validator idempotency)', async () => {
		await seedMemberships(dir, [{ entry_id: ID_APPLIED, critical: false }]);
		const transcript = `KNOWLEDGE_APPLIED:${TRACE_ID}:${ID_APPLIED}`;
		const first = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: LANE_SESSION_ID,
			agent: 'mega_sme',
			transcript,
		});
		expect(first.emitted).toEqual([{ id: ID_APPLIED, type: 'applied' }]);
		// Replay the exact same reconciliation (a duplicate settle re-ran the
		// observation): the validator reports idempotent skips, no double events.
		const second = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: LANE_SESSION_ID,
			agent: 'mega_sme',
			transcript,
		});
		expect(second.emitted).toHaveLength(0);
		const appliedCount = (await readKnowledgeEvents(dir)).filter(
			(e) =>
				e.type === 'applied' &&
				(e as { knowledge_id?: string }).knowledge_id === ID_APPLIED,
		);
		expect(appliedCount).toHaveLength(1);
	});

	it('replay mode recovers authoritative receipts without double-emitting the unacknowledged observation', async () => {
		// Issue #2045 crash-recovery contract: the ledger-committed receipts are
		// replay-safe; the audit-only non-critical `unacknowledged` observation is
		// NOT (it bypasses the ledger), so replay mode suppresses it.
		await seedMemberships(dir, [{ entry_id: ID_APPLIED, critical: false }]);
		// First pass: no ACK marker for the shown non-critical -> one
		// unacknowledged observation.
		const first = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: LANE_SESSION_ID,
			agent: 'mega_sme',
			transcript: 'lane finished without acking anything',
		});
		expect(first.emitted).toEqual([{ id: ID_APPLIED, type: 'unacknowledged' }]);
		// Replay (duplicate settle path): the same reconciliation must not
		// append a second unacknowledged event.
		const replay = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: LANE_SESSION_ID,
			agent: 'mega_sme',
			transcript: 'lane finished without acking anything',
			replay: true,
		});
		expect(replay.emitted).toHaveLength(0);
		const events = await readKnowledgeEvents(dir);
		const unacknowledged = events.filter(
			(e) =>
				e.type === 'unacknowledged' &&
				(e as { knowledge_id?: string }).knowledge_id === ID_APPLIED,
		);
		expect(unacknowledged).toHaveLength(1);
	});

	it('reports membership phases for reviewer verdict windowing', async () => {
		await seedMemberships(dir, [{ entry_id: ID_APPLIED, critical: false }], {
			phase: 'Phase 2',
		});
		const result = await collectLaneDelegateAcks({
			directory: dir,
			sessionId: LANE_SESSION_ID,
			agent: 'mega_sme',
			transcript: `KNOWLEDGE_APPLIED:${TRACE_ID}:${ID_APPLIED}`,
		});
		expect(result.phases).toEqual(['Phase 2']);
	});
});
