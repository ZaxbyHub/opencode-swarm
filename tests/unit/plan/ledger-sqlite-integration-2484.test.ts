import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db';
import {
	_internals,
	appendLedgerEvent,
	clearPlanLedgerForReset,
	computePlanLedgerHash,
	initLedger,
	LedgerStaleWriterError,
	readLedgerEvents,
	readLedgerEventsWithIntegrity,
	replacePlanLedgerWithRoot,
} from '../../../src/plan/ledger';
import {
	appendSqliteLedger,
	clearSqliteLedger,
	cutoverSqliteLedger,
	getPlanLedgerState,
	hasSqliteLedger,
	readSqliteLedgerEvents,
} from '../../../src/plan/ledger-sqlite';
import { derivePlanId } from '../../../src/plan/utils';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const fixtures: Array<ReturnType<typeof createSafeTestDir>> = [];

afterEach(() => {
	while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'SQLite ledger integration regression',
		swarm: 'ledger-2484',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Exercise the plan ledger',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

async function createLedgerFixture(prefix = 'ledger-2484-') {
	const fixture = createSafeTestDir(prefix);
	fixtures.push(fixture);
	const plan = makePlan();
	const swarmDir = path.join(fixture.dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
	await initLedger(
		fixture.dir,
		derivePlanId(plan),
		computePlanLedgerHash(plan),
		plan,
	);
	return { directory: fixture.dir, plan };
}

async function promoteToSqliteAuthority(directory: string): Promise<void> {
	const state = getPlanLedgerState(directory);
	if (!state) throw new Error('fixture did not initialize SQLite ledger state');
	cutoverSqliteLedger(directory, {
		expectedShadowStartedVersion: state.shadowStartedVersion ?? undefined,
	});
}

function ledgerPath(directory: string): string {
	return path.join(directory, '.swarm', 'plan-ledger.jsonl');
}

function appendExportEvent(
	directory: string,
	plan: Plan,
	source: string,
	options?: { expectedSeq?: number },
) {
	return appendLedgerEvent(
		directory,
		{
			plan_id: derivePlanId(plan),
			event_type: 'plan_exported',
			source,
		},
		{
			planHashAfter: computePlanLedgerHash(plan),
			...options,
		},
	);
}

describe('plan ledger SQLite migration and authority — issue #2484 regressions', () => {
	test('SQLite authority resists valid-JSON terminal hash tampering and repairs the export', async () => {
		// Before SQLite authority, a valid-JSON hash edit could be accepted as the next clean export.
		const { directory } = await createLedgerFixture();
		await promoteToSqliteAuthority(directory);
		const original = fs.readFileSync(ledgerPath(directory), 'utf8');
		const lines = original.trimEnd().split(/\r?\n/);
		const terminal = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
		terminal.plan_hash_after =
			terminal.plan_hash_after === '0'.repeat(64)
				? '1'.repeat(64)
				: '0'.repeat(64);
		lines[lines.length - 1] = JSON.stringify(terminal);
		fs.writeFileSync(ledgerPath(directory), `${lines.join('\n')}\n`, 'utf8');
		const result = await readLedgerEventsWithIntegrity(directory);
		expect(result.events).toHaveLength(1);
		expect(hasSqliteLedger(directory)).toBe(true);
		expect(getPlanLedgerState(directory)?.authorityMode).toBe('sqlite');
		expect(fs.readFileSync(ledgerPath(directory), 'utf8')).toBe(original);
	});

	test('SQLite authority rejects a valid exact-prefix JSONL extension and repairs the export', async () => {
		// Before this fix, the exact-prefix branch promoted this forged suffix into SQLite.
		const { directory } = await createLedgerFixture();
		await promoteToSqliteAuthority(directory);
		const original = fs.readFileSync(ledgerPath(directory), 'utf8');
		const root = JSON.parse(original.trimEnd()) as Record<string, unknown>;
		const forgedExtension = {
			seq: 2,
			timestamp: new Date().toISOString(),
			plan_id: root.plan_id,
			event_type: 'plan_exported',
			source: 'forged-portable-extension',
			plan_hash_before: 'd'.repeat(64),
			plan_hash_after: 'e'.repeat(64),
			schema_version: root.schema_version,
		};
		fs.writeFileSync(
			ledgerPath(directory),
			`${original}${JSON.stringify(forgedExtension)}\n`,
			'utf8',
		);

		const result = await readLedgerEventsWithIntegrity(directory);
		expect(result.events).toHaveLength(1);
		expect(readSqliteLedgerEvents(directory).events).toHaveLength(1);
		expect(getPlanLedgerState(directory)?.lastSeq).toBe(1);
		expect(fs.readFileSync(ledgerPath(directory), 'utf8')).toBe(original);
	});

	test('fails closed when a typed SQLite event column disagrees with its canonical BLOB', async () => {
		const { directory } = await createLedgerFixture();
		await promoteToSqliteAuthority(directory);
		getProjectDb(directory).run(
			"UPDATE plan_ledger_event SET event_type = 'plan_exported' WHERE seq = 1",
		);

		expect(() => readSqliteLedgerEvents(directory)).toThrow(
			/SQLite plan-ledger event 1 .*mismatch/,
		);
		await expect(readLedgerEvents(directory)).rejects.toThrow(
			/SQLite plan-ledger event 1 .*mismatch/,
		);
	});

	test('imports legacy JSONL, repairs shadow parity, then cuts over to SQLite authority', async () => {
		// Before the staged migration, legacy JSONL had no durable shadow/cutover proof.
		const { directory, plan } = await createLedgerFixture();
		clearSqliteLedger(directory);
		closeProjectDb(directory);

		expect(await readLedgerEvents(directory)).toHaveLength(1);
		expect(getPlanLedgerState(directory)?.authorityMode).toBe('file_shadow');
		await appendExportEvent(directory, plan, 'legacy-shadow-append');
		expect(await readLedgerEvents(directory)).toHaveLength(2);
		expect(getPlanLedgerState(directory)?.parityStatus).toBe('clean');

		await promoteToSqliteAuthority(directory);
		expect(getPlanLedgerState(directory)?.authorityMode).toBe('sqlite');
		closeProjectDb(directory);
		expect(await readLedgerEvents(directory)).toHaveLength(2);
		expect(getPlanLedgerState(directory)?.authorityMode).toBe('sqlite');
	});

	test('does not report a committed SQLite append as failed when export publication fails', async () => {
		// Before the authority split, an export failure could make a committed append look uncommitted.
		const { directory, plan } = await createLedgerFixture();
		await promoteToSqliteAuthority(directory);
		const originalWriter = _internals.writeFileFsyncedThenRename;
		_internals.writeFileFsyncedThenRename = () => {
			throw new Error('injected portable export failure');
		};
		try {
			await expect(
				appendExportEvent(directory, plan, 'sqlite-authority-append'),
			).resolves.toMatchObject({ seq: 2 });
		} finally {
			_internals.writeFileFsyncedThenRename = originalWriter;
		}

		expect(readSqliteLedgerEvents(directory).events).toHaveLength(2);
		expect(getPlanLedgerState(directory)?.lastSeq).toBe(2);
		expect(
			fs.readFileSync(ledgerPath(directory), 'utf8').trimEnd().split(/\r?\n/),
		).toHaveLength(1);
		// The next read treats SQLite as authoritative and repairs the missing export.
		expect(await readLedgerEvents(directory)).toHaveLength(2);
		expect(
			fs.readFileSync(ledgerPath(directory), 'utf8').trimEnd().split(/\r?\n/),
		).toHaveLength(2);
	});

	test('does not change file-shadow authority when rollback JSONL publication fails', async () => {
		const { directory, plan } = await createLedgerFixture();
		const originalFile = fs.readFileSync(ledgerPath(directory));
		const originalSqlite =
			readSqliteLedgerEvents(directory).events[0]!.canonicalEvent;
		const replacement = structuredClone(plan);
		replacement.title = 'Unpublished rollback root';
		const originalWriter = _internals.writeFileFsyncedThenRename;
		_internals.writeFileFsyncedThenRename = () => {
			throw new Error('injected rollback JSONL publication failure');
		};
		try {
			await expect(
				replacePlanLedgerWithRoot(directory, replacement, 'rollback'),
			).rejects.toThrow('injected rollback JSONL publication failure');
		} finally {
			_internals.writeFileFsyncedThenRename = originalWriter;
		}

		expect(fs.readFileSync(ledgerPath(directory))).toEqual(originalFile);
		expect(readSqliteLedgerEvents(directory).events[0]!.canonicalEvent).toEqual(
			originalSqlite,
		);
		expect(getPlanLedgerState(directory)?.authorityMode).toBe('file_shadow');
	});

	test('rolls back event and state together when SQLite append state validation fails', async () => {
		// Before FULL transactions covered both tables, an event could survive a state-write fault.
		const { directory } = await createLedgerFixture();
		await promoteToSqliteAuthority(directory);
		const first = readSqliteLedgerEvents(directory).events[0]!.event;
		const second = JSON.stringify({
			seq: 2,
			timestamp: new Date().toISOString(),
			plan_id: first.plan_id,
			event_type: 'plan_exported',
			source: 'transaction-fault',
			plan_hash_before: first.plan_hash_after,
			plan_hash_after: first.plan_hash_after,
			schema_version: first.schema_version,
		});

		expect(() =>
			appendSqliteLedger(directory, {
				canonicalEvent: second,
				expectedSeq: 1,
				state: { authorityMode: 'invalid' as never },
			}),
		).toThrow(/Invalid plan-ledger authority mode/);
		expect(readSqliteLedgerEvents(directory).events).toHaveLength(1);
		expect(getPlanLedgerState(directory)?.lastSeq).toBe(1);
	});

	test('serializes concurrent expectedSeq writers and rejects only the stale writer', async () => {
		// Before the project lock/CAS path, two writers could both observe and reuse one expected sequence.
		const { directory, plan } = await createLedgerFixture();
		await promoteToSqliteAuthority(directory);
		const results = await Promise.allSettled([
			appendExportEvent(directory, plan, 'concurrent-writer-a', {
				expectedSeq: 1,
			}),
			appendExportEvent(directory, plan, 'concurrent-writer-b', {
				expectedSeq: 1,
			}),
		]);
		const fulfilled = results.filter((result) => result.status === 'fulfilled');
		const rejected = results.filter((result) => result.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		if (rejected[0]?.status === 'rejected') {
			expect(rejected[0].reason).toBeInstanceOf(LedgerStaleWriterError);
		}
		expect(
			(await readLedgerEvents(directory)).map((event) => event.seq),
		).toEqual([1, 2]);
	});

	test('reset clears SQLite rows and JSONL so a later read cannot resurrect the ledger', async () => {
		// Before reset cleared both authorities, a later read could re-import the deleted JSONL history.
		const { directory, plan } = await createLedgerFixture();
		await appendExportEvent(directory, plan, 'before-reset');
		expect(await readLedgerEvents(directory)).toHaveLength(2);

		await clearPlanLedgerForReset(directory);
		expect(fs.existsSync(ledgerPath(directory))).toBe(false);
		expect(hasSqliteLedger(directory)).toBe(false);
		expect(getPlanLedgerState(directory)).toBeNull();
		expect(await readLedgerEvents(directory)).toEqual([]);
		expect(fs.existsSync(ledgerPath(directory))).toBe(false);
	});
});
