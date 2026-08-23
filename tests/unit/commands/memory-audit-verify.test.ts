import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader';
import { handleMemoryAuditVerifyCommand } from '../../../src/commands/memory';
import {
	DEFAULT_MEMORY_CONFIG,
	resolveSqliteDatabasePath,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { evictAndClose } from '../../../src/memory/provider-pool';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-audit-cmd-')),
	);
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

describe('/swarm memory audit-verify (#1466)', () => {
	test('intact chain reports verified on a sqlite provider', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		await provider.initialize();
		await provider.recordEvent('pii_rejected', 'mem_x', 'probe');
		provider.close?.();

		const out = await handleMemoryAuditVerifyCommand(tmpDir, []);
		expect(out).toContain('## Swarm Memory Audit Verification');
		expect(out).toContain('- Verified: `true`');
		expect(out).toContain('intact');
	});

	test('tampered chain reports the divergence', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		await provider.initialize();
		await provider.recordEvent('pii_rejected', 'mem_x', 'probe a');
		await provider.recordEvent('pii_rejected', 'mem_y', 'probe b');
		provider.close?.();

		const dbPath = resolveSqliteDatabasePath(tmpDir, sqliteConfig());
		const db = new (loadDatabaseCtor())(dbPath);
		db.run(
			"UPDATE memory_events SET reason = 'tampered' WHERE rowid = (SELECT MIN(rowid) FROM memory_events)",
		);
		db.close();

		const out = await handleMemoryAuditVerifyCommand(tmpDir, []);
		expect(out).toContain('- Verified: `false`');
		expect(out).toContain('divergence');
	});

	test('--json emits a machine-readable report', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		await provider.initialize();
		provider.close?.();
		const out = await handleMemoryAuditVerifyCommand(tmpDir, ['--json']);
		const parsed = JSON.parse(out);
		expect(parsed.supported).toBe(true);
		expect(parsed.verified).toBe(true);
	});

	test('non-sqlite provider reports the capability gap instead of pretending', async () => {
		// Write a config that selects local-jsonl.
		const configDir = path.join(tmpDir, '.opencode');
		await fs.mkdir(configDir, { recursive: true });
		await fs.writeFile(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify({ memory: { provider: 'local-jsonl' } }),
		);
		const out = await handleMemoryAuditVerifyCommand(tmpDir, []);
		expect(out).toContain('local-jsonl');
		expect(out).toContain('has no memory_events log');
	});

	test('unknown arguments return usage guidance', async () => {
		const out = await handleMemoryAuditVerifyCommand(tmpDir, ['--bogus']);
		expect(out).toContain('Usage: /swarm memory audit-verify');
	});
});
