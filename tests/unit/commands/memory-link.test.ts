/**
 * #1850: command-level tests for `/swarm memory link` / `/swarm memory unlink`.
 * Covers the unlink-migration guard regression caught by the implementation
 * reviewer, plus status output and opt-in gating.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	handleMemoryLinkCommand,
	handleMemoryUnlinkCommand,
} from '../../../src/commands/memory-link';
import { loadPluginConfig } from '../../../src/config/loader';
import { readMemoryLinkPointer } from '../../../src/memory/memory-link';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 /swarm memory link + unlink commands', () => {
	const dirs: string[] = [];
	let dir: string;

	beforeEach(() => {
		const dataDir = makeTmp('memlink-cmd-data-');
		dirs.push(dataDir);
		process.env.XDG_DATA_HOME = dataDir;
		process.env.HOME = dataDir;
		dir = makeTmp('memlink-cmd-');
		dirs.push(dir);
	});

	afterEach(() => {
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

	test('F-22: link + unlink round-trip does not throw (reviewer critical regression)', async () => {
		// This is the exact scenario the reviewer flagged: unlink was broken
		// by the cohort-only destination guard in migrateMemoryFamily.
		// Enable link in config by writing to .opencode/opencode-swarm.json
		// (the canonical project config path the loader reads from).
		const fs = await import('node:fs/promises');
		await fs.mkdir(path.join(dir, '.opencode'), { recursive: true });
		await fs.writeFile(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ memory: { enabled: true, link: { enabled: true } } }),
			'utf-8',
		);
		// Seed a local memory.db so migration has something to copy.
		const memDir = path.join(dir, '.swarm', 'memory');
		await fs.mkdir(memDir, { recursive: true });
		// Link — should succeed and write the pointer.
		const linkResult = await handleMemoryLinkCommand(dir, ['test-cohort']);
		expect(linkResult).toContain('Linked');
		expect(readMemoryLinkPointer(dir)?.linkId).toBe('test-cohort');
		// Unlink — the critical regression test. Must NOT throw.
		const unlinkResult = await handleMemoryUnlinkCommand(dir, []);
		expect(unlinkResult).toContain('Unlinked');
		expect(readMemoryLinkPointer(dir)).toBeNull();
	});

	test('F-23: unlink when not linked is a no-op with a message', async () => {
		const result = await handleMemoryUnlinkCommand(dir, []);
		expect(result).toContain('not linked');
	});
});
