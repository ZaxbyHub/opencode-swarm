/**
 * Tests for ledger integrity functions: readLedgerEventsWithIntegrity and
 * quarantineLedgerSuffix.
 *
 * NOTE: the former `replayWithIntegrity` function was folded into
 * `replayFromLedgerWithStatus` (M1 fix) and deleted; its integrity/quarantine
 * value is now exercised via that path and the M1 truncation regression tests
 * (ledger-m1-truncation.test.ts). Only the reader/quarantine unit tests remain
 * here.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type LedgerEvent,
	quarantineLedgerSuffix,
	readLedgerEventsWithIntegrity,
} from '../../src/plan/ledger';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';

describe('readLedgerEventsWithIntegrity', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-integrity-'));
		// Create .swarm directory
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		// Clean up temp directory
		fs.rmSync(testDir, { force: true, recursive: true });
	});

	test('1. Clean ledger returns all events with truncated=false, badSuffix=null', async () => {
		const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
		const validEvent: LedgerEvent = {
			seq: 1,
			timestamp: new Date().toISOString(),
			plan_id: 'test-plan-1',
			event_type: 'plan_created',
			source: 'test',
			plan_hash_before: '',
			plan_hash_after: 'abc123',
			schema_version: '1.0.0',
		};
		const event2: LedgerEvent = {
			seq: 2,
			timestamp: new Date().toISOString(),
			plan_id: 'test-plan-1',
			event_type: 'task_added',
			task_id: '1.1',
			source: 'test',
			plan_hash_before: 'abc123',
			plan_hash_after: 'def456',
			schema_version: '1.0.0',
		};

		fs.writeFileSync(
			ledgerPath,
			`${JSON.stringify(validEvent)}\n${JSON.stringify(event2)}\n`,
			'utf8',
		);

		const result = await readLedgerEventsWithIntegrity(testDir);

		expect(result.truncated).toBe(false);
		expect(result.badSuffix).toBeNull();
		expect(result.events).toHaveLength(2);
		expect(result.events[0].seq).toBe(1);
		expect(result.events[1].seq).toBe(2);
	});

	test('2. Ledger with bad line mid-file stops at bad line, truncated=true', async () => {
		const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
		const validEvent: LedgerEvent = {
			seq: 1,
			timestamp: new Date().toISOString(),
			plan_id: 'test-plan-1',
			event_type: 'plan_created',
			source: 'test',
			plan_hash_before: '',
			plan_hash_after: 'abc123',
			schema_version: '1.0.0',
		};
		const event2: LedgerEvent = {
			seq: 2,
			timestamp: new Date().toISOString(),
			plan_id: 'test-plan-1',
			event_type: 'task_added',
			task_id: '1.1',
			source: 'test',
			plan_hash_before: 'abc123',
			plan_hash_after: 'def456',
			schema_version: '1.0.0',
		};
		const badLine = '{ invalid json }';
		const event4Line = JSON.stringify({
			seq: 4,
			timestamp: new Date().toISOString(),
			plan_id: 'test-plan-1',
			event_type: 'task_added',
			task_id: '1.2',
			source: 'test',
			plan_hash_before: 'def456',
			plan_hash_after: 'ghi789',
			schema_version: '1.0.0',
		});

		fs.writeFileSync(
			ledgerPath,
			JSON.stringify(validEvent) +
				'\n' +
				JSON.stringify(event2) +
				'\n' +
				badLine +
				'\n' +
				event4Line +
				'\n',
			'utf8',
		);

		const result = await readLedgerEventsWithIntegrity(testDir);

		expect(result.truncated).toBe(true);
		expect(result.badSuffix).not.toBeNull();
		expect(result.events).toHaveLength(2);
		expect(result.events[0].seq).toBe(1);
		expect(result.events[1].seq).toBe(2);
		// badSuffix should contain the bad line and everything after
		expect(result.badSuffix).toContain(badLine);
		expect(result.badSuffix).toContain('"seq":4');
	});

	test('3. Ledger with bad line at end — truncated=true, badSuffix is just the bad line', async () => {
		const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
		const validEvent: LedgerEvent = {
			seq: 1,
			timestamp: new Date().toISOString(),
			plan_id: 'test-plan-1',
			event_type: 'plan_created',
			source: 'test',
			plan_hash_before: '',
			plan_hash_after: 'abc123',
			schema_version: '1.0.0',
		};
		const badLine = '{ broken }';

		fs.writeFileSync(
			ledgerPath,
			`${JSON.stringify(validEvent)}\n${badLine}\n`,
			'utf8',
		);

		const result = await readLedgerEventsWithIntegrity(testDir);

		expect(result.truncated).toBe(true);
		// badSuffix includes trailing newline from split
		expect(result.badSuffix).toBe(`${badLine}\n`);
		expect(result.events).toHaveLength(1);
		expect(result.events[0].seq).toBe(1);
	});

	test('4. Empty ledger returns empty events, truncated=false', async () => {
		const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
		// Create empty ledger file
		fs.writeFileSync(ledgerPath, '', 'utf8');

		const result = await readLedgerEventsWithIntegrity(testDir);

		expect(result.truncated).toBe(false);
		expect(result.badSuffix).toBeNull();
		expect(result.events).toHaveLength(0);
	});

	test('5. Non-existent ledger returns empty events, truncated=false', async () => {
		const result = await readLedgerEventsWithIntegrity(testDir);

		expect(result.truncated).toBe(false);
		expect(result.badSuffix).toBeNull();
		expect(result.events).toHaveLength(0);
	});
});

describe('quarantineLedgerSuffix', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-integrity-'));
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(testDir, { force: true, recursive: true });
	});

	test('6. quarantineLedgerSuffix writes correct file content to a unique path', async () => {
		const badContent = '{ broken: "json" }\nsecond line\nthird line';

		const result = await quarantineLedgerSuffix(testDir, badContent);

		// Unique-path contract: filename is prefixed plan-ledger.quarantine.* and
		// the write reports the path it landed at.
		expect(result.path).not.toBeNull();
		expect(path.basename(result.path!)).toMatch(/^plan-ledger\.quarantine\./);
		expect(fs.existsSync(result.path!)).toBe(true);

		const content = fs.readFileSync(result.path!, 'utf8');
		expect(content).toBe(badContent);
	});

	test('quarantineLedgerSuffix does NOT overwrite a prior quarantine (distinct suffixes → distinct files)', async () => {
		const first = await quarantineLedgerSuffix(
			testDir,
			'{ first: "corruption" }',
		);
		const second = await quarantineLedgerSuffix(
			testDir,
			'{ second: "corruption" }',
		);

		// Two different corruptions must land in two different files — the second
		// must not clobber the first.
		expect(first.path).not.toBeNull();
		expect(second.path).not.toBeNull();
		expect(second.path).not.toBe(first.path);
		expect(fs.readFileSync(first.path!, 'utf8')).toBe(
			'{ first: "corruption" }',
		);
		expect(fs.readFileSync(second.path!, 'utf8')).toBe(
			'{ second: "corruption" }',
		);

		// Both quarantine files coexist on disk.
		const quarantineFiles = fs
			.readdirSync(path.join(testDir, '.swarm'))
			.filter((f) => f.startsWith('plan-ledger.quarantine.'));
		expect(quarantineFiles.length).toBe(2);
	});

	test('quarantineLedgerSuffix reports the count of salvageable (parseable) lines', async () => {
		// Two valid JSON lines behind a poison line — salvage count must be 2.
		const suffix = `{ not valid json\n${JSON.stringify({ seq: 5, event_type: 'task_added' })}\n${JSON.stringify({ seq: 6, event_type: 'task_added' })}\n`;

		const result = await quarantineLedgerSuffix(testDir, suffix);

		expect(result.salvagedCount).toBe(2);
	});

	test('F-002: identical corruption is deduped — repeated quarantine of the same content reuses one file (no per-restart accumulation)', async () => {
		// The startup ledger check runs once per process, so the SAME corruption
		// is re-quarantined on every process restart while the poison line
		// persists. Without dedup, each call wrote a fresh Date.now()-prefixed
		// file — unbounded accumulation for an unchanged corrupted tail.
		const sameContent = '{ broken: "corruption" }\ntrailing line';

		const first = await quarantineLedgerSuffix(testDir, sameContent);
		const second = await quarantineLedgerSuffix(testDir, sameContent);
		const third = await quarantineLedgerSuffix(testDir, sameContent);

		expect(first.path).not.toBeNull();
		// Repeated identical corruption reuses the first file's path.
		expect(second.path).toBe(first.path);
		expect(third.path).toBe(first.path);

		// Exactly one quarantine file on disk for this corruption.
		const quarantineFiles = fs
			.readdirSync(path.join(testDir, '.swarm'))
			.filter((f) => f.startsWith('plan-ledger.quarantine.'));
		expect(quarantineFiles.length).toBe(1);
		expect(fs.readFileSync(first.path!, 'utf8')).toBe(sameContent);

		// A genuinely different corruption still gets its own file.
		const distinct = await quarantineLedgerSuffix(
			testDir,
			'{ a different corruption }',
		);
		expect(distinct.path).not.toBe(first.path);
		const afterDistinct = fs
			.readdirSync(path.join(testDir, '.swarm'))
			.filter((f) => f.startsWith('plan-ledger.quarantine.'));
		expect(afterDistinct.length).toBe(2);
	});

	test('F-002 falsification: concurrent quarantine of identical content still yields ONE file (no readdir/write race)', async () => {
		// quarantineLedgerSuffix is `async` but contains no `await` — its
		// readdir→byte-compare→write body is fully synchronous, so even
		// Promise.all-dispatched calls run to completion one-at-a-time and the
		// second observes the first's file. This guards against a future refactor
		// that introduces an await between the dedup scan and the write.
		const sameContent = '{ concurrent: "corruption" }\nrace tail';
		const results = await Promise.all([
			quarantineLedgerSuffix(testDir, sameContent),
			quarantineLedgerSuffix(testDir, sameContent),
			quarantineLedgerSuffix(testDir, sameContent),
			quarantineLedgerSuffix(testDir, sameContent),
		]);

		const paths = new Set(results.map((r) => r.path));
		expect(paths.size).toBe(1);
		// salvagedCount is recomputed per call from the same content — stays consistent.
		for (const r of results) expect(r.salvagedCount).toBe(0);

		const quarantineFiles = fs
			.readdirSync(path.join(testDir, '.swarm'))
			.filter((f) => f.startsWith('plan-ledger.quarantine.'));
		expect(quarantineFiles.length).toBe(1);
	});
});

describe('readLedgerEventsWithIntegrity read-error tolerance (blast-radius lock)', () => {
	let testDir: string;
	let restore: (() => void) | null = null;

	beforeEach(() => {
		testDir = canonicalMkdtemp('ledger-integrity-eacces-');
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
		const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
		const event: LedgerEvent = {
			seq: 1,
			timestamp: new Date().toISOString(),
			plan_id: 'test-plan-eacces',
			event_type: 'plan_created',
			source: 'test',
			plan_hash_before: '',
			plan_hash_after: 'abc123',
			schema_version: '1.0.0',
		};
		fs.writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`);

		const realReadFileSync = fs.readFileSync;
		const spy = spyOn(fs, 'readFileSync').mockImplementation(((
			target: unknown,
			...rest: unknown[]
		) => {
			if (typeof target === 'string' && target === ledgerPath) {
				const error = new Error(
					`EACCES: permission denied, open '${ledgerPath}'`,
				) as NodeJS.ErrnoException;
				error.code = 'EACCES';
				throw error;
			}
			return (realReadFileSync as (...args: unknown[]) => unknown)(
				target,
				...rest,
			);
		}) as unknown as typeof fs.readFileSync);
		restore = () => spy.mockRestore();
	});

	afterEach(() => {
		restore?.();
		restore = null;
		fs.rmSync(testDir, { force: true, recursive: true });
	});

	test('without options, an unreadable-but-present ledger stays tolerant', async () => {
		// The 6+ tolerant replayFromLedger callers must keep today's behavior:
		// a transient read failure must not become a hard planning-tool failure.
		const result = await readLedgerEventsWithIntegrity(testDir);

		expect(result).toEqual({ events: [], truncated: false, badSuffix: null });
	});
});
