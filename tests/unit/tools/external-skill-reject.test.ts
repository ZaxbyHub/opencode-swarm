/**
 * Tests for external-skill-reject tool.
 *
 * Uses _internals DI seam for config injection — no mock.module leakage.
 * Uses real temp directories for store I/O via createExternalSkillStore.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalSkillCandidate } from '../../../src/config/schema.js';
import { createExternalSkillStore } from '../../../src/services/external-skill-store.js';
import {
	_internals,
	external_skill_reject,
} from '../../../src/tools/external-skill-reject.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call the tool's execute function with a directory context.
 */
async function callTool(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_reject as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Create a temp directory for test store state. */
async function createTempDir(): Promise<string> {
	const tmpBase = os.tmpdir();
	const tmpDir = path.join(
		tmpBase,
		`ext-skill-reject-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

/** Seed the store with a candidate and return the created record (with its generated ID). */
async function seedCandidate(
	directory: string,
	overrides: {
		evaluation_verdict?: string;
		evaluation_history?: Array<{
			verdict: string;
			timestamp: string;
			actor: string;
			reason?: string;
		}>;
	},
): Promise<ExternalSkillCandidate> {
	const store = createExternalSkillStore(directory, { max_candidates: 500 });
	return store.add({
		source_url: 'https://example.com/skill.md',
		source_type: 'github',
		publisher: 'test-publisher',
		sha256: 'a'.repeat(64),
		fetched_at: '2026-01-15T12:00:00.000Z',
		skill_name: 'test-skill',
		skill_body: 'Skill body content.',
		risk_flags: [],
		evaluation_verdict: (overrides.evaluation_verdict ??
			'pending') as ExternalSkillCandidate['evaluation_verdict'],
		evaluation_history: overrides.evaluation_history ?? [],
	});
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('external_skill_reject', () => {
	let tmpDir: string;

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

		const result = await callTool(
			{ candidate_id: 'some-id', reason: 'bad skill' },
			tmpDir,
		);

		expect(result).toBe(
			'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.',
		);
	});

	// -------------------------------------------------------------------------
	// Test 2: Rejects a candidate successfully and records history
	// -------------------------------------------------------------------------
	test('rejects a candidate and records evaluation_history with actor and reason', async () => {
		await writeTestConfig(tmpDir);

		const candidate = await seedCandidate(tmpDir, {});

		const result = JSON.parse(
			await callTool(
				{
					candidate_id: candidate.id,
					reason: 'Contains prompt injection patterns',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(true);
		expect(result.candidate_id).toBe(candidate.id);
		expect(result.evaluation_verdict).toBe('rejected');

		// Verify the store was updated correctly
		const store = createExternalSkillStore(tmpDir, { max_candidates: 500 });
		const updated = await store.get(candidate.id);
		expect(updated).not.toBeNull();
		expect(updated!.evaluation_verdict).toBe('rejected');

		// evaluation_history should contain two entries:
		//   1. auto-appended by store.update (actor: 'system')
		//   2. our explicit entry (actor: 'user')
		expect(updated!.evaluation_history.length).toBeGreaterThanOrEqual(2);

		// Find our user-actor entry
		const userEntry = updated!.evaluation_history.find(
			(e) => e.actor === 'user',
		);
		expect(userEntry).toBeDefined();
		expect(userEntry!.verdict).toBe('rejected');
		expect(userEntry!.reason).toBe('Contains prompt injection patterns');
		expect(userEntry!.timestamp).toBeDefined();
	});

	// -------------------------------------------------------------------------
	// Test 3: Returns error when candidate not found
	// -------------------------------------------------------------------------
	test('returns error when candidate is not found', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool(
				{
					candidate_id: '00000000-0000-4000-a000-000000000000',
					reason: 'does not matter',
				},
				tmpDir,
			),
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Candidate not found');
	});

	// -------------------------------------------------------------------------
	// Test 4: Returns error when candidate_id is missing
	// -------------------------------------------------------------------------
	test('returns error when candidate_id is missing', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool({ reason: 'some reason' }, tmpDir),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('candidate_id');
	});

	// -------------------------------------------------------------------------
	// Test 5: Returns error when reason is missing
	// -------------------------------------------------------------------------
	test('returns error when reason is missing', async () => {
		await writeTestConfig(tmpDir);

		const result = JSON.parse(
			await callTool({ candidate_id: 'some-id' }, tmpDir),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('reason');
	});

	// -------------------------------------------------------------------------
	// Test 6: Returns error when config fails to load
	// -------------------------------------------------------------------------
	test('returns error when config fails to load', async () => {
		_internals.loadConfig = () => {
			throw new Error('Config load failure');
		};

		const result = JSON.parse(
			await callTool({ candidate_id: 'some-id', reason: 'test' }, tmpDir),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Failed to load plugin configuration');
	});
});
