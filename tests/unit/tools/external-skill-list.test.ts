/**
 * Tests for external-skill-list tool.
 *
 * Uses _internals DI seam for config injection — no mock.module leakage.
 * Uses real temp directories for store I/O via createExternalSkillStore.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_list,
} from '../../../src/tools/external-skill-list.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call the tool's execute function with a directory context.
 *
 * createSwarmTool wraps tool() from @opencode-ai/plugin, which calls
 * execute as (args, ctx). The directory is injected via ctx.directory.
 */
async function callTool(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_list as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Create a temp directory for test store state. */
async function createTempDir(): Promise<string> {
	const tmpBase = os.tmpdir();
	const tmpDir = path.join(
		tmpBase,
		`ext-skill-list-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await fs.mkdir(tmpDir, { recursive: true });
	return tmpDir;
}

/** Remove a temp directory recursively. */
async function removeTempDir(tmpDir: string): Promise<void> {
	try {
		await fs.rm(tmpDir, { force: true, recursive: true });
	} catch {
		// Best-effort cleanup
	}
}

/** Create a .opencode/opencode-swarm.json config file with external_skills enabled. */
async function writeTestConfig(
	directory: string,
	overrides?: Record<string, unknown>,
): Promise<void> {
	const configDir = path.join(directory, '.opencode');
	await fs.mkdir(configDir, { recursive: true });

	const defaultConfig = {
		external_skills: {
			curation_enabled: true,
			max_candidates: 500,
			max_bytes_per_candidate: 1048576,
			eviction_policy: 'fifo',
			ttl_days: 90,
			evaluation_enabled: true,
			sources: [],
			max_candidates_per_discovery: 50,
			max_concurrent_fetches: 5,
			fetch_timeout_ms: 30000,
			...(overrides ?? {}),
		},
	};

	await fs.writeFile(
		path.join(configDir, 'opencode-swarm.json'),
		JSON.stringify(defaultConfig, null, 2),
		'utf-8',
	);
}

/** Seed the store with a candidate using the store directly. */
async function seedCandidate(
	directory: string,
	overrides: {
		id?: string;
		source_url?: string;
		source_type?: string;
		publisher?: string;
		skill_name?: string;
		evaluation_verdict?: string;
		fetched_at?: string;
		risk_flags?: string[];
		skill_body?: string;
	},
): Promise<void> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	const candidate = {
		source_url: overrides.source_url ?? 'https://example.com/skill.md',
		source_type: (overrides.source_type ?? 'github') as 'github',
		publisher: overrides.publisher ?? 'test-publisher',
		sha256: 'a'.repeat(64),
		fetched_at: overrides.fetched_at ?? '2026-01-15T12:00:00.000Z',
		skill_name: overrides.skill_name,
		skill_body: overrides.skill_body ?? 'Skill body content.',
		risk_flags: overrides.risk_flags ?? [],
		evaluation_verdict: (overrides.evaluation_verdict ??
			'pending') as 'pending',
		evaluation_history: [],
	};
	await store.add(candidate);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('external_skill_list', () => {
	let tmpDir: string;

	// Save originals for restore
	let originalLoadConfig: typeof _internals.loadConfig;

	beforeEach(async () => {
		tmpDir = await createTempDir();
		originalLoadConfig = _internals.loadConfig;
	});

	afterEach(async () => {
		_internals.loadConfig = originalLoadConfig;
		await removeTempDir(tmpDir);
	});

	// -------------------------------------------------------------------------
	// Test 1: Returns disabled message when curation_enabled=false
	// -------------------------------------------------------------------------
	test('returns disabled message when curation_enabled is false', async () => {
		await writeTestConfig(tmpDir, { curation_enabled: false });

		const result = await callTool({}, tmpDir);

		expect(result).toBe(
			'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.',
		);
	});

	// -------------------------------------------------------------------------
	// Test 2: Lists all candidates when no filters provided
	// -------------------------------------------------------------------------
	test('lists all candidates when no filters provided', async () => {
		await writeTestConfig(tmpDir);

		// Seed three candidates with different verdicts
		await seedCandidate(tmpDir, {
			evaluation_verdict: 'pending',
			fetched_at: '2026-01-10T00:00:00.000Z',
		});
		await seedCandidate(tmpDir, {
			evaluation_verdict: 'passed',
			fetched_at: '2026-01-15T00:00:00.000Z',
		});
		await seedCandidate(tmpDir, {
			evaluation_verdict: 'quarantined',
			fetched_at: '2026-01-20T00:00:00.000Z',
		});

		const result = JSON.parse(await callTool({}, tmpDir));

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(3);
	});

	// -------------------------------------------------------------------------
	// Test 3: Filters by evaluation verdict
	// -------------------------------------------------------------------------
	test('filters by evaluation verdict', async () => {
		await writeTestConfig(tmpDir);

		await seedCandidate(tmpDir, { evaluation_verdict: 'pending' });
		await seedCandidate(tmpDir, { evaluation_verdict: 'passed' });
		await seedCandidate(tmpDir, { evaluation_verdict: 'quarantined' });
		await seedCandidate(tmpDir, { evaluation_verdict: 'pending' });

		const result = JSON.parse(await callTool({ verdict: 'pending' }, tmpDir));

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(2);
		for (const entry of result) {
			expect(entry.evaluation_verdict).toBe('pending');
		}
	});

	// -------------------------------------------------------------------------
	// Test 4: Filters by source_type
	// -------------------------------------------------------------------------
	test('filters by source_type', async () => {
		await writeTestConfig(tmpDir);

		await seedCandidate(tmpDir, { source_type: 'github' });
		await seedCandidate(tmpDir, { source_type: 'url' });
		await seedCandidate(tmpDir, { source_type: 'github' });

		const result = JSON.parse(
			await callTool({ source_type: 'github' }, tmpDir),
		);

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(2);
		for (const entry of result) {
			expect(entry.source_type).toBe('github');
		}
	});

	// -------------------------------------------------------------------------
	// Test 5: Filters by since date
	// -------------------------------------------------------------------------
	test('filters by since date', async () => {
		await writeTestConfig(tmpDir);

		await seedCandidate(tmpDir, { fetched_at: '2026-01-05T00:00:00.000Z' });
		await seedCandidate(tmpDir, { fetched_at: '2026-01-15T00:00:00.000Z' });
		await seedCandidate(tmpDir, { fetched_at: '2026-01-25T00:00:00.000Z' });

		const result = JSON.parse(
			await callTool({ since: '2026-01-10T00:00:00.000Z' }, tmpDir),
		);

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(2);
		for (const entry of result) {
			expect(entry.fetched_at >= '2026-01-10T00:00:00.000Z').toBe(true);
		}
	});

	// -------------------------------------------------------------------------
	// Test 6: Returns empty array when no candidates match
	// -------------------------------------------------------------------------
	test('returns empty array when no candidates match filter', async () => {
		await writeTestConfig(tmpDir);

		await seedCandidate(tmpDir, { evaluation_verdict: 'pending' });
		await seedCandidate(tmpDir, { evaluation_verdict: 'passed' });

		const result = JSON.parse(await callTool({ verdict: 'rejected' }, tmpDir));

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 7: Returns empty array when store is empty
	// -------------------------------------------------------------------------
	test('returns empty array when store is empty', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(await callTool({}, tmpDir));

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 8: Returns correct summary fields for each candidate
	// -------------------------------------------------------------------------
	test('returns correct summary fields for each candidate', async () => {
		await writeTestConfig(tmpDir);

		await seedCandidate(tmpDir, {
			publisher: 'alice',
			skill_name: 'my-skill',
			evaluation_verdict: 'quarantined',
			fetched_at: '2026-02-01T00:00:00.000Z',
			risk_flags: ['prompt_injection', 'unsafe_instructions'],
		});

		const result = JSON.parse(await callTool({}, tmpDir));

		expect(result).toHaveLength(1);
		const entry = result[0];
		expect(entry.id).toBeDefined();
		expect(typeof entry.id).toBe('string');
		expect(entry.source_url).toBe('https://example.com/skill.md');
		expect(entry.source_type).toBe('github');
		expect(entry.publisher).toBe('alice');
		expect(entry.skill_name).toBe('my-skill');
		expect(entry.evaluation_verdict).toBe('quarantined');
		expect(entry.fetched_at).toBe('2026-02-01T00:00:00.000Z');
		expect(entry.risk_flags_count).toBe(2);
		// skill_body should NOT be in the summary
		expect(entry.skill_body).toBeUndefined();
		// evaluation_history should NOT be in the summary
		expect(entry.evaluation_history).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// Test 9: Combined filters (verdict + source_type)
	// -------------------------------------------------------------------------
	test('applies multiple filters simultaneously', async () => {
		await writeTestConfig(tmpDir);

		await seedCandidate(tmpDir, {
			evaluation_verdict: 'pending',
			source_type: 'github',
		});
		await seedCandidate(tmpDir, {
			evaluation_verdict: 'pending',
			source_type: 'url',
		});
		await seedCandidate(tmpDir, {
			evaluation_verdict: 'passed',
			source_type: 'github',
		});

		const result = JSON.parse(
			await callTool({ verdict: 'pending', source_type: 'github' }, tmpDir),
		);

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(1);
		expect(result[0].evaluation_verdict).toBe('pending');
		expect(result[0].source_type).toBe('github');
	});

	// -------------------------------------------------------------------------
	// Test 10: Error when config fails to load
	// -------------------------------------------------------------------------
	test('returns error when config fails to load', async () => {
		// Do NOT write a config file — the tool will try to load from tmpDir
		// which has no .opencode directory, but loadPluginConfig should still
		// return defaults (no crash). To force a load failure, override internals.
		_internals.loadConfig = () => {
			throw new Error('Config load failure');
		};

		const result = JSON.parse(await callTool({}, tmpDir));

		expect(result.success).toBe(false);
		expect(result.error).toContain('Failed to load plugin configuration');
	});
});
