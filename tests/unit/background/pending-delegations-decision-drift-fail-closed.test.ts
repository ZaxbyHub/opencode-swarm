/**
 * Decision-path ledger reads fail closed on schema-drifted rows
 * (#2703-review F-005).
 *
 * The ordinary advisory read is lenient towards drifted coordination rows
 * (a writer from a newer plugin release whose vocabulary the current reader
 * lacks): the row is skipped and NAMED, so status views keep working. But in
 * mixed-version/downgrade use the drifted rows are the NEWEST ones — a
 * decision caller that checks only `status === 'uncertain'` would then bind
 * an OLDER record as the current truth (a sounding-board evidenceTaskId, a
 * review-routing file list). Every decision consumer reads through
 * `readDelegationsDetailedForDecisions`: a non-empty skip set is
 * uncertainty, never a complete-looking older view.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	findByCorrelationIdDetailed,
	findLatestCoderTaskForParentSession,
	type RecordPendingInput,
	readDelegationsDetailed,
	readDelegationsDetailedForDecisions,
	recordPendingDelegationDetailed,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const HEALTHY = 'sess-drift-healthy000000000000000000000';
const DRIFTED = 'sess-drift-newest00000000000000000000';
const PARENT = 'parent-drift-decision';

const dirs: string[] = [];

function project(): string {
	const dir = canonicalMkdtemp('bg-decision-drift-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function coderInput(
	correlationId: string,
	planTaskId: string,
	updatedAt: number,
): RecordPendingInput {
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: PARENT,
		callID: `call-${correlationId}`,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId,
		evidenceTaskId: planTaskId,
		generation: 1,
		updatedAt,
	} as RecordPendingInput;
}

/**
 * Seed one healthy older coder row through the production writer, then one
 * NEWER coder row whose payload is injected (raw SQL) with an unknown
 * workflowLaneFailureClass — the mixed-version drift shape: the newest row
 * came from a writer whose vocabulary this reader lacks.
 */
async function seedDriftedNewestCoderRow(dir: string): Promise<void> {
	await recordPendingDelegationDetailed(dir, coderInput(HEALTHY, '1.1', 1000));
	await recordPendingDelegationDetailed(dir, coderInput(DRIFTED, '1.2', 2000));
	const db = getProjectDb(dir);
	const row = db
		.query<{ payload: string }, [string]>(
			`SELECT payload FROM coordination_state
			 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
		)
		.get(DRIFTED);
	if (!row) throw new Error('seed failed: coordination row missing');
	const payload = JSON.parse(row.payload) as Record<string, unknown>;
	payload.status = 'error';
	payload.result = {
		chars: 245,
		truncated: false,
		digest: 'a'.repeat(64),
		workflowLaneFailureClass: 'vocabulary-from-a-newer-release',
	};
	payload.completedAt = 2000;
	payload.updatedAt = 2000;
	db.run(
		`UPDATE coordination_state SET status = 'error', payload = ?
		 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
		[JSON.stringify(payload), DRIFTED],
	);
}

afterEach(() => {
	closeAllProjectDbs();
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('decision-path delegation reads fail closed on drifted rows', () => {
	test('the advisory read stays lenient (ok with the drifted row named)', async () => {
		const dir = project();
		await seedDriftedNewestCoderRow(dir);

		const detailed = readDelegationsDetailed(dir);
		expect(detailed.status).toBe('ok');
		if (detailed.status !== 'ok') return;
		expect(detailed.records.map((r) => r.correlationId)).toEqual([HEALTHY]);
		expect(detailed.skippedCoordinationRows).toEqual([DRIFTED]);
	});

	test('the decision reader converts the skip set into uncertainty', async () => {
		const dir = project();
		await seedDriftedNewestCoderRow(dir);

		const decision = readDelegationsDetailedForDecisions(dir);
		expect(decision.status).toBe('uncertain');
		if (decision.status === 'uncertain') {
			expect(decision.reason).toContain('skipped schema validation');
		}
	});

	test('a drifted NEWEST coder row does not bind the older task as current', async () => {
		const dir = project();
		await seedDriftedNewestCoderRow(dir);

		// The advisory read would answer task 1.1 (the healthy older row) —
		// exactly the wrong binding, because the newest coder round (1.2) is
		// the unreadable one. The decision path must refuse instead.
		const latest = findLatestCoderTaskForParentSession(dir, PARENT);
		expect(latest.status).toBe('uncertain');
	});

	test('an exact-correlation decision lookup also fails closed on the skip set', async () => {
		const dir = project();
		await seedDriftedNewestCoderRow(dir);

		// Even a lookup for the HEALTHY correlation must not answer ok from a
		// partially-skipped store: another drifted row could be the same
		// identity at a newer revision.
		const lookup = findByCorrelationIdDetailed(dir, HEALTHY);
		expect(lookup.status).toBe('uncertain');
	});

	test('a healthy store (no drift) still reads ok through the decision reader', async () => {
		const dir = project();
		await recordPendingDelegationDetailed(
			dir,
			coderInput(HEALTHY, '1.1', 1000),
		);

		const decision = readDelegationsDetailedForDecisions(dir);
		expect(decision.status).toBe('ok');
		const latest = findLatestCoderTaskForParentSession(dir, PARENT);
		expect(latest.status).toBe('ok');
		if (latest.status === 'ok') {
			expect(latest.taskId).toBe('1.1');
		}
	});
});
