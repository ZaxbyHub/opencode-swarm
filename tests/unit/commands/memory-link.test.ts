/**
 * #1850: command-level tests for `/swarm memory link` / `/swarm memory unlink`.
 * Covers the unlink-migration guard regression caught by the implementation
 * reviewer, plus status output and opt-in gating.
 *
 * C-TI-001 fix: env vars (XDG_DATA_HOME, HOME) saved in beforeEach and restored
 * in afterEach so tests don't leak platform-dir redirection to siblings.
 * F-22 fix: seed a real memory.db with a record and verify it survives the
 * link→unlink round-trip (previously the test was vacuous — never wrote data).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	handleMemoryLinkCommand,
	handleMemoryUnlinkCommand,
} from '../../../src/commands/memory-link';
import { DEFAULT_MEMORY_CONFIG } from '../../../src/memory/config';
import { readMemoryLinkPointer } from '../../../src/memory/memory-link';
import { clearPool } from '../../../src/memory/provider-pool';
import {
	computeMemoryContentHash,
	createMemoryId,
} from '../../../src/memory/schema';
import { SQLiteMemoryProvider } from '../../../src/memory/sqlite-provider';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 /swarm memory link + unlink commands', () => {
	const dirs: string[] = [];
	let dir: string;
	let prevXdg: string | undefined;
	let prevHome: string | undefined;
	let prevLocalAppData: string | undefined;

	beforeEach(() => {
		prevXdg = process.env.XDG_DATA_HOME;
		prevHome = process.env.HOME;
		prevLocalAppData = process.env.LOCALAPPDATA;
		const dataDir = makeTmp('memlink-cmd-data-');
		dirs.push(dataDir);
		process.env.XDG_DATA_HOME = dataDir;
		process.env.HOME = dataDir;
		process.env.LOCALAPPDATA = dataDir;
		dir = makeTmp('memlink-cmd-');
		dirs.push(dir);
	});

	afterEach(() => {
		process.env.XDG_DATA_HOME = prevXdg;
		process.env.HOME = prevHome;
		process.env.LOCALAPPDATA = prevLocalAppData;
		clearPool();
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('link without memory.link.enabled returns an error message', async () => {
		const result = await handleMemoryLinkCommand(dir, []);
		expect(result).toContain('not enabled');
	});

	test('link status when not linked shows local state', async () => {
		const result = await handleMemoryLinkCommand(dir, ['status']);
		expect(result).toContain('NOT linked');
	});

	test('F-22: link + unlink round-trip preserves seeded data', async () => {
		// Reviewer-flagged regression: unlink was broken by the cohort-only
		// destination guard. This test seeds a real record, links, unlinks,
		// and verifies the record survived the round-trip.
		const fs = await import('node:fs/promises');
		await fs.mkdir(path.join(dir, '.opencode'), { recursive: true });
		await fs.writeFile(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ memory: { enabled: true, link: { enabled: true } } }),
			'utf-8',
		);
		// Seed a local memory.db with a real record via the SQLite provider.
		const config = { ...DEFAULT_MEMORY_CONFIG, enabled: true };
		const seedProvider = new SQLiteMemoryProvider(dir, config);
		await seedProvider.initialize();
		const recordBase = {
			scope: {
				type: 'repository' as const,
				repoId: 'f22-test-repo',
				repoRoot: dir,
			},
			kind: 'project_fact' as const,
			text: 'F-22 seed record for link/unlink round-trip',
		};
		const record = {
			...recordBase,
			id: createMemoryId(recordBase),
			tags: ['test'],
			confidence: 0.8,
			stability: 'durable' as const,
			source: { type: 'manual' as const, ref: 'f22-test' },
			createdAt: '2026-07-18T00:00:00.000Z',
			updatedAt: '2026-07-18T00:00:00.000Z',
			contentHash: computeMemoryContentHash(recordBase),
			metadata: {},
		};
		const seededId = record.id;
		await seedProvider.upsert(record);
		seedProvider.close();
		clearPool();

		// Link — should migrate the local memory.db into the cohort store.
		const linkResult = await handleMemoryLinkCommand(dir, ['test-cohort']);
		expect(linkResult).toContain('Linked');
		expect(readMemoryLinkPointer(dir)?.linkId).toBe('test-cohort');
		clearPool();

		// Delete the LOCAL memory.db so the verify step can ONLY succeed if the
		// unlink copy-back actually restored the data from the cohort store.
		// Without this, the test is vacuous — the source DB is never deleted by
		// migration, so the record would survive even if migration was a no-op.
		const localDbPath = path.join(dir, '.swarm', 'memory', 'memory.db');
		const fs2 = await import('node:fs/promises');
		await fs2.unlink(localDbPath);
		// Also remove WAL/SHM sidecars if present.
		for (const suffix of ['-wal', '-shm']) {
			await fs2.unlink(`${localDbPath}${suffix}`).catch(() => {});
		}

		// Unlink — must copy the cohort family back to local.
		const unlinkResult = await handleMemoryUnlinkCommand(dir, []);
		expect(unlinkResult).toContain('Unlinked');
		expect(readMemoryLinkPointer(dir)).toBeNull();
		clearPool();

		// Verify the seeded record survived the round-trip. This can only pass
		// if link migrated local→cohort AND unlink copied cohort→local.
		const verifyProvider = new SQLiteMemoryProvider(dir, config);
		await verifyProvider.initialize();
		const recalled = await verifyProvider.get(seededId);
		verifyProvider.close();
		clearPool();
		expect(recalled).not.toBeNull();
		expect(recalled?.text).toBe('F-22 seed record for link/unlink round-trip');
	});

	test('F-23: unlink when not linked is a no-op with a message', async () => {
		const result = await handleMemoryUnlinkCommand(dir, []);
		expect(result).toContain('not linked');
	});

	test('F-26b: unlink with --no-copy does not claim restoration', async () => {
		const fs = await import('node:fs/promises');
		await fs.mkdir(path.join(dir, '.opencode'), { recursive: true });
		await fs.writeFile(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ memory: { enabled: true, link: { enabled: true } } }),
			'utf-8',
		);
		await handleMemoryLinkCommand(dir, ['nocopy-cohort']);
		clearPool();
		const result = await handleMemoryUnlinkCommand(dir, ['--no-copy']);
		expect(result).toContain('Unlinked');
		expect(result).toContain('No local copy was made');
	});
});
