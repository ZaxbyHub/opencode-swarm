/**
 * Legacy `'deadline'` workflowLaneFailureClass read compatibility.
 *
 * Durable delegation rows written by pre-#2615 builds carry the retired
 * `'deadline'` failure class. The strict readers (SQLite coordination
 * namespace + legacy JSONL fold, both validated by the same RecordSchema)
 * must read those rows as legitimate history — not classify them as
 * corruption and fail the whole namespace as uncertain — while genuinely
 * unknown values keep failing closed (#2511). The live-producer vocabulary
 * stays closed; only the READ vocabulary widened.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type RecordPendingInput,
	readDelegationsDetailed,
	recordPendingDelegationDetailed,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const HEALTHY = 'sess-legacy-deadline-healthy00000000000';
const LEGACY = 'sess-legacy-deadline-legacy0000000000';

const dirs: string[] = [];

function project(): string {
	const dir = canonicalMkdtemp('bg-legacy-deadline-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function pendingInput(correlationId: string): RecordPendingInput {
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'parent-legacy-deadline',
		callID: `call-${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		generation: 1,
	};
}

/**
 * Seed a healthy row through the production writer, then inject the
 * historical terminal shape into a second row via raw SQL — the only way a
 * `'deadline'` value can exist today (the typed writers cannot produce it;
 * real stores got it from pre-#2615 writers + the verbatim SQLite import).
 */
async function seedSqliteStore(
	dir: string,
	failureClass: string,
): Promise<void> {
	await recordPendingDelegationDetailed(dir, pendingInput(HEALTHY));
	await recordPendingDelegationDetailed(dir, pendingInput(LEGACY));
	const db = getProjectDb(dir);
	const row = db
		.query<{ payload: string }, [string]>(
			`SELECT payload FROM coordination_state
			 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
		)
		.get(LEGACY);
	if (!row) throw new Error('seed failed: coordination row missing');
	const payload = JSON.parse(row.payload) as Record<string, unknown>;
	payload.status = 'error';
	payload.result = {
		chars: 245,
		truncated: false,
		digest: 'a'.repeat(64),
		workflowLaneFailureClass: failureClass,
	};
	payload.completedAt = 1_787_765_830_240;
	payload.updatedAt = 1_787_765_830_240;
	db.run(
		`UPDATE coordination_state SET status = 'error', payload = ?
		 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
		[JSON.stringify(payload), LEGACY],
	);
}

function sqlitePayload(dir: string, entityKey: string): string {
	const row = getProjectDb(dir)
		.query<{ payload: string }, [string]>(
			`SELECT payload FROM coordination_state
			 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
		)
		.get(entityKey);
	if (!row) throw new Error('payload read failed');
	return row.payload;
}

function payloadSha(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

interface FixtureRecord {
	schemaVersion: 2;
	correlationId: string;
	jobId: null;
	subagentSessionId: string;
	parentSessionId: string;
	callID: string;
	normalizedAgent: string;
	swarmPrefixedAgent: string;
	planTaskId: null;
	evidenceTaskId: null;
	status: string;
	createdAt: number;
	updatedAt: number;
	result: {
		chars: number;
		truncated: boolean;
		digest: string;
		workflowLaneFailureClass?: string;
	};
	completedAt?: number;
}

function legacyJsonlRecord(
	correlationId: string,
	failureClass?: string,
): FixtureRecord {
	return {
		schemaVersion: 2,
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'parent-legacy-deadline',
		callID: `call-${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		status: failureClass ? 'error' : 'completed',
		createdAt: 1_787_765_800_000,
		updatedAt: 1_787_765_830_240,
		result: {
			chars: 245,
			truncated: false,
			digest: 'b'.repeat(64),
			...(failureClass ? { workflowLaneFailureClass: failureClass } : {}),
		},
		completedAt: 1_787_765_830_240,
	};
}

function writeJsonlStore(dir: string, records: FixtureRecord[]): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'background-delegations.jsonl'),
		records.map((record) => JSON.stringify(record)).join('\n') + '\n',
		'utf-8',
	);
}

afterEach(() => {
	closeAllProjectDbs();
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('legacy deadline workflowLaneFailureClass read compatibility', () => {
	test('a legacy deadline terminal row reads through both strict readers', async () => {
		const dir = project();
		await seedSqliteStore(dir, 'deadline');

		const payloadBefore = sqlitePayload(dir, LEGACY);
		const detailed = readDelegationsDetailed(dir);
		expect(detailed.status).toBe('ok');
		if (detailed.status !== 'ok') return;
		expect(detailed.records.map((r) => r.correlationId).sort()).toEqual(
			[HEALTHY, LEGACY].sort(),
		);

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');

		const legacyRecord = detailed.records.find(
			(r) => r.correlationId === LEGACY,
		);
		expect(legacyRecord?.result?.workflowLaneFailureClass).toBe('deadline');
		// The authoritative SQLite payload is never rewritten by a read.
		expect(sqlitePayload(dir, LEGACY)).toBe(payloadBefore);
	});

	test('an unknown failure-class value is skipped by the lenient advisory read and stays durably visible', async () => {
		const dir = project();
		await seedSqliteStore(dir, 'bogus');

		// The advisory read is schema-drift tolerant: one drifted row no
		// longer poisons the whole namespace as uncertain. The row is skipped
		// and NAMED on the ok outcome (never silently swallowed).
		const detailed = readDelegationsDetailed(dir);
		expect(detailed.status).toBe('ok');
		if (detailed.status !== 'ok') return;
		expect(detailed.records.map((r) => r.correlationId)).toEqual([HEALTHY]);
		expect(detailed.skippedCoordinationRows).toEqual([LEGACY]);

		// The strict destructive-cleanup view still fails the namespace
		// closed on the same row.
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');

		// PRR-004: the operator-visible signal is the durable health
		// artifact, not just the in-memory read outcome. The schema-drift
		// skip must be identifiable there, with the row key and the lenient
		// coordination-read source.
		const health = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'background-delegations-health.json'),
				'utf-8',
			),
		) as {
			lastCoordinationSkip?: {
				reason?: string;
				source?: string;
				skippedEntityKeys?: string[];
			};
		};
		expect(health.lastCoordinationSkip?.skippedEntityKeys).toContain(LEGACY);
		expect(health.lastCoordinationSkip?.source).toBe(
			'coordination-read-lenient',
		);
		expect(health.lastCoordinationSkip?.reason).toContain(
			'failed schema validation',
		);
	});

	test('an authority-binding mismatch reports its own distinct predicate', async () => {
		// PRR-005: the S1 message split must stay split — a binding
		// mismatch (payload correlationId != entity key) is a different
		// repair path than a schema rejection and must never re-conflate.
		const dir = project();
		await seedSqliteStore(dir, 'deadline');
		const db = getProjectDb(dir);
		const row = db
			.query<{ payload: string }, [string]>(
				`SELECT payload FROM coordination_state
				 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
			)
			.get(LEGACY);
		const payload = JSON.parse(row.payload as string) as Record<
			string,
			unknown
		>;
		payload.correlationId = 'sess-forged-identity-mismatch';
		db.run(
			`UPDATE coordination_state SET payload = ?
			 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
			[JSON.stringify(payload), LEGACY],
		);

		const detailed = readDelegationsDetailed(dir);
		expect(detailed.status).toBe('uncertain');
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		const health = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'background-delegations-health.json'),
				'utf-8',
			),
		) as { lastUncertainty?: { reason?: string } };
		expect(health.lastUncertainty?.reason).toContain(
			'authority binding mismatch',
		);
		expect(health.lastUncertainty?.reason).toContain(LEGACY);
	});

	test('the JSONL fold reads a legacy deadline tail line', () => {
		const dir = project();
		writeJsonlStore(dir, [
			legacyJsonlRecord(HEALTHY),
			legacyJsonlRecord(LEGACY, 'deadline'),
		]);

		// Advisory reader: lenient fold over the JSONL tail.
		const detailed = readDelegationsDetailed(dir);
		expect(detailed.status).toBe('ok');
		if (detailed.status !== 'ok') return;
		expect(detailed.records.map((r) => r.correlationId).sort()).toEqual(
			[HEALTHY, LEGACY].sort(),
		);
		const legacyRecord = detailed.records.find(
			(r) => r.correlationId === LEGACY,
		);
		expect(legacyRecord?.result?.workflowLaneFailureClass).toBe('deadline');

		// Strict recovery scan: same fold, fail-closed semantics.
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
	});

	test('an unknown JSONL failure class keeps the strict scan uncertain', () => {
		const dir = project();
		writeJsonlStore(dir, [
			legacyJsonlRecord(HEALTHY),
			legacyJsonlRecord(LEGACY, 'bogus'),
		]);

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		// The lenient advisory reader skips invalid records by design; only
		// the recognized legacy member is admitted, never unknown values.
		const detailed = readDelegationsDetailed(dir);
		expect(detailed.status).toBe('ok');
		if (detailed.status !== 'ok') return;
		expect(detailed.records.map((r) => r.correlationId)).toEqual([HEALTHY]);
	});

	test('the shadow projection converges once and stays byte-stable', async () => {
		const dir = project();
		await seedSqliteStore(dir, 'deadline');

		const first = readDelegationsDetailed(dir);
		expect(first.status).toBe('ok');

		const shadowPath = path.join(dir, '.swarm', 'background-delegations.jsonl');
		expect(fs.existsSync(shadowPath)).toBe(true);
		const shadowAfterFirst = fs.readFileSync(shadowPath, 'utf-8');
		// The legacy record is projected verbatim, retired value included.
		expect(shadowAfterFirst).toContain('"workflowLaneFailureClass":"deadline"');
		expect(fs.existsSync(`${shadowPath}.sqlite-projection`)).toBe(true);

		const second = readDelegationsDetailed(dir);
		expect(second.status).toBe('ok');
		// Second read: shadow already matches — no further rewrite.
		expect(fs.readFileSync(shadowPath, 'utf-8')).toBe(shadowAfterFirst);
		// And the authoritative payload stayed untouched throughout.
		expect(sqlitePayload(dir, LEGACY)).toContain(
			'"workflowLaneFailureClass":"deadline"',
		);
		expect(payloadSha(sqlitePayload(dir, LEGACY))).toHaveLength(64);
	});
});
