/**
 * Driver-parity contract (issue #2480 obligation 2). Runs the shared contract
 * suite against the real bun:sqlite driver under `bun test`; probes for a real
 * node:sqlite driver in the current runtime (absent under Bun 1.3.x — the
 * merge-queue smoke job `scripts/repro-1873.mjs` covers the real Node leg on
 * three OSes). Also asserts the sqlite-loader node-floor probe.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDriverParityContract } from '../../../src/db/driver-parity.js';
import {
	loadDatabaseCtor,
	_internals as loaderInternals,
} from '../../../src/db/sqlite-loader.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('runDriverParityContract', () => {
	test('passes against the real bun:sqlite driver', () => {
		const db = new Database(':memory:');
		expect(() => runDriverParityContract(db)).not.toThrow();
		db.close();
	});

	test('runs against the real node:sqlite driver when present', async () => {
		let NodeDatabaseSync: unknown;
		try {
			const mod = (await import('node:sqlite')) as {
				DatabaseSync: unknown;
			};
			NodeDatabaseSync = mod.DatabaseSync;
		} catch {
			NodeDatabaseSync = undefined;
		}
		if (NodeDatabaseSync === undefined) {
			// Bun 1.3.x does not implement node:sqlite; the real-Node leg runs in
			// the merge-queue smoke job (repro-1873). This skip is expected here.
			return;
		}
		const tmp = canonicalMkdtemp('parity-node-');
		try {
			const db = loadDatabaseCtor()(path.join(tmp, 'parity.db'));
			expect(() =>
				runDriverParityContract(db, { isNodeAdapter: true }),
			).not.toThrow();
			db.close();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('node floor probe (#2480)', () => {
	test('a fake node:sqlite under an old Node version string produces the floor diagnostic', () => {
		const realVersions = process.versions.node;
		const realRequire = loaderInternals.requireModule;
		const savedBun = process.versions.bun;
		try {
			// Simulate a Node runtime below the floor.
			(process.versions as { node?: string }).node = '20.5.0';
			(process.versions as { bun?: string }).bun =
				undefined as unknown as string;
			loaderInternals.requireModule = (id: string) => {
				if (id === 'bun:sqlite') throw new Error('not bun');
				return { DatabaseSync: class {} };
			};
			loaderInternals.reset();
			let message = '';
			try {
				loadDatabaseCtor();
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).toContain('>= 22.13');
			expect(message).toContain('20.5.0');
		} finally {
			(process.versions as { node?: string }).node = realVersions;
			(process.versions as { bun?: string }).bun = savedBun;
			loaderInternals.requireModule = realRequire;
			loaderInternals.reset();
		}
	});
});
