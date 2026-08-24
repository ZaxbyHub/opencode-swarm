import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader';
import {
	DEFAULT_MEMORY_CONFIG,
	type MemoryEventRow,
	memoryEventRowHash,
	resolveSqliteDatabasePath,
	SQLiteMemoryProvider,
	verifyMemoryEventChainRows,
} from '../../../src/memory';
import { evictAndClose } from '../../../src/memory/provider-pool';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-memory-audit-');
});

afterEach(async () => {
	evictAndClose(tmpDir);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function sqliteConfig() {
	return {
		...DEFAULT_MEMORY_CONFIG,
		enabled: true,
		provider: 'sqlite' as const,
	};
}

function openRaw() {
	const dbPath = resolveSqliteDatabasePath(tmpDir, sqliteConfig());
	return new (loadDatabaseCtor())(dbPath);
}

/** Insert records through the provider so events accumulate per write. */
async function seedRecords(provider: SQLiteMemoryProvider, count: number) {
	for (let i = 0; i < count; i++) {
		const record = {
			id: `mem_${String(i).padStart(16, '0')}`,
			scope: { type: 'workspace', workspaceId: 'w' },
			kind: 'code_pattern',
			text: `audit chain probe record ${i}`,
			tags: [],
			confidence: 0.5,
			stability: 'ephemeral' as const,
			source: { type: 'manual' as const },
			createdAt: '2026-08-22T00:00:00.000Z',
			updatedAt: '2026-08-22T00:00:00.000Z',
			contentHash: '0'.repeat(64),
			metadata: {},
		};
		// Bypass full validation (hash/id) — we only need event rows; use the
		// event append path directly through recordEvent + a curated upsert of
		// a valid record is heavier than needed. recordEvent is enough.
		await provider.recordEvent('pii_rejected', record.id, 'probe event');
	}
}

describe('memory_events hash chain (#1466 migration v13)', () => {
	test('fresh database initializes with an intact chain and matching head', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await provider.initialize();
			await seedRecords(provider, 3);
			const report = await provider.verifyAuditChain();
			expect(report.supported).toBe(true);
			expect(report.verified).toBe(true);
			expect(report.legacyRows).toBe(0);
			expect(report.chainedRows).toBe(report.totalRows);
			expect(report.totalRows).toBeGreaterThanOrEqual(3);
			expect(report.headMatch).toBe(true);
		} finally {
			provider.close?.();
		}
	});

	test('tampering a middle row content breaks verification at the next row', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await provider.initialize();
			await seedRecords(provider, 3);
			const db = openRaw();
			db.run(
				"UPDATE memory_events SET reason = 'tampered' WHERE rowid = (SELECT MIN(rowid) + 1 FROM memory_events)",
			);
			db.close();
			const report = await provider.verifyAuditChain();
			expect(report.verified).toBe(false);
			expect(report.divergence).toBeDefined();
			expect(report.divergence?.detail).toContain('prev_hash mismatch');
		} finally {
			provider.close?.();
		}
	});

	test('deleting a middle row breaks verification', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await provider.initialize();
			await seedRecords(provider, 3);
			const db = openRaw();
			db.run(
				'DELETE FROM memory_events WHERE rowid = (SELECT MIN(rowid) + 1 FROM memory_events)',
			);
			db.close();
			const report = await provider.verifyAuditChain();
			expect(report.verified).toBe(false);
		} finally {
			provider.close?.();
		}
	});

	test('tampering the LAST row is caught by the _meta chain head', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await provider.initialize();
			await seedRecords(provider, 3);
			const db = openRaw();
			db.run(
				"UPDATE memory_events SET reason = 'tampered tail' WHERE rowid = (SELECT MAX(rowid) FROM memory_events)",
			);
			db.close();
			const report = await provider.verifyAuditChain();
			// Links still hold (nothing chains off the tampered tail), but the
			// recorded head no longer matches the recomputed last-row hash.
			expect(report.headMatch).toBe(false);
			expect(report.verified).toBe(false);
		} finally {
			provider.close?.();
		}
	});

	test('appending a rogue row outside the provider breaks verification', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await provider.initialize();
			await seedRecords(provider, 2);
			const db = openRaw();
			db.run(
				`INSERT INTO memory_events (id, operation, target_id, reason, timestamp, event_json, prev_hash)
				VALUES ('rogue', 'upsert', 'x', 'rogue', '2026-08-22T00:00:00.000Z', NULL, 'GENESIS')`,
			);
			db.close();
			const report = await provider.verifyAuditChain();
			expect(report.verified).toBe(false);
			expect(report.divergence).toBeDefined();
		} finally {
			provider.close?.();
		}
	});

	test('chain backfill is idempotent across re-initialization', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		await provider.initialize();
		await seedRecords(provider, 2);
		provider.close?.();

		const second = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await second.initialize();
			const report = await second.verifyAuditChain();
			expect(report.verified).toBe(true);
		} finally {
			second.close?.();
		}
	});

	test('two live providers on one database never fork the chain (FB-2 repro, PR #2310 feedback)', async () => {
		// Exact corruption repro from the PR review: A writes, B writes, A
		// writes again. The old in-process tail cache made A's third insert
		// chain off A's stale second-write head, permanently forking the
		// chain. The tail is now read from _meta INSIDE the insert
		// transaction, so interleaved writers always chain off the true tail.
		const providerA = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		const providerB = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await providerA.initialize();
			await providerB.initialize();
			await providerA.recordEvent('pii_rejected', 'mem_a1', 'A first');
			await providerB.recordEvent('pii_rejected', 'mem_b1', 'B first');
			await providerA.recordEvent('pii_rejected', 'mem_a2', 'A second');
			await providerB.recordEvent('pii_rejected', 'mem_b2', 'B second');
			const reportA = await providerA.verifyAuditChain();
			const reportB = await providerB.verifyAuditChain();
			expect(reportA.verified).toBe(true);
			expect(reportB.verified).toBe(true);
			expect(reportA.divergence).toBeUndefined();
			// Cross-instance continuation (PRR-022): every chained row links.
			expect(reportA.chainedRows).toBe(reportA.totalRows);
		} finally {
			providerA.close?.();
			providerB.close?.();
		}
	});
});

describe('verifyMemoryEventChainRows (pure)', () => {
	function row(partial: Partial<MemoryEventRow>): MemoryEventRow {
		return {
			id: partial.id ?? 'e1',
			operation: partial.operation ?? 'upsert',
			target_id: partial.target_id ?? 't',
			reason: partial.reason ?? null,
			timestamp: partial.timestamp ?? '2026-08-22T00:00:00.000Z',
			event_json: partial.event_json ?? null,
			prev_hash: partial.prev_hash ?? null,
		};
	}

	test('a pre-v13 NULL prefix is reported as legacy, not a break', () => {
		const legacy = row({ id: 'legacy', prev_hash: null });
		const report = verifyMemoryEventChainRows([legacy], null);
		expect(report.legacyRows).toBe(1);
		expect(report.chainedRows).toBe(0);
		expect(report.verified).toBe(true);
	});

	test('legacy-only rows with a stored head FAIL CLOSED (reviewer item: pinned boundary)', () => {
		// No chained rows exist, yet _meta carries a head — rows were chained
		// once and then replaced by unchained ones, or the head was tampered.
		// Conservative-correct: unverified, not silently accepted.
		const legacy = row({ id: 'legacy', prev_hash: null });
		const report = verifyMemoryEventChainRows([legacy], 'some-head');
		expect(report.legacyRows).toBe(1);
		expect(report.chainedRows).toBe(0);
		expect(report.headMatch).toBe(false);
		expect(report.verified).toBe(false);
	});

	test('first chained row must anchor at GENESIS', () => {
		const bad = row({ id: 'bad', prev_hash: 'deadbeef' });
		const report = verifyMemoryEventChainRows([bad], null);
		expect(report.verified).toBe(false);
		expect(report.divergence?.detail).toContain('chain anchor mismatch');
	});

	// PRR-019: the legacy-prefix → chained transition boundary (the counting
	// and anchor logic that pure-legacy / pure-chained tests miss).
	test('mixed legacy prefix then GENESIS-anchored chain verifies with correct counts (PRR-019)', () => {
		const legacyA = row({ id: 'legacy-a', prev_hash: null });
		const legacyB = row({ id: 'legacy-b', prev_hash: null });
		const first = memoryEventRowHash({
			...row({ id: 'first' }),
			prev_hash: 'GENESIS',
		});
		const anchor = row({ id: 'first', prev_hash: 'GENESIS' });
		const chained = row({ id: 'second', prev_hash: first });
		const head = memoryEventRowHash(chained);
		const report = verifyMemoryEventChainRows(
			[legacyA, legacyB, anchor, chained],
			head,
		);
		expect(report.legacyRows).toBe(2);
		expect(report.chainedRows).toBe(2);
		expect(report.verified).toBe(true);
		expect(report.headMatch).toBe(true);
	});

	test('mixed rows with a non-GENESIS first anchor still diverge (PRR-019 negative)', () => {
		const legacy = row({ id: 'legacy', prev_hash: null });
		const badAnchor = row({ id: 'first', prev_hash: 'not-genesis' });
		const report = verifyMemoryEventChainRows([legacy, badAnchor], null);
		expect(report.verified).toBe(false);
		expect(report.divergence?.detail).toContain('chain anchor mismatch');
	});

	test('empty table with no stored head verifies', () => {
		const report = verifyMemoryEventChainRows([], null);
		expect(report.verified).toBe(true);
		expect(report.headMatch).toBe(true);
	});
});
