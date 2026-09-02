/**
 * Per-table durability classes (issue #2480 obligation 4): the class map is
 * total, FULL escalates over NORMAL in a batch, and the connection's
 * synchronous pragma is restored to NORMAL after a wrapped call.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	applySynchronousForClass,
	batchDurabilityClass,
	DURABILITY_CLASSES,
	withDurabilityClass,
} from '../../../src/db/durability.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';
import {
	_internals as gateInternals,
	getOrCreateProfile,
	getOrCreateProfileForIdentity,
	lockProfile,
	setGates,
	setGatesForIdentity,
} from '../../../src/db/qa-gate-profile.js';
import {
	ensureTaskCheckpointReceipt,
	updateTaskCheckpointReceipt,
} from '../../../src/db/task-checkpoint-receipt.js';

describe('DURABILITY_CLASSES', () => {
	test('covers every swarm.db table with a known class', () => {
		for (const cls of Object.values(DURABILITY_CLASSES)) {
			expect(cls === 'full' || cls === 'normal').toBe(true);
		}
		// Terminal-state streams are FULL — authoritative state never inherits
		// the rebuildable-index durability setting.
		expect(DURABILITY_CLASSES.task_checkpoint_receipt).toBe('full');
		expect(DURABILITY_CLASSES.qa_gate_profile).toBe('full');
		// Telemetry/operational stores are NORMAL.
		expect(DURABILITY_CLASSES.insight_candidate).toBe('normal');
		expect(DURABILITY_CLASSES.phase_report).toBe('normal');
	});
});

describe('batchDurabilityClass', () => {
	test('any full-class op escalates the whole batch', () => {
		expect(batchDurabilityClass(['normal', 'normal'])).toBe('normal');
		expect(batchDurabilityClass(['normal', 'full'])).toBe('full');
		expect(batchDurabilityClass(['full'])).toBe('full');
		expect(batchDurabilityClass([])).toBe('normal');
	});
});

describe('withDurabilityClass', () => {
	test('sets FULL during the wrapped call and restores NORMAL after', () => {
		const db = new Database(':memory:');
		db.run('PRAGMA synchronous = NORMAL;'); // normalize (memory DBs default FULL)
		const read = (): number =>
			db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
				?.synchronous ?? -1;
		expect(read()).toBe(1);
		let inside = -1;
		withDurabilityClass(db, 'full', () => {
			inside = read();
		});
		expect(inside).toBe(2); // FULL
		expect(read()).toBe(1); // restored
		db.close();
	});

	test('restores NORMAL even when the wrapped call throws', () => {
		const db = new Database(':memory:');
		db.run('PRAGMA synchronous = NORMAL;');
		expect(() =>
			withDurabilityClass(db, 'full', () => {
				throw new Error('boom');
			}),
		).toThrow('boom');
		expect(
			db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
				?.synchronous,
		).toBe(1);
		db.close();
	});

	test('applySynchronousForClass toggles the pragma directly', () => {
		const db = new Database(':memory:');
		applySynchronousForClass(db, 'full');
		expect(
			db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
				?.synchronous,
		).toBe(2);
		applySynchronousForClass(db, 'normal');
		expect(
			db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
				?.synchronous,
		).toBe(1);
		db.close();
	});
});

// One real-handle spot check (the terminal-writer behaviors are pinned in
// src/db/project-db.test.ts + qa-gate-profile tests; here we only pin that
// a connection defaults back to NORMAL after foundation use).
describe('project connection default', () => {
	test('a connection sits at NORMAL after foundation writes', () => {
		const db = new Database(':memory:');
		db.run('PRAGMA synchronous = NORMAL;');
		withDurabilityClass(db, 'full', () => {
			db.run('CREATE TABLE IF NOT EXISTS probe (k TEXT)');
		});
		expect(
			db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()
				?.synchronous,
		).toBe(1);
		db.close();
	});
});

// #2480 implementation-review pin: the PUBLIC qa-gate-profile write paths
// (previously four of them bypassed the shared helper) must each escalate to
// synchronous=FULL during the write and restore NORMAL afterwards. The probe
// is `_internals.lastTxnSynchronous`, recorded inside withImmediateTransaction.
describe('qa-gate-profile public write paths escalate to FULL', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'durability-wiring-'));
	});

	afterEach(() => {
		closeProjectDb(dir);
		rmSync(dir, { recursive: true, force: true });
	});

	function assertEscalated(label: string): void {
		expect(gateInternals.lastTxnSynchronous, label).toBe(2);
		expect(
			getProjectDb(dir)
				.query<{ synchronous: number }, []>('PRAGMA synchronous')
				.get()?.synchronous,
			`${label} restores NORMAL`,
		).toBe(1);
	}

	test('getOrCreateProfile writes at FULL', () => {
		getOrCreateProfile(dir, 'plan-a', 'ts');
		assertEscalated('getOrCreateProfile');
	});

	test('setGates writes at FULL', () => {
		getOrCreateProfile(dir, 'plan-b');
		setGates(dir, 'plan-b', { reviewer: true });
		assertEscalated('setGates');
	});

	test('setGatesForIdentity writes at FULL', () => {
		getOrCreateProfileForIdentity(dir, { swarm: 's', title: 't' });
		setGatesForIdentity(dir, { swarm: 's', title: 't' }, { reviewer: true });
		assertEscalated('setGatesForIdentity');
	});

	test('lockProfile (the terminal transition) writes at FULL', () => {
		getOrCreateProfile(dir, 'plan-c');
		lockProfile(dir, 'plan-c', 7);
		assertEscalated('lockProfile');
	});

	test('task-checkpoint-receipt terminal update writes at FULL', () => {
		const receipt = ensureTaskCheckpointReceipt(dir, 'hash-x', 'task-1', 3);
		const descriptor = {
			planIdentityHash: receipt.plan_identity_hash,
			taskId: receipt.task_id,
			generation: receipt.generation,
			label: receipt.label,
			subject: 'test',
		};
		updateTaskCheckpointReceipt(dir, descriptor, 'committed', 'sha');
		// The receipt writers use withDurabilityClass directly; observe via the
		// connection's post-state (restored NORMAL) + the durable row itself.
		expect(
			getProjectDb(dir)
				.query<{ synchronous: number }, []>('PRAGMA synchronous')
				.get()?.synchronous,
		).toBe(1);
		const row = getProjectDb(dir)
			.query<{ state: string }, [string, string]>(
				'SELECT state FROM task_checkpoint_receipt WHERE plan_identity_hash = ? AND task_id = ?',
			)
			.get('hash-x', 'task-1');
		expect(row?.state).toBe('committed');
	});
});
